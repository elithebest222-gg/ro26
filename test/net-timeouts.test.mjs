import assert from "node:assert/strict";
import { test } from "node:test";
import { CookieJar } from "../src/js/lib/cookiejar.js";
import { epoxyRequest } from "../src/js/lib/epoxy.js";
import { RobloxNet } from "../src/js/lib/robloxnet.js";

const never = () => new Promise(() => {});

test("a Wisp server that never answers fails the request instead of hanging", async () => {
	// The first try times out; the reconnect never completes either. Both are bounded.
	const client = { fetch: never, replace_stream_provider: never };
	const t0 = Date.now();
	await assert.rejects(epoxyRequest(client, "https://users.roblox.com/v1/users/authenticated", { timeout: 80, reconnectTimeout: 60 }), /isn't answering/);
	assert.ok(Date.now() - t0 < 1000);
	// Requests that are not safe to repeat time out without a second try.
	let fetches = 0;
	const counting = { fetch: () => (fetches++, never()), replace_stream_provider: async () => {} };
	await assert.rejects(epoxyRequest(counting, "https://auth.roblox.com/v2/login", { method: "POST", timeout: 50 }), /no answer from auth\.roblox\.com within 0\.05s/);
	assert.equal(fetches, 1);
});

test("a dropped connection is retried once over a fresh one", async () => {
	let reconnects = 0;
	let calls = 0;
	const client = {
		async fetch() {
			calls++;
			if (calls === 1) throw new Error("stream closed");
			const res = new Response("{}", { status: 200 });
			res.rawHeaders = {};
			return res;
		},
		async replace_stream_provider() {
			reconnects++;
		},
	};
	const res = await epoxyRequest(client, "https://users.roblox.com/v1/users/authenticated", { timeout: 1000 });
	assert.equal(res.status, 200);
	assert.equal(reconnects, 1);
});

test("RobloxNet reconnects after a quiet spell, before the next request", async () => {
	let reconnects = 0;
	const client = {
		async fetch() {
			const res = new Response(JSON.stringify({ id: 1, name: "a" }), { status: 200 });
			res.rawHeaders = {};
			return res;
		},
		async replace_stream_provider() {
			reconnects++;
		},
	};
	const net = new RobloxNet({ client, jar: new CookieJar(), timeout: 1000, idleRefreshMs: 40 });
	await net.api("https://users.roblox.com/v1/users/authenticated");
	await net.api("https://users.roblox.com/v1/users/authenticated");
	assert.equal(reconnects, 0, "no refresh while traffic is recent");
	await new Promise((r) => setTimeout(r, 70));
	await net.api("https://users.roblox.com/v1/users/authenticated");
	assert.equal(reconnects, 1, "refreshed once after the quiet spell");
	await net.api("https://users.roblox.com/v1/users/authenticated");
	assert.equal(reconnects, 1);
	// Off by default (the player's network worker is never idle for long).
	const plain = new RobloxNet({ client, jar: new CookieJar() });
	await plain.api("https://users.roblox.com/v1/users/authenticated");
	assert.equal(plain.idleRefreshMs, 0);
});
