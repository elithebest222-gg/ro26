import assert from "node:assert/strict";
import { test } from "node:test";
import { CookieJar } from "../src/js/lib/cookiejar.js";
import { RobloxNet } from "../src/js/lib/robloxnet.js";
import { CAPTCHA_MESSAGE, credentialType, signInWithPassword, solveTimeLockPuzzle } from "../src/js/lib/session.js";

const SESSION = `_|WARNING:-DO-NOT-SHARE-THIS.|_${"Z9".repeat(150)}`;
const SET_SESSION = { "set-cookie": [`.ROBLOSECURITY=${SESSION}; domain=.roblox.com; path=/; secure; httponly`] };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString());

// A fake EpoxyClient playing Roblox: routes keyed "METHOD /path"; users/authenticated answers for
// whoever holds SESSION.
function fakeRoblox(routes) {
	const calls = [];
	const client = {
		calls,
		async fetch(url, init) {
			const u = new URL(url);
			const key = `${(init.method || "GET").toUpperCase()} ${u.pathname}`;
			const call = { key, host: u.host, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
			calls.push(call);
			let out;
			if (routes[key]) out = await routes[key](call);
			else if (key === "GET /v1/users/authenticated") {
				out = (init.headers.cookie || "").includes(SESSION) ? { status: 200, body: { id: 42, name: "builderman", displayName: "Builderman" } } : { status: 401, body: {} };
			} else out = { status: 404, body: { errors: [{ code: 0, message: `no route ${key}` }] } };
			const res = new Response(JSON.stringify(out.body ?? {}), { status: out.status });
			res.rawHeaders = out.headers || {};
			return res;
		},
		async replace_stream_provider() {},
	};
	return client;
}

const netFor = (routes) => {
	const client = fakeRoblox(routes);
	return { client, net: new RobloxNet({ client, jar: new CookieJar() }) };
};

function modPow(base, exp, mod) {
	let result = 1n;
	let b = base % mod;
	for (let e = exp; e > 0n; e >>= 1n) {
		if (e & 1n) result = (result * b) % mod;
		b = (b * b) % mod;
	}
	return result;
}

test("guesses the credential type from what was typed", () => {
	assert.equal(credentialType("builderman"), "Username");
	assert.equal(credentialType("  me@example.com "), "Email");
	assert.equal(credentialType("+1 (555) 123-4567"), "PhoneNumber");
	assert.equal(credentialType("5551234567"), "Username");
});

test("time-lock puzzles: A^(2^T) mod N, decimal or hex", async () => {
	assert.equal(await solveTimeLockPuzzle(JSON.stringify({ N: "3233", A: "5", T: 10 })), modPow(5n, 1024n, 3233n).toString());
	assert.equal(await solveTimeLockPuzzle({ n: "ca1", a: "5", t: 10 }), modPow(5n, 1024n, 3233n).toString());
	const seen = [];
	assert.equal(await solveTimeLockPuzzle({ N: "1000003", A: "2", T: 20000 }, { sliceMs: 0, onProgress: (f) => seen.push(f) }), modPow(2n, 2n ** 20000n, 1000003n).toString());
	assert.ok(seen.length >= 15 && seen.every((f, i) => f > 0 && f < 1 && (i === 0 || f > seen[i - 1])), "reports rising progress between slices");
	const stop = new AbortController();
	stop.abort();
	await assert.rejects(solveTimeLockPuzzle({ N: "1000003", A: "2", T: 20000 }, { sliceMs: 0, signal: stop.signal }), (e) => e.cancelled === true);
	// Roblox's shape: N as a decimal string, A and T as JSON numbers; a big A keeps every digit.
	const n = 2n ** 127n - 1n;
	const bigA = 98765432109876543210n;
	assert.equal(await solveTimeLockPuzzle(`{"N":"${n}","A":${bigA},"T":300}`), modPow(bigA, 2n ** 300n, n).toString());
	await assert.rejects(solveTimeLockPuzzle({ A: "2" }), /unreadable/);
});

test("a correct password signs in and keeps only the session", async () => {
	const { net, client } = netFor({
		"POST /v2/login": (c) => {
			assert.deepEqual(c.body, { ctype: "Username", cvalue: "builderman", password: "hunter2" });
			assert.equal(c.host, "auth.roblox.com");
			return { status: 200, headers: SET_SESSION, body: { user: { id: 42, name: "builderman" } } };
		},
	});
	const user = await signInWithPassword(net, { identifier: " builderman ", password: "hunter2" });
	assert.equal(user.displayName, "Builderman");
	assert.equal(user.banned, false);
	assert.equal(net.jar.meta.sessionSource, "password");
	assert.ok(!JSON.stringify(net.jar).includes("hunter2"), "the password is not stored");
	assert.equal(client.calls.filter((c) => c.key === "POST /v2/login").length, 1);
});

test("Roblox's refusals become plain messages", async () => {
	const answer = (status, code, message) => netFor({ "POST /v2/login": () => ({ status, body: { errors: [{ code, message }] } }) }).net;
	await assert.rejects(signInWithPassword(answer(403, 1, "Incorrect username or password. Please try again."), { identifier: "a", password: "b" }), (e) => e.userFacing && e.message === "Incorrect username or password.");
	await assert.rejects(signInWithPassword(answer(429, 7, "Too many attempts."), { identifier: "a", password: "b" }), /Too many sign-in attempts/);
	await assert.rejects(signInWithPassword(answer(403, 2, "You must pass the robot test before logging in."), { identifier: "a", password: "b" }), (e) => e.message === CAPTCHA_MESSAGE);
	await assert.rejects(signInWithPassword(answer(403, 44, "Login is unavailable in your country."), { identifier: "a", password: "b" }), /unavailable in your country/);
	await assert.rejects(signInWithPassword(answer(403, 1, "x"), { identifier: "", password: "b" }), /Enter your username and password/);
});

test("2-step verification challenge: asks for the code, retries a wrong one, can switch method", async () => {
	const sendCodes = [];
	const { net, client } = netFor({
		"POST /v2/login": (c) => {
			if (!c.headers["rblx-challenge-id"]) {
				return {
					status: 403,
					headers: {
						"rblx-challenge-id": "C1",
						"rblx-challenge-type": "twostepverification",
						"rblx-challenge-metadata": b64({ userId: "42", challengeId: "TSV1", actionType: "Login", shouldShowRememberDeviceCheckbox: true }),
					},
					body: { errors: [{ code: 0, message: "Challenge is required to authorize the request" }] },
				};
			}
			assert.equal(c.headers["rblx-challenge-id"], "C1");
			assert.equal(c.headers["rblx-challenge-type"], "twostepverification");
			assert.deepEqual(unb64(c.headers["rblx-challenge-metadata"]), { verificationToken: "VT", rememberDevice: false, challengeId: "TSV1", actionType: "Login" });
			return { status: 200, headers: SET_SESSION, body: { user: { id: 42 } } };
		},
		"GET /v1/users/42/configuration": (c) => {
			assert.deepEqual(c.query, { challengeId: "TSV1", actionType: "Login" });
			return { status: 200, body: { primaryMediaType: 2, methods: [{ mediaType: 0, enabled: true }, { mediaType: 2, enabled: true }, { mediaType: 4, enabled: true }, { mediaType: 1, enabled: false }] } };
		},
		"GET /v1/metadata": () => ({ status: 200, body: { authenticatorCodeLength: 6, emailCodeLength: 6, maskedUserEmail: "b***@example.com" } }),
		"POST /v1/users/42/challenges/authenticator/verify": (c) => {
			assert.equal(c.body.challengeId, "TSV1");
			assert.equal(c.body.actionType, "Login");
			return c.body.code === "123456" ? { status: 200, body: { verificationToken: "VT" } } : { status: 400, body: { errors: [{ code: 10, message: "The two step verification challenge code is invalid." }] } };
		},
		"POST /v1/users/42/challenges/email/send-code": (c) => {
			sendCodes.push(c.body);
			return { status: 200, body: {} };
		},
		"POST /challenge/v1/continue": (c) => {
			assert.equal(c.body.challengeId, "C1");
			assert.equal(c.body.challengeType, "twostepverification");
			assert.deepEqual(JSON.parse(c.body.challengeMetadata), { verificationToken: "VT", rememberDevice: false, challengeId: "TSV1", actionType: "Login" });
			return { status: 200, body: { challengeId: "C1", challengeType: "twostepverification" } };
		},
	});
	const asked = [];
	const replies = [{ code: "000000" }, { switchTo: "Email" }, { switchTo: "Authenticator" }, { code: "123 456" }];
	const user = await signInWithPassword(net, { identifier: "builderman", password: "hunter2" }, {
		code: async (req) => {
			asked.push({ method: req.method, methods: req.methods, error: req.error, codeLength: req.codeLength, email: req.maskedEmail, resend: !!req.resend });
			return replies.shift();
		},
	});
	assert.equal(user.id, "42");
	assert.deepEqual(asked[0], { method: "Authenticator", methods: ["Email", "Authenticator", "RecoveryCode"], error: "", codeLength: 6, email: "b***@example.com", resend: false });
	assert.match(asked[1].error, /isn't right/);
	assert.equal(asked[2].method, "Email");
	assert.equal(asked[2].resend, true);
	assert.equal(asked[3].method, "Authenticator");
	assert.deepEqual(sendCodes, [{ challengeId: "TSV1", actionType: "Login" }], "switching to email sends one code");
	assert.equal(client.calls.filter((c) => c.key === "POST /v2/login").length, 2);
	assert.equal(net.jar.meta.sessionSource, "password");
});

test("proof-of-work challenge is worked out and redeemed", async () => {
	const expected = modPow(5n, 2n ** 1000n, 3233n).toString();
	const progress = [];
	const { net } = netFor({
		"POST /v2/login": (c) => {
			if (!c.headers["rblx-challenge-id"]) {
				return { status: 403, headers: { "rblx-challenge-id": "P1", "rblx-challenge-type": "proofofwork", "rblx-challenge-metadata": b64({ sessionId: "S1", redemptionToken: "", requestPath: "/v2/login", requestMethod: "POST", sharedParameters: "" }) }, body: {} };
			}
			assert.deepEqual(unb64(c.headers["rblx-challenge-metadata"]), { sessionId: "S1", redemptionToken: "RT", requestPath: "/v2/login", requestMethod: "POST", sharedParameters: "" });
			return { status: 200, headers: SET_SESSION, body: { user: { id: 42 } } };
		},
		"GET /proof-of-work-service/v1/pow-puzzle": (c) => {
			assert.equal(c.query.sessionID, "S1");
			return { status: 200, body: { puzzleType: "1", artifacts: JSON.stringify({ N: "3233", A: 5, T: 1000 }) } };
		},
		"POST /proof-of-work-service/v1/pow-puzzle": (c) => ({ status: 200, body: c.body.sessionID === "S1" && c.body.solution === expected ? { answerCorrect: true, redemptionToken: "RT" } : { answerCorrect: false } }),
		"POST /challenge/v1/continue": (c) => {
			assert.equal(JSON.parse(c.body.challengeMetadata).redemptionToken, "RT");
			return { status: 200, body: {} };
		},
	});
	const user = await signInWithPassword(net, { identifier: "me@example.com", password: "pw" }, { progress: (t) => progress.push(t) });
	assert.equal(user.name, "builderman");
	assert.ok(progress.some((t) => /prove it isn't a bot/.test(t)));
});

test("a challenge chained after another is answered too, and a chained CAPTCHA is reported", async () => {
	// What Roblox does from datacenter addresses: proof of work first, then a CAPTCHA.
	let logins = 0;
	const { net } = netFor({
		"POST /v2/login": () => {
			logins++;
			return { status: 403, headers: { "rblx-challenge-id": "G1", "rblx-challenge-type": "proofofwork", "rblx-challenge-metadata": b64({ sessionId: "S1", redemptionToken: "" }) }, body: {} };
		},
		"GET /proof-of-work-service/v1/pow-puzzle": () => ({ status: 200, body: { puzzleType: "1", artifacts: JSON.stringify({ N: "3233", A: 5, T: 10 }) } }),
		"POST /proof-of-work-service/v1/pow-puzzle": () => ({ status: 200, body: { answerCorrect: true, redemptionToken: "RT" } }),
		"POST /challenge/v1/continue": () => ({ status: 200, body: { challengeId: "G1", challengeType: "captchav2", challengeMetadata: JSON.stringify({ challengeId: "G1", redemptionToken: "" }) } }),
	});
	await assert.rejects(signInWithPassword(net, { identifier: "me@example.com", password: "pw" }), (e) => e.message === CAPTCHA_MESSAGE && e.captcha === true);
	assert.equal(logins, 1, "no pointless retry once a CAPTCHA is due");
});

test("a CAPTCHA challenge says plainly that it can't be shown here", async () => {
	const { net } = netFor({
		"POST /v2/login": () => ({ status: 403, headers: { "rblx-challenge-id": "X", "rblx-challenge-type": "captcha", "rblx-challenge-metadata": b64({ unifiedCaptchaId: "u", dataExchangeBlob: "b", actionType: "Login" }) }, body: {} }),
	});
	await assert.rejects(signInWithPassword(net, { identifier: "a", password: "b" }), (e) => e.userFacing && e.message === CAPTCHA_MESSAGE);
});

test("older 2-step verification in the login answer finishes through the v3 endpoint", async () => {
	const { net, client } = netFor({
		"POST /v2/login": () => ({ status: 200, body: { user: { id: 42 }, twoStepVerificationData: { mediaType: "Email", ticket: "TK" } } }),
		"GET /v1/users/42/configuration": () => ({ status: 200, body: { primaryMediaType: "Email", methods: [{ mediaType: "Email", enabled: true }] } }),
		"POST /v1/users/42/challenges/email/verify": (c) => ({ status: 200, body: c.body.code === "654321" && c.body.challengeId === "TK" ? { verificationToken: "VT" } : {} }),
		"POST /v3/users/42/two-step-verification/login": (c) => {
			assert.deepEqual(c.body, { challengeId: "TK", verificationToken: "VT", rememberDevice: false });
			return { status: 200, headers: SET_SESSION, body: {} };
		},
	});
	const user = await signInWithPassword(net, { identifier: "builderman", password: "pw" }, { code: async (req) => (assert.equal(req.method, "Email"), { code: "654321" }) });
	assert.equal(user.id, "42");
	assert.ok(client.calls.some((c) => c.key === "POST /v3/users/42/two-step-verification/login"));
});

test("2-step methods webblox can't do, and giving up, are reported", async () => {
	const challenge = { status: 403, headers: { "rblx-challenge-id": "C", "rblx-challenge-type": "twostepverification", "rblx-challenge-metadata": b64({ userId: "42", challengeId: "T", actionType: "Login" }) }, body: {} };
	const onlyKey = netFor({
		"POST /v2/login": () => challenge,
		"GET /v1/users/42/configuration": () => ({ status: 200, body: { primaryMediaType: 4, methods: [{ mediaType: 4, enabled: true }] } }),
	});
	await assert.rejects(signInWithPassword(onlyKey.net, { identifier: "a", password: "b" }, { code: async () => ({ code: "1" }) }), /a security key/);
	const quitter = netFor({
		"POST /v2/login": () => challenge,
		"GET /v1/users/42/configuration": () => ({ status: 200, body: { primaryMediaType: 2, methods: [{ mediaType: 2, enabled: true }] } }),
	});
	await assert.rejects(signInWithPassword(quitter.net, { identifier: "a", password: "b" }, { code: async () => null }), (e) => e.cancelled === true);
});
