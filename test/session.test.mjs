import assert from "node:assert/strict";
import { test } from "node:test";
import { CookieJar } from "../src/js/lib/cookiejar.js";
import { RobloxNet } from "../src/js/lib/robloxnet.js";
import { planScramjetImport } from "../src/js/lib/scramjet-session.js";
import { finishQuickLogin, normalizeCookieInput, quickLoginStatus, signInWithCookie, signOut, startQuickLogin } from "../src/js/lib/session.js";

const GOOD = `_|WARNING:-DO-NOT-SHARE-THIS.|_${"A1B2C3D4".repeat(40)}`;
const WWW = new URL("https://www.roblox.com/");

// A fake EpoxyClient that plays a tiny Roblox: users/authenticated answers 200 only for GOOD.
function fakeRoblox(routes = {}) {
	const calls = [];
	return {
		calls,
		async fetch(url, init) {
			const u = new URL(url);
			calls.push({ path: u.pathname, cookie: init.headers.cookie || "", body: init.body ?? null });
			const route = routes[u.pathname];
			let out;
			if (route) out = await route(init);
			else if (u.pathname === "/v1/users/authenticated") {
				out = (init.headers.cookie || "").includes(`.ROBLOSECURITY=${GOOD}`)
					? { status: 200, body: { id: 1, name: "builderman", displayName: "Builderman" } }
					: { status: 401, body: { errors: [{ code: 0, message: "Authorization has been denied for this request." }] } };
			} else out = { status: 404, body: {} };
			const res = new Response(JSON.stringify(out.body ?? {}), { status: out.status });
			res.rawHeaders = out.headers || {};
			return res;
		},
		async replace_stream_provider() {},
	};
}

test("normalizes pasted cookie values", () => {
	assert.equal(normalizeCookieInput(`  .ROBLOSECURITY=${GOOD}; domain=.roblox.com; path=/ `), GOOD);
	assert.equal(normalizeCookieInput(`"${GOOD}"`), GOOD);
	assert.equal(normalizeCookieInput(`${GOOD.slice(0, 40)}\n${GOOD.slice(40)}`), GOOD);
});

test("cookie sign-in checks the cookie before replacing the session", async () => {
	const jar = new CookieJar();
	jar.set({ name: ".ROBLOSECURITY", value: "OLD", domain: "roblox.com", path: "/" });
	const net = new RobloxNet({ client: fakeRoblox(), jar });
	await assert.rejects(signInWithCookie(net, "_|WARNING:x|_" + "Z".repeat(80)), (e) => e.userFacing && /didn't accept/.test(e.message));
	assert.equal(jar.get(".ROBLOSECURITY", WWW).value, "OLD");
	await assert.rejects(signInWithCookie(net, "short"), /doesn't look like/);
	const user = await signInWithCookie(net, `.ROBLOSECURITY=${GOOD}`);
	assert.equal(user.displayName, "Builderman");
	assert.equal(jar.get(".ROBLOSECURITY", new URL("https://gamejoin.roblox.com/")).value, GOOD);
	assert.equal(jar.meta.sessionSource, "cookie");
});

test("quick sign-in: create, status, then AuthToken login sets the session", async () => {
	const client = fakeRoblox({
		"/auth-token-service/v1/login/create": () => ({ status: 200, body: { code: "ABC123", privateKey: "pk", status: "Created", expirationTime: "2099-01-01T00:00:00.000", imagePath: "/v1/login/qr-code-image?key=k&code=ABC123" } }),
		"/auth-token-service/v1/login/status": () => ({ status: 200, body: { status: "Validated", accountName: "builderman" } }),
		"/v2/login": (init) => {
			assert.deepEqual(JSON.parse(init.body), { ctype: "AuthToken", cvalue: "ABC123", password: "pk" });
			return { status: 200, headers: { "set-cookie": [`.ROBLOSECURITY=${GOOD}; domain=.roblox.com; path=/; secure; httponly`] }, body: { user: { id: 1 } } };
		},
	});
	const jar = new CookieJar();
	const net = new RobloxNet({ client, jar });
	const q = await startQuickLogin(net);
	assert.equal(q.code, "ABC123");
	assert.equal(q.expiresAt, Date.parse("2099-01-01T00:00:00.000Z"));
	assert.equal(q.qrUrl, "https://apis.roblox.com/auth-token-service/v1/login/qr-code-image?key=k&code=ABC123");
	assert.equal((await quickLoginStatus(net, q)).status, "Validated");
	const user = await finishQuickLogin(net, q);
	assert.equal(user.name, "builderman");
	assert.equal(jar.meta.sessionSource, "quick");
});

test("quick sign-in reports 2-step verification instead of pretending", async () => {
	const client = fakeRoblox({ "/v2/login": () => ({ status: 200, body: { user: { id: 1 }, twoStepVerificationData: { mediaType: "Email", ticket: "t" } } }) });
	await assert.rejects(finishQuickLogin(new RobloxNet({ client, jar: new CookieJar() }), { code: "A", privateKey: "B" }), /2-step verification/);
});

test("sign-out ends webblox's own sessions at Roblox but only forgets a pasted cookie", async () => {
	for (const [source, expectLogout] of [["quick", true], ["cookie", false]]) {
		const client = fakeRoblox({ "/v2/logout": () => ({ status: 200, body: {} }) });
		const jar = new CookieJar();
		jar.set({ name: ".ROBLOSECURITY", value: GOOD, domain: "roblox.com", path: "/" });
		jar.meta = { sessionSource: source };
		const { shared } = await signOut(new RobloxNet({ client, jar }));
		assert.equal(shared, !expectLogout);
		assert.equal(client.calls.some((c) => c.path === "/v2/logout"), expectLogout);
		assert.equal(jar.get(".ROBLOSECURITY", WWW), null);
	}
});

test("browser session sync only reacts to the browser's own session", () => {
	assert.equal(planScramjetImport("A", null), "import");
	assert.equal(planScramjetImport("B", "A"), "import");
	assert.equal(planScramjetImport("A", "A"), "none");
	assert.equal(planScramjetImport(null, null), "none");
	assert.equal(planScramjetImport(null, "A"), "signout");
});
