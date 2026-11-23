// Ways to get a Roblox session into webblox's cookie jar without going through roblox.com's
// login page (whose CAPTCHA and verification steps tend to loop behind a proxy):
//   - Quick sign-in: Roblox's own "Quick Log In". webblox shows a code; you approve it on a device
//     where you are already signed in, and Roblox starts a new session for webblox.
//   - Cookie: paste an existing .ROBLOSECURITY value.
// The session cookie only ever goes to *.roblox.com (RobloxNet refuses other hosts), over TLS
// that ends in this browser.

import { CookieJar, isRobloxCookieDomain } from "./cookiejar.js";
import { authenticatedUser } from "./roblox-api.js";
import { RobloxNet } from "./robloxnet.js";
import { clearScramjetRobloxCookies } from "./scramjet-session.js";

const QUICK = "https://apis.roblox.com/auth-token-service/v1/login";
export const QUICK_CONFIRM_URL = "https://www.roblox.com/crossdevicelogin/confirmcode";

// Errors meant to be shown to the user as they are.
const fail = (message) => Object.assign(new Error(message), { userFacing: true });

const isSessionCookie = (c) => c.name === ".ROBLOSECURITY" && isRobloxCookieDomain(c.domain);

const sessionCookie = (value) => ({
	name: ".ROBLOSECURITY",
	value,
	domain: "roblox.com",
	hostOnly: false,
	path: "/",
	expires: null,
	secure: true,
	httpOnly: true,
	sameSite: "lax",
});

async function markSource(jar, source) {
	jar.meta = { ...(jar.meta || {}), sessionSource: source };
	await jar.saveNow?.();
}

// Accepts the bare value, "ROBLOSECURITY=…", ".ROBLOSECURITY=…; path=/…", quoted, or wrapped.
export function normalizeCookieInput(input) {
	let v = String(input || "").trim();
	v = v.replace(/^\.?ROBLOSECURITY\s*[=:]\s*/i, "");
	v = v.replace(/^["']+|["']+$/g, "");
	const semi = v.indexOf(";");
	if (semi >= 0) v = v.slice(0, semi);
	return v.replace(/\s+/g, "");
}

export async function signInWithCookie(net, input) {
	const value = normalizeCookieInput(input);
	if (value.length < 50 || /[^\x21-\x7e]/.test(value)) throw fail("That doesn't look like a .ROBLOSECURITY cookie value.");
	// Try it on a scratch jar first, so a bad paste never replaces a working session.
	const probe = new CookieJar();
	probe.set(sessionCookie(value));
	const user = await authenticatedUser(new RobloxNet({ client: net.client, jar: probe }));
	if (!user) {
		throw fail(
			value.startsWith("_|WARNING")
				? "Roblox didn't accept that cookie. It may have expired, or that session was signed out."
				: "Roblox didn't accept that cookie. Copy the whole value, including the _|WARNING:…|_ part at the start.",
		);
	}
	net.jar.removeWhere(isSessionCookie);
	net.jar.set(sessionCookie(value));
	await markSource(net.jar, "cookie");
	return user;
}

// Roblox returns expiry times without a zone; they are UTC.
function parseRobloxTime(s) {
	const t = s ? Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`) : NaN;
	return Number.isFinite(t) ? t : Date.now() + 5 * 60 * 1000;
}

export async function startQuickLogin(net) {
	const d = await net.api(`${QUICK}/create`, { method: "POST", body: {} });
	if (!d?.code || !d?.privateKey) throw fail("Roblox didn't return a sign-in code.");
	return {
		code: d.code,
		privateKey: d.privateKey,
		expiresAt: parseRobloxTime(d.expirationTime),
		qrUrl: d.imagePath ? `https://apis.roblox.com/auth-token-service${d.imagePath}` : null,
	};
}

// status: "Created" (waiting for the code), "UserLinked" (code entered, waiting for confirmation),
// "Validated" (confirmed), "Cancelled", or "Expired".
export async function quickLoginStatus(net, q) {
	try {
		const d = await net.api(`${QUICK}/status`, { method: "POST", body: { code: q.code, privateKey: q.privateKey } });
		return { status: d?.status || "Unknown", accountName: d?.accountName || null, accountPictureUrl: d?.accountPictureUrl || null };
	} catch (err) {
		if (err.status === 400 || err.status === 404) return { status: "Expired" };
		throw err;
	}
}

export async function finishQuickLogin(net, q) {
	net.jar.removeWhere(isSessionCookie);
	let d;
	try {
		d = await net.api("https://auth.roblox.com/v2/login", { method: "POST", body: { ctype: "AuthToken", cvalue: q.code, password: q.privateKey } });
	} catch (err) {
		throw fail(
			err.status === 403
				? "Roblox asked for an extra check that webblox can't show. Sign in with a cookie instead."
				: `Roblox refused the sign-in (${err.message}).`,
		);
	}
	if (d?.twoStepVerificationData) {
		throw fail("This account needs a 2-step verification code, which quick sign-in can't ask for here. Sign in with a cookie instead.");
	}
	const user = await authenticatedUser(net);
	if (!user) throw fail("Roblox approved the code but didn't start a session. Try again, or sign in with a cookie.");
	await markSource(net.jar, "quick");
	return user;
}

export function cancelQuickLogin(net, q) {
	return net.api(`${QUICK}/cancel`, { method: "POST", body: { code: q.code, privateKey: q.privateKey } }).catch(() => {});
}

// Sessions webblox started itself are ended at Roblox too. A pasted cookie is shared with the
// browser it was copied from, so it is only forgotten here.
export async function signOut(net) {
	const shared = net.jar.meta?.sessionSource === "cookie";
	if (!shared && net.jar.matching(new URL("https://www.roblox.com/")).some(isSessionCookie)) {
		await net.api("https://auth.roblox.com/v2/logout", { method: "POST", body: {} }).catch(() => {});
	}
	net.jar.removeWhere((c) => isRobloxCookieDomain(c.domain));
	net.jar.meta = { ...(net.jar.meta || {}), sessionSource: null, scramjetSession: null };
	await net.jar.saveNow?.();
	await clearScramjetRobloxCookies().catch(() => {});
	return { shared };
}
