// Ways to get a Roblox session into webblox's cookie jar without going through roblox.com's
// login page (whose CAPTCHA and verification steps tend to loop behind a proxy):
//   - Password: username (or email) and password, sent from this browser to Roblox's login API.
//     2-step verification codes are asked for here; Roblox's proof-of-work check is solved here.
//   - Quick sign-in: Roblox's own "Quick Log In". webblox shows a code; you approve it on a device
//     where you are already signed in, and Roblox starts a new session for webblox.
//   - Cookie: paste an existing .ROBLOSECURITY value.
// Passwords, codes and the session cookie only ever go to *.roblox.com (RobloxNet refuses other
// hosts), over TLS that ends in this browser. Nothing but the session cookie is kept.

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
	const user = await authenticatedUser(new RobloxNet({ client: net.client, jar: probe, timeout: net.timeout }));
	if (!user) {
		throw fail(
			value.startsWith("_|WARNING")
				? "Roblox didn't accept that cookie. If it's fresh and complete, Roblox is most likely rejecting it because webblox connects from the Wisp server's location, not yours — Roblox ties each session to where it's used. Use a Wisp server on your own connection (one you run on your network) and it should work. The cookie may also simply have expired."
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

// ---- username and password ------------------------------------------------------------------

const LOGIN = "https://auth.roblox.com/v2/login";
const CONTINUE = "https://apis.roblox.com/challenge/v1/continue";
const POW = "https://apis.roblox.com/proof-of-work-service/v1/pow-puzzle";
const TSV = "https://twostepverification.roblox.com/v1";

// TwoStepVerificationMediaType, as numbers or names depending on the endpoint.
const MEDIA = ["Email", "SMS", "Authenticator", "RecoveryCode", "SecurityKey", "CrossDevice", "Password", "Passkey"];
const mediaName = (m) => (typeof m === "number" ? MEDIA[m] : m) || "";
// Methods that come down to typing a code, and their verify paths.
const CODE_PATHS = { Authenticator: "authenticator", Email: "email", SMS: "sms", RecoveryCode: "recovery-codes" };
const OTHER_METHODS = { SecurityKey: "a security key", Passkey: "a passkey", CrossDevice: "approval in the Roblox app", Password: "a password" };

export const CAPTCHA_MESSAGE =
	"Roblox wants a CAPTCHA for this sign-in, and its CAPTCHA only works on roblox.com itself. Sign in with a cookie instead, which avoids it. CAPTCHAs are also less likely through a Wisp server on a home connection.";

const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const header = (pairs, name) => (pairs || []).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
const cancelled = () => Object.assign(new Error("Sign-in cancelled."), { cancelled: true });
const captchaNeeded = () => Object.assign(fail(CAPTCHA_MESSAGE), { captcha: true });

/** Roblox's credential type for what was typed: an email, an international phone number, or a username. */
export function credentialType(identifier) {
	const v = String(identifier).trim();
	if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "Email";
	if (/^\+[\d\s().-]{6,}$/.test(v)) return "PhoneNumber";
	return "Username";
}

// Roblox's generic challenge: a 403 whose rblx-challenge-* headers say what to prove before the
// same request is sent again.
export function readChallenge(err) {
	const id = header(err?.headers, "rblx-challenge-id");
	const type = header(err?.headers, "rblx-challenge-type");
	if (!id || !type) return null;
	let metadata = {};
	try {
		const raw = header(err.headers, "rblx-challenge-metadata");
		metadata = raw ? JSON.parse(fromBase64(raw)) : {};
	} catch {
		metadata = {};
	}
	return { id, type, metadata };
}

export const challengeHeaders = (answered) => ({
	"rblx-challenge-id": answered.id,
	"rblx-challenge-type": answered.type,
	"rblx-challenge-metadata": toBase64(JSON.stringify(answered.metadata)),
});

function loginError(err) {
	if (err.userFacing || err.cancelled || !err.status) return err; // network trouble is explained by the caller
	const code = err.data?.errors?.[0]?.code;
	if (err.status === 403 && code === 1) return fail("Incorrect username or password.");
	if (err.status === 403 && code === 2) return captchaNeeded();
	if (err.status === 429 || code === 15) return fail("Too many sign-in attempts. Wait a few minutes, then try again.");
	if (err.status === 403 && code === 4) return fail("Roblox has locked this account. Reset its password on roblox.com.");
	return fail(err.data?.errors?.[0]?.message || `Roblox refused the sign-in (${err.message}).`);
}

// Hands control back to the page between slices of work, without timers' 4 ms clamping.
let yieldChannel = null;
function yieldToPage() {
	if (typeof setImmediate === "function") return new Promise((r) => setImmediate(r));
	if (typeof MessageChannel !== "function") return new Promise((r) => setTimeout(r, 0));
	if (!yieldChannel) {
		yieldChannel = new MessageChannel();
		yieldChannel.waiting = [];
		yieldChannel.port1.onmessage = () => yieldChannel.waiting.shift()?.();
	}
	return new Promise((r) => {
		yieldChannel.waiting.push(r);
		yieldChannel.port2.postMessage(0);
	});
}
const clock = () => globalThis.performance?.now() ?? Date.now();

// A time-lock puzzle: A^(2^T) mod N, by T squarings that cannot be shortcut without N's factors.
// It is the check Roblox's own sign-in page works out in the background. Roblox makes T larger
// after many sign-in attempts from one address, so it reports progress and can be stopped.
export async function solveTimeLockPuzzle(artifacts, { onProgress, signal, sliceMs = 30 } = {}) {
	let n;
	let t;
	let x;
	try {
		const a = typeof artifacts === "string" ? JSON.parse(artifacts) : artifacts || {};
		// Numbers are read from the JSON text itself where possible: JSON.parse rounds big ones.
		const exact = (k) => (typeof artifacts === "string" ? new RegExp(`"${k}"\\s*:\\s*"?([0-9a-fA-Fx]+)"?`, "i").exec(artifacts)?.[1] : null);
		const pick = (k) => exact(k) ?? a[k] ?? a[k.toLowerCase()];
		const big = (v) => {
			const s = String(v ?? "");
			if (/^[0-9]+$/.test(s)) return BigInt(s);
			if (/^(0x)?[0-9a-f]+$/i.test(s)) return BigInt(`0x${s.replace(/^0x/i, "")}`);
			throw new Error("not a number");
		};
		n = big(pick("N"));
		t = Number(pick("T"));
		x = big(pick("A"));
	} catch {
		throw new Error("unreadable puzzle");
	}
	if (!(n > 1n) || !Number.isSafeInteger(t) || t < 0) throw new Error("unreadable puzzle");
	x %= n;
	let sliceStart = clock();
	for (let i = 1; i <= t; i++) {
		x = (x * x) % n;
		if ((i & 1023) === 0 && clock() - sliceStart >= sliceMs) {
			onProgress?.(i / t);
			await yieldToPage();
			if (signal?.aborted) throw cancelled();
			sliceStart = clock();
		}
	}
	return x.toString();
}

async function proofOfWork(net, metadata, ask) {
	const sessionId = metadata.sessionId || metadata.sessionID;
	if (!sessionId) throw fail("Roblox asked for a proof-of-work check without saying which. Try again, or use quick sign-in.");
	ask.progress?.("Roblox asked this browser to prove it isn't a bot. Working it out…");
	const puzzle = await net.api(`${POW}?sessionID=${encodeURIComponent(sessionId)}`);
	if (ask.signal?.aborted) throw cancelled();
	const squarings = Number(/"T"\s*:\s*"?(\d+)/.exec(String(puzzle?.artifacts ?? ""))?.[1] || 0);
	const intro =
		squarings > 5e6
			? "Roblox asked this browser to prove it isn't a bot, with a long puzzle (Roblox makes them longer after many sign-in attempts from the same address)."
			: "Roblox asked this browser to prove it isn't a bot.";
	if (puzzle?.puzzleType !== undefined && !["1", "TimeLockPuzzle"].includes(String(puzzle.puzzleType))) {
		throw fail(`Roblox asked for a kind of proof-of-work webblox doesn't know ("${puzzle.puzzleType}"). Use quick sign-in instead.`);
	}
	let solution;
	try {
		solution = await solveTimeLockPuzzle(puzzle?.artifacts, { signal: ask.signal, onProgress: (f) => ask.progress?.(`${intro} Working it out: ${Math.floor(f * 100)}%`) });
	} catch (err) {
		if (err.cancelled) throw err;
		throw fail("Roblox's proof-of-work check came in a form webblox can't read. Use quick sign-in instead.");
	}
	ask.progress?.("Sending the answer to Roblox…");
	const r = await net.api(POW, { method: "POST", body: { sessionID: sessionId, solution } });
	if (!r?.answerCorrect || !r.redemptionToken) throw fail("Roblox didn't accept the proof-of-work answer. Try again, or use quick sign-in.");
	// Roblox's challenge metadata, completed with the redemption token.
	return { ...metadata, sessionId, redemptionToken: r.redemptionToken };
}

// Asks for a 2-step verification code (or another code-based method) until Roblox accepts one.
// Resolves with Roblox's verification token.
async function twoStepCode(net, { userId, challengeId, actionType = "Login", preferred = "" }, ask) {
	if (!userId || !challengeId) throw fail("Roblox asked for 2-step verification without saying for which account. Try again.");
	const query = `challengeId=${encodeURIComponent(challengeId)}&actionType=${encodeURIComponent(actionType)}`;
	const [config, meta] = await Promise.all([
		net.api(`${TSV}/users/${encodeURIComponent(userId)}/configuration?${query}`).catch(() => null),
		net.api(`${TSV}/metadata?userId=${encodeURIComponent(userId)}&${query}`).catch(() => null),
	]);
	const enabled = (config?.methods || []).filter((m) => m.enabled).map((m) => mediaName(m.mediaType));
	const methods = enabled.filter((m) => CODE_PATHS[m]);
	if (methods.includes("Authenticator") && !methods.includes("RecoveryCode")) methods.push("RecoveryCode");
	let method = [preferred, mediaName(config?.primaryMediaType)].find((m) => CODE_PATHS[m]) || methods[0];
	if (!method) {
		const others = enabled.map((m) => OTHER_METHODS[m]).filter(Boolean);
		throw fail(`This account's 2-step verification uses ${others.length ? others.join(" or ") : "a method"} that webblox can't do here. Use quick sign-in instead.`);
	}
	if (!methods.includes(method)) methods.unshift(method);
	const sendCode = (m) => net.api(`${TSV}/users/${encodeURIComponent(userId)}/challenges/${CODE_PATHS[m]}/send-code`, { method: "POST", body: { challengeId, actionType } });
	const sent = new Set([method]); // Roblox sends the first email or text itself
	const codeLength = (m) => (m === "Email" ? meta?.emailCodeLength : m === "RecoveryCode" ? null : meta?.authenticatorCodeLength) || (m === "RecoveryCode" ? null : 6);
	let error = "";
	for (;;) {
		const answer = await ask.code({
			method,
			methods,
			codeLength: codeLength(method),
			maskedEmail: meta?.maskedUserEmail || null,
			error,
			resend: method === "Email" || method === "SMS" ? () => sendCode(method) : null,
		});
		if (!answer) throw cancelled();
		if (answer.switchTo && CODE_PATHS[answer.switchTo]) {
			method = answer.switchTo;
			error = "";
			if ((method === "Email" || method === "SMS") && !sent.has(method)) {
				sent.add(method);
				await sendCode(method).catch((err) => {
					error = `Roblox couldn't send the code (${err.message}).`;
				});
			}
			continue;
		}
		const code = String(answer.code || "").replace(/\s+/g, "");
		if (!code) continue;
		try {
			const r = await net.api(`${TSV}/users/${encodeURIComponent(userId)}/challenges/${CODE_PATHS[method]}/verify`, { method: "POST", body: { challengeId, actionType, code } });
			if (r?.verificationToken) return r.verificationToken;
			error = "Roblox didn't confirm that code. Try again.";
		} catch (err) {
			const c = err.data?.errors?.[0]?.code;
			if (c === 10) error = "That code isn't right. Check it and try again.";
			else if (err.status === 429 || c === 5) error = "Too many tries. Wait a minute, then try again.";
			else if (c === 1) throw fail("That verification expired. Sign in again.");
			else throw err.status ? fail(`Roblox couldn't check the code (${err.message}).`) : err;
		}
	}
}

async function solveChallenge(net, challenge, ask) {
	const kind = challenge.type.toLowerCase();
	const meta = challenge.metadata;
	if (kind === "twostepverification") {
		const actionType = meta.actionType || "Login";
		const verificationToken = await twoStepCode(net, { userId: meta.userId, challengeId: meta.challengeId, actionType }, ask);
		return { verificationToken, rememberDevice: false, challengeId: meta.challengeId, actionType };
	}
	if (kind === "proofofwork") return proofOfWork(net, meta, ask);
	if (kind.startsWith("captcha")) throw captchaNeeded();
	throw fail(`Roblox asked for a check webblox can't do here ("${challenge.type}"). Use quick sign-in or the cookie option instead.`);
}

// What Roblox says after an answer: nothing more, or the next challenge in a chain (a proof of
// work can be followed by a CAPTCHA, for instance).
export function nextChallenge(reply, previous) {
	const type = reply?.challengeType;
	if (!type || type.toLowerCase() === previous.type.toLowerCase()) return null;
	let metadata = {};
	try {
		metadata = typeof reply.challengeMetadata === "string" ? JSON.parse(reply.challengeMetadata) : reply.challengeMetadata || {};
	} catch {
		metadata = {};
	}
	return { id: reply.challengeId || previous.id, type, metadata };
}

// Answers a challenge and any that follow it. Resolves with what the retried request must carry.
async function answerChallenges(net, challenge, ask) {
	let answered = null;
	for (let step = 0; challenge; step++) {
		if (step === 4) throw fail("Roblox kept asking for more checks. Try quick sign-in instead.");
		const answer = await solveChallenge(net, challenge, ask);
		const reply = await net.api(CONTINUE, { method: "POST", body: { challengeId: challenge.id, challengeType: challenge.type, challengeMetadata: JSON.stringify(answer) } });
		answered = { id: challenge.id, type: challenge.type, metadata: answer };
		challenge = nextChallenge(reply, challenge);
	}
	return answered;
}

/**
 * Runs a Roblox request that may come back with a challenge, answers it (2-step verification and
 * proof of work here; a CAPTCHA is reported) and repeats the request with the answer.
 * `send(headers)` makes the request with the extra headers it is given.
 */
export async function withChallenges(net, send, ask = {}) {
	let answered = null;
	for (let round = 0; round < 5; round++) {
		try {
			return await send(answered ? challengeHeaders(answered) : {});
		} catch (err) {
			const challenge = readChallenge(err);
			if (!challenge) throw err;
			answered = await answerChallenges(net, challenge, ask);
		}
	}
	throw fail("Roblox kept asking for more checks. Try again later.");
}

/**
 * Signs in with a username (or email) and password through Roblox's own login API, from this
 * browser. Roblox may want more first; `ask` covers what needs the person:
 *   ask.code({ method, methods, codeLength, maskedEmail, error, resend }) resolves with { code } or
 *     { switchTo: method }, or null to give up
 *   ask.progress(text) for slow steps
 *   ask.signal, an AbortSignal that stops a long proof-of-work puzzle
 * Errors meant for the person have userFacing set; giving up has cancelled set.
 */
export async function signInWithPassword(net, { identifier, password }, ask = {}) {
	const cvalue = String(identifier || "").trim();
	if (!cvalue || !password) throw fail("Enter your username and password.");
	const body = { ctype: credentialType(cvalue), cvalue, password };
	net.jar.removeWhere(isSessionCookie);
	let answered = null;
	for (let round = 0; round < 5; round++) {
		let data;
		try {
			data = await net.api(LOGIN, { method: "POST", body, headers: answered ? challengeHeaders(answered) : {} });
		} catch (err) {
			const challenge = readChallenge(err);
			if (!challenge) throw loginError(err);
			answered = await answerChallenges(net, challenge, ask);
			ask.progress?.("Signing in…");
			continue;
		}
		// Older accounts can still get 2-step verification as part of a successful answer.
		const tsv = data?.twoStepVerificationData;
		if (tsv?.ticket && data?.user?.id) {
			const token = await twoStepCode(net, { userId: data.user.id, challengeId: tsv.ticket, preferred: mediaName(tsv.mediaType) }, ask);
			ask.progress?.("Signing in…");
			await net.api(`https://auth.roblox.com/v3/users/${encodeURIComponent(data.user.id)}/two-step-verification/login`, {
				method: "POST",
				body: { challengeId: tsv.ticket, verificationToken: token, rememberDevice: false },
			}).catch((err) => {
				throw loginError(err);
			});
		}
		const user = await authenticatedUser(net);
		if (!user) throw fail("Roblox accepted the password but didn't start a session. Try again, or use quick sign-in.");
		await markSource(net.jar, "password");
		return { ...user, banned: !!data?.isBanned };
	}
	throw fail("Roblox kept asking for more checks. Try quick sign-in instead.");
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
