// Runs the game connections that go through the Wisp server. Each is a UDP stream through Wisp
// (on its own WebSocket, so game packets never wait behind asset downloads) carrying the userland
// QUIC + HTTP/3 + WebTransport client. The engine's threads reach this worker through the
// WebTransport stand-in (wt-shim.js) over BroadcastChannels; it also answers which route the
// "Game connection" setting picks.

import { TunnelWebTransport, WebTransportError } from "../js/lib/quic/webtransport.js";
import { openWispUdp } from "../js/lib/quic/wisp-udp.js";
import { RootStore, verifyServerChain } from "../js/lib/quic/x509.js";
import { maskUrl } from "../js/lib/wt-shim.js";

let config = null; // { mode, wispUrl, fallbackMs, client, origin }
let preferTunnel = false; // set once a direct connection failed and the tunnel worked
let roots = null;

const diag = new BroadcastChannel("webblox:diag");
const report = (kind, data) => {
	try {
		diag.postMessage({ kind, where: "tunnel", at: Date.now(), ...data });
	} catch {
		// diagnostics never matter more than the game
	}
};

// Mozilla's root store (from Node at build time), for game servers whose certificate is not
// pinned by hash. Fetched the first time it is needed.
function loadRoots() {
	roots ||= fetch(new URL("roots.json", self.location.href))
		.then((r) => {
			if (!r.ok) throw new Error(`roots.json: HTTP ${r.status}`);
			return r.json();
		})
		.then((j) => RootStore.fromBase64(j.roots));
	roots.catch(() => (roots = null));
	return roots;
}

self.onmessage = (e) => {
	if (e.data?.type !== "init") return;
	config = e.data.options;
	listen();
};

function listen() {
	const control = new BroadcastChannel("webblox:wt");
	control.onmessage = (e) => {
		const m = e.data;
		if (!m || (m.client && config.client && m.client !== config.client)) return; // another tab's engine
		if (m.t === "hello") {
			control.postMessage({ t: "config", nonce: m.nonce, mode: config.mode, fallbackMs: config.fallbackMs, preferTunnel });
		} else if (m.t === "open" && typeof m.sid === "string") {
			openSession(m).catch((err) => console.warn("[webblox] tunnel session failed:", err));
		} else if (m.t === "outcome" && m.via === "wisp") {
			preferTunnel = true;
			report("tunnel-preferred", { directFailed: !!m.directFailed });
		}
	};
}

async function openSession({ sid, url, hashes, origin }) {
	const channel = new BroadcastChannel(`webblox:wt:${sid}`);
	const post = (m) => {
		try {
			channel.postMessage(m);
		} catch {
			// closed
		}
	};
	const target = new URL(url);
	const host = maskUrl(url);
	const t0 = performance.now();
	const ms = () => Math.round(performance.now() - t0);
	let wt = null;
	let sock = null;
	let closedEarly = null;
	const writers = new Map(); // engine stream -> writer
	const readers = new Map(); // our stream number -> reader
	let dgWriter = null;

	channel.onmessage = (e) => {
		const m = e.data;
		if (m?.t === "close" && !wt) {
			closedEarly = m;
			sock?.close();
			return;
		}
		if (!wt) return;
		switch (m?.t) {
			case "dg":
				dgWriter ||= wt.datagrams.writable.getWriter();
				dgWriter.write(m.d).catch(() => {});
				break;
			case "uopen":
				wt.createUnidirectionalStream().then(
					(stream) => {
						writers.set(m.s, stream.getWriter());
						post({ t: "uopened", s: m.s });
					},
					(err) => post({ t: "uopenerr", s: m.s, message: err.message }),
				);
				break;
			case "uw": {
				const w = writers.get(m.s);
				const n = m.d.byteLength;
				w?.write(m.d).then(
					() => post({ t: "uack", s: m.s, n }),
					(err) => post({ t: "uerr", s: m.s, message: err.message, code: err.streamErrorCode ?? 0 }),
				);
				break;
			}
			case "uclose": {
				const w = writers.get(m.s);
				writers.delete(m.s);
				w?.close().then(
					() => post({ t: "uclosed", s: m.s }),
					(err) => post({ t: "uerr", s: m.s, message: err.message, code: err.streamErrorCode ?? 0 }),
				);
				break;
			}
			case "uabort": {
				const w = writers.get(m.s);
				writers.delete(m.s);
				w?.abort({ streamErrorCode: m.code }).catch(() => {});
				break;
			}
			case "rcancel": {
				const r = readers.get(m.s);
				readers.delete(m.s);
				r?.cancel().catch(() => {});
				break;
			}
			case "stats":
				wt.getStats().then((v) => post({ t: "stats", q: m.q, v }));
				break;
			case "close":
				wt.close({ closeCode: m.code, reason: m.reason });
				break;
			default:
		}
	};

	report("tunnel-open", { url: host, wisp: config.wispUrl, pinned: hashes.length });
	try {
		sock = await openWispUdp(config.wispUrl, target.hostname.replace(/^\[|\]$/g, ""), Number(target.port || 443));
	} catch (err) {
		post({ t: "failed", message: `Wisp: ${err.message}` });
		report("tunnel-fail", { url: host, ms: ms(), stage: "wisp", error: err.message });
		setTimeout(() => channel.close(), 1000);
		return;
	}
	if (closedEarly) {
		sock.close();
		channel.close();
		return;
	}

	const options = { serverCertificateHashes: hashes.map((value) => ({ algorithm: "sha-256", value })) };
	// Without pinned hashes the browser would check the certificate against its trust store.
	if (!hashes.length) options.verifyChain = async (chain, name) => verifyServerChain(chain, name, await loadRoots());
	const udp = { send: (d) => sock.send(d), onReceive: (cb) => (sock.onmessage = cb), close: () => sock.close() };
	wt = new TunnelWebTransport(url, options, udp, origin || self.location.origin);
	sock.onclose = (err) => wt.fail(new WebTransportError(`Wisp: ${err.message}`));

	wt.ready.then(
		() => {
			post({ t: "ready", maxDatagramSize: wt.datagrams.maxDatagramSize });
			report("tunnel-ready", { url: host, ms: ms(), wispVersion: sock.version });
			pumpDatagrams();
			pumpStreams();
		},
		(err) => {
			post({ t: "failed", message: err.message });
			report("tunnel-fail", { url: host, ms: ms(), stage: "quic", error: err.message });
		},
	);
	wt.closed
		.then(
			(info) => post({ t: "closed", closeCode: info?.closeCode ?? 0, reason: info?.reason ?? "" }),
			(err) => post({ t: "closed", error: err.message }),
		)
		.finally(async () => {
			const s = await wt.getStats().catch(() => null);
			report("tunnel-closed", { url: host, ms: ms(), rtt: s ? Math.round(s.smoothedRtt) : null, lost: s?.packetsLost ?? null, sent: s?.packetsSent ?? null, dropped: sock.dropped });
			setTimeout(() => channel.close(), 1000);
		});

	async function pumpDatagrams() {
		const reader = wt.datagrams.readable.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				post({ t: "dg", d: value });
			}
		} catch {
			// session closed
		}
	}

	async function pumpStreams() {
		const incoming = wt.incomingUnidirectionalStreams.getReader();
		let next = 1;
		try {
			for (;;) {
				const { value: stream, done } = await incoming.read();
				if (done) return;
				const s = next++;
				const reader = stream.getReader();
				readers.set(s, reader);
				post({ t: "uin", s });
				(async () => {
					try {
						for (;;) {
							const { value, done: end } = await reader.read();
							if (end) break;
							post({ t: "ud", s, d: value });
						}
						if (readers.has(s)) post({ t: "ufin", s });
					} catch (err) {
						if (readers.has(s)) post({ t: "ureset", s, code: err?.streamErrorCode ?? 0 });
					}
					readers.delete(s);
				})();
			}
		} catch {
			// session closed
		}
	}
}
