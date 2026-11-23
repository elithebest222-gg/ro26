import assert from "node:assert/strict";
import { test } from "node:test";
import { installWebTransportShim } from "../src/js/lib/wt-shim.js";

// Channels that do not keep the test process alive.
class BC extends BroadcastChannel {
	constructor(name) {
		super(name);
		this.unref?.();
	}
}

// Stand-in for tunnel.worker.js: same protocol, echoing instead of talking QUIC.
function fakeTunnelWorker({ mode, fallbackMs = 500, fail = null }) {
	const state = { preferTunnel: false, opened: [] };
	const control = new BC("webblox:wt");
	control.onmessage = (e) => {
		const m = e.data;
		if (m.t === "hello") control.postMessage({ t: "config", nonce: m.nonce, mode, fallbackMs, preferTunnel: state.preferTunnel });
		else if (m.t === "outcome") state.preferTunnel = true;
		else if (m.t === "open") {
			state.opened.push(m);
			const ch = new BC(`webblox:wt:${m.sid}`);
			const post = (x) => ch.postMessage(x);
			const chunks = new Map();
			ch.onmessage = (ev) => {
				const x = ev.data;
				if (x.t === "dg") post({ t: "dg", d: new Uint8Array([...new TextEncoder().encode("echo:"), ...x.d]) });
				else if (x.t === "uopen") post({ t: "uopened", s: x.s });
				else if (x.t === "uw") {
					chunks.set(x.s, [...(chunks.get(x.s) || []), ...x.d]);
					post({ t: "uack", s: x.s, n: x.d.byteLength });
				} else if (x.t === "uclose") {
					post({ t: "uclosed", s: x.s });
					post({ t: "uin", s: 1 });
					post({ t: "ud", s: 1, d: new Uint8Array(chunks.get(x.s)) });
					post({ t: "ufin", s: 1 });
				} else if (x.t === "stats") post({ t: "stats", q: x.q, v: { smoothedRtt: 12, packetsSent: 3, datagrams: {} } });
				else if (x.t === "close") post({ t: "closed", closeCode: x.code, reason: x.reason });
			};
			setTimeout(() => post(fail ? { t: "failed", message: fail } : { t: "ready", maxDatagramSize: 1217 }), 5);
		}
	};
	state.stop = () => control.close();
	return state;
}

// Stand-in for the browser's own WebTransport.
function fakeNative(behaviour) {
	return class NativeWebTransport {
		constructor(url) {
			NativeWebTransport.made = (NativeWebTransport.made || 0) + 1;
			this.url = url;
			this.datagrams = { readable: new ReadableStream(), writable: new WritableStream(), maxDatagramSize: 1211 };
			this.incomingUnidirectionalStreams = new ReadableStream();
			this.incomingBidirectionalStreams = new ReadableStream();
			this.ready = new Promise((resolve, reject) => {
				this.rejectReady = reject;
				if (behaviour === "ok") setTimeout(resolve, 5);
				else if (behaviour === "fail") setTimeout(() => reject(Object.assign(new Error("Opening handshake failed."), { source: "session" })), 5);
			});
			this.closed = new Promise((resolve, reject) => {
				this.resolveClosed = resolve;
				this.rejectClosed = reject;
			});
			this.ready.catch(() => {});
			this.closed.catch(() => {});
		}
		close(info) {
			NativeWebTransport.closedWith = info;
			this.rejectReady(new Error("closed"));
			this.resolveClosed(info);
		}
	};
}

function makeScope(native) {
	const scope = { WebTransport: native, BroadcastChannel: BC, location: { href: "https://example.test/player/", origin: "https://example.test" }, name: "em-pthread-1" };
	installWebTransportShim(scope, { client: "page-1", askTimeoutMs: 200 });
	return scope;
}

const URL_ = "https://0a1bc2-0a25024a-df70.80740223.qdmux.roblox.com/";

// The channels are unref'd, so hold the event loop open while a test waits on messages.
const live = (fn) => async (t) => {
	const keep = setInterval(() => {}, 1000);
	t.after(() => clearInterval(keep));
	await fn(t);
};

test("direct mode hands the browser's own WebTransport through untouched", live(async () => {
	const worker = fakeTunnelWorker({ mode: "direct" });
	const Native = fakeNative("ok");
	const scope = makeScope(Native);
	const wt = new scope.WebTransport(URL_);
	await wt.ready;
	assert.equal(wt._via, "direct");
	assert.equal(wt.datagrams.maxDatagramSize, 1211);
	assert.equal(typeof wt.getStats, "undefined", "no getStats when the browser has none");
	assert.equal(worker.opened.length, 0);
	worker.stop();
}));

test("wisp mode relays datagrams and streams through the tunnel worker", live(async () => {
	const worker = fakeTunnelWorker({ mode: "wisp" });
	const Native = fakeNative("ok");
	const scope = makeScope(Native);
	const wt = new scope.WebTransport(URL_, { serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(32).fill(7) }] });
	await wt.ready;
	assert.equal(wt._via, "wisp");
	assert.equal(Native.made, undefined, "never tried direct");
	assert.equal(wt.datagrams.maxDatagramSize, 1217);
	assert.deepEqual([...worker.opened[0].hashes[0]], new Array(32).fill(7));
	assert.equal(worker.opened[0].client, "page-1");

	const w = wt.datagrams.writable.getWriter();
	const r = wt.datagrams.readable.getReader();
	await w.write(new TextEncoder().encode("ping"));
	assert.equal(new TextDecoder().decode((await r.read()).value), "echo:ping");

	const s = await wt.createUnidirectionalStream();
	const sw = s.getWriter();
	const big = new Uint8Array(3000).map((_, i) => i & 0xff);
	await sw.write(big.subarray(0, 1000)); // a view into a larger buffer
	await sw.write(big.subarray(1000));
	await sw.close();
	const incoming = (await wt.incomingUnidirectionalStreams.getReader().read()).value.getReader();
	const first = await incoming.read();
	assert.deepEqual([...first.value], [...big]);
	assert.equal((await incoming.read()).done, true);

	assert.equal((await wt.getStats()).smoothedRtt, 12);
	wt.close({ closeCode: 5, reason: "bye" });
	assert.deepEqual(await wt.closed, { closeCode: 5, reason: "bye" });
	worker.stop();
}));

test("auto mode falls back to the tunnel when direct fails, and sticks to it", live(async () => {
	const worker = fakeTunnelWorker({ mode: "auto" });
	const Native = fakeNative("fail");
	const scope = makeScope(Native);
	const diag = new BC("webblox:diag");
	const events = [];
	diag.onmessage = (e) => events.push(e.data);

	const wt = new scope.WebTransport(URL_);
	await wt.ready;
	assert.equal(wt._via, "wisp");
	assert.equal(Native.made, 1);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(events.some((e) => e.kind === "wt-fallback" && e.why === "failed" && /handshake failed/.test(e.error)));
	assert.ok(worker.preferTunnel);

	const again = new scope.WebTransport(URL_);
	await again.ready;
	assert.equal(again._via, "wisp");
	assert.equal(Native.made, 1, "the second connection skipped direct");
	diag.close();
	worker.stop();
}));

test("auto mode starts the tunnel when direct is slow, and closes the loser", live(async () => {
	const worker = fakeTunnelWorker({ mode: "auto", fallbackMs: 500 });
	const Native = fakeNative("hang");
	const scope = makeScope(Native);
	const t0 = Date.now();
	const wt = new scope.WebTransport(URL_);
	await wt.ready;
	assert.equal(wt._via, "wisp");
	assert.ok(Date.now() - t0 >= 450);
	assert.deepEqual(Native.closedWith, { closeCode: 0, reason: "" });
	worker.stop();
}));

test("auto mode reports both failures", live(async () => {
	const worker = fakeTunnelWorker({ mode: "auto", fail: "Wisp: the Wisp server does not allow UDP" });
	const scope = makeScope(fakeNative("fail"));
	const wt = new scope.WebTransport(URL_);
	await assert.rejects(wt.ready, (err) => /direct: Opening handshake failed/.test(err.message) && /through Wisp: Wisp: the Wisp server does not allow UDP/.test(err.message) && err.source === "session");
	await assert.rejects(wt.closed);
	worker.stop();
}));

test("without a tunnel worker it connects directly; bad URLs throw like the real constructor", live(async () => {
	const scope = makeScope(fakeNative("ok"));
	const wt = new scope.WebTransport(URL_);
	await wt.ready;
	assert.equal(wt._via, "direct");
	assert.throws(() => new scope.WebTransport("http://insecure.example/"), /https/);
	assert.throws(() => new scope.WebTransport("https://[not-an-address/"), /Invalid URL/);
}));

test("closing before ready rejects ready and closed", live(async () => {
	const worker = fakeTunnelWorker({ mode: "auto", fallbackMs: 500 });
	const scope = makeScope(fakeNative("hang"));
	const wt = new scope.WebTransport(URL_);
	await new Promise((r) => setTimeout(r, 30));
	wt.close();
	await assert.rejects(wt.ready, /closed before it was ready/);
	await assert.rejects(wt.closed, /closed before it was ready/);
	worker.stop();
}));
