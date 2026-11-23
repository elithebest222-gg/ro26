import assert from "node:assert/strict";
import { test } from "node:test";
import { CookieJar } from "../src/js/lib/cookiejar.js";
import { RobloxNet, buildGameFqdn, rewriteRbxUserAgent } from "../src/js/lib/robloxnet.js";

// Stands in for EpoxyClient.fetch: records requests, answers from a handler.
function fakeClient(handler) {
	const calls = [];
	return {
		calls,
		async fetch(url, init) {
			calls.push({ url, ...init, body: typeof init.body === "string" ? init.body : init.body ? new TextDecoder().decode(init.body) : null });
			const { status = 200, headers = {}, body = "" } = await handler(url, init, calls.length);
			const res = new Response(status === 204 ? null : body, { status });
			res.rawHeaders = headers;
			return res;
		},
		async replace_stream_provider() {},
	};
}
const dec = new TextDecoder();
const req = (url, extra = {}) => ({ url, method: "GET", headers: [], body: null, credentials: "include", ...extra });

test("rbx-user-agent: Darwin for gamejoin, WinInet elsewhere", () => {
	const ua = "Roblox/Web 0.748.0.7481526 (16384MB; 1920x1080; Desktop) Browser/Chrome/142.0";
	assert.equal(rewriteRbxUserAgent(ua, "gamejoin.roblox.com"), "Roblox/Darwin");
	assert.equal(rewriteRbxUserAgent(ua, "apis.roblox.com"), "Roblox/WinInet");
	assert.equal(rewriteRbxUserAgent("Something/1", "apis.roblox.com"), "Something/1");
});

test("gameFqdn is rebuilt the way the engine writes it (fixed-width lowercase hex)", () => {
	// Values from a real join that failed while the IP label lacked its leading zero.
	const token = "A27F0C1D2E3F405162738495A6B7C8D9";
	assert.equal(
		buildGameFqdn({ NetStackTokenValue: token, MachineAddress: "10.37.2.74", NetStackPort: 57200, UdmuxEndpoints: [{ Address: "128.116.2.33", Port: 57210 }] }),
		"a27f0c1d2e3f405162738495a6b7c8d9-0a25024a-df70.80740222.qdmux.roblox.com",
	);
	// Small ports keep 4 digits; a numeric token is widened to 16 bytes.
	assert.equal(
		buildGameFqdn({ MachineAddress: "10.11.12.13", NetStackPort: 443, UdmuxEndpoints: [{ Address: "128.116.33.5" }], NetStackConfig: { NetStackTokenValue: "123456789012" } }),
		`${(123456789012n).toString(16).padStart(32, "0")}-0a0b0c0d-01bb.80742106.qdmux.roblox.com`,
	);
	assert.equal(buildGameFqdn({ MachineAddress: "10.0.0.1" }), null);
});

test("cookies, Origin and Set-Cookie handling", async () => {
	const jar = new CookieJar();
	jar.set({ name: ".ROBLOSECURITY", value: "S", domain: "roblox.com", path: "/" });
	const client = fakeClient(() => ({ headers: { "set-cookie": ["RBXEventTrackerV2=x; domain=.roblox.com; path=/"], "content-type": "application/json" }, body: "{}" }));
	const net = new RobloxNet({ client, jar });
	await net.request(req("https://users.roblox.com/v1/users/authenticated", { headers: [["cookie", "evil=1"], ["sec-fetch-mode", "cors"]] }));
	const sent = client.calls[0].headers;
	assert.equal(sent.cookie, ".ROBLOSECURITY=S");
	assert.equal(sent.origin, "https://www.roblox.com");
	assert.equal(sent["sec-fetch-mode"], undefined);
	assert.match(jar.cookieHeader(new URL("https://apis.roblox.com/")), /RBXEventTrackerV2=x/);
	await net.request(req("https://users.roblox.com/x", { credentials: "omit" }));
	assert.equal(client.calls[1].headers.cookie, undefined);
});

test("CSRF: 403 with a token is retried once with it", async () => {
	const client = fakeClient((url, init, n) => (n === 1 ? { status: 403, headers: { "x-csrf-token": "TOKEN" } } : { status: 200, body: "{}" }));
	const net = new RobloxNet({ client, jar: new CookieJar() });
	const res = await net.request(req("https://auth.roblox.com/v2/logout", { method: "POST", body: "{}" }));
	assert.equal(res.status, 200);
	assert.equal(client.calls.length, 2);
	assert.equal(client.calls[1].headers["x-csrf-token"], "TOKEN");
});

test("join: join-game -> join-game-instance with gameId until a join script arrives, then gameFqdn added", async () => {
	const joinScript = { MachineAddress: "10.0.0.1", NetStackPort: 4096, UdmuxEndpoints: [{ Address: "128.116.1.1" }], NetStackTokenValue: "ff", PlaceId: 1818 };
	const client = fakeClient((url, init, n) => ({ body: JSON.stringify(n === 1 ? { status: 0, joinScript: null } : { status: 2, joinScript }) }));
	const net = new RobloxNet({ client, jar: new CookieJar(), join: { placeId: "1818", gameId: "abc-123" } });
	const ua = [["rbx-user-agent", "Roblox/Web 0.748 (Desktop) Browser/Chrome/1"], ["content-type", "application/json"]];
	await net.request(req("https://gamejoin.roblox.com/v1/join-game", { method: "POST", headers: ua, body: JSON.stringify({ placeId: 1818 }) }));
	const res = await net.request(req("https://gamejoin.roblox.com/v1/join-game", { method: "POST", headers: ua, body: JSON.stringify({ placeId: 1818 }) }));
	assert.equal(client.calls[0].url, "https://gamejoin.roblox.com/v1/join-game-instance");
	assert.deepEqual(JSON.parse(client.calls[0].body), { placeId: 1818, gameId: "abc-123" });
	assert.equal(client.calls[0].headers["rbx-user-agent"], "Roblox/Darwin");
	assert.equal(JSON.parse(dec.decode(res.body)).joinScript.gameFqdn, `${"ff".padStart(32, "0")}-0a000001-1000.80740102.qdmux.roblox.com`);
	// After a successful join, later joins (teleports) are left alone.
	await net.request(req("https://gamejoin.roblox.com/v1/join-game", { method: "POST", headers: ua, body: JSON.stringify({ placeId: 1818 }) }));
	assert.equal(client.calls[2].url, "https://gamejoin.roblox.com/v1/join-game");
});

test("pinned flags and engine version are answered locally", async () => {
	const client = fakeClient(() => {
		throw new Error("should not hit the network");
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ applicationSettings: { FFlagA: "True", FFlagWasmPreferWebGPU: "True" } }));
	try {
		const net = new RobloxNet({
			client,
			jar: new CookieJar(),
			engine: { version: "0.748", clientVersionUpload: "version-1ef59424f70d4932", flags: { WebClientApp: "https://site/flags.json" } },
			flagOverrides: { FFlagWasmPreferWebGPU: "False" },
		});
		const flags = JSON.parse(dec.decode((await net.request(req("https://clientsettingscdn.roblox.com/v2/settings/application/MacWebClientApp"))).body));
		assert.deepEqual(flags.applicationSettings, { FFlagA: "True", FFlagWasmPreferWebGPU: "False" });
		const ver = JSON.parse(dec.decode((await net.request(req("https://clientsettings.roblox.com/v2/client-version/WebClientApp"))).body));
		assert.equal(ver.clientVersionUpload, "version-1ef59424f70d4932");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("refuses non-Roblox hosts", async () => {
	const net = new RobloxNet({ client: fakeClient(() => ({})), jar: new CookieJar() });
	await assert.rejects(net.request(req("https://example.com/")), /not a Roblox host/);
});
