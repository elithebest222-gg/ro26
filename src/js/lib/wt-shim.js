// Stands in for WebTransport in the engine's threads and routes each game connection by the
// "Game connection" setting:
//   direct  the browser's own WebTransport, straight to Roblox's game servers
//   wisp    through the Wisp server: the tunnel worker runs a QUIC client over a Wisp UDP stream
//   auto    direct first; if that fails, or has not connected after a few seconds, through Wisp
// Installed in engine workers by the player's service worker (as player/wt-shim.js) and in the
// page by boot.js. The tunnel worker (tunnel.worker.js) holds the setting and runs tunnelled
// connections; the two talk over BroadcastChannels: "webblox:wt" to find each other, then one
// channel per connection. Either way the engine sees the standard WebTransport API.

const CONTROL = "webblox:wt";
const ASK_TIMEOUT_MS = 1500;
const STREAM_WINDOW = 1024 * 1024; // bytes written to a tunnelled stream before waiting for the tunnel

const EMPTY_STATS = () => ({
	smoothedRtt: 0,
	minRtt: 0,
	rttVariation: 0,
	estimatedSendRate: null,
	packetsSent: 0,
	bytesSent: 0,
	packetsReceived: 0,
	bytesReceived: 0,
	packetsLost: 0,
	datagrams: { droppedIncoming: 0, expiredIncoming: 0, expiredOutgoing: 0, lostOutgoing: 0 },
});

// The first DNS label of a game server name carries a per-join token; keep only its start.
export function maskUrl(u) {
	try {
		const url = new URL(u);
		const labels = url.hostname.split(".");
		labels[0] = labels[0].replace(/^([0-9a-z]{4})[0-9a-z]*/i, "$1…");
		return `${labels.join(".")}${url.port ? `:${url.port}` : ""}`;
	} catch {
		return "?";
	}
}

/**
 * Replaces scope.WebTransport. `client` (string or function returning one) identifies the page,
 * so that with several player tabs open each engine talks to its own tunnel worker.
 */
export function installWebTransportShim(scope, { client = "", askTimeoutMs = ASK_TIMEOUT_MS } = {}) {
	const Native = scope.WebTransport;
	const BC = scope.BroadcastChannel;
	if (typeof Native !== "function" || typeof BC !== "function" || Native.__webbloxShim) return false;
	const clientId = () => (typeof client === "function" ? client() : client) || "";
	const where = typeof scope.document === "undefined" ? scope.name || "worker" : "page";
	const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
	const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	const control = new BC(CONTROL);
	const diag = new BC("webblox:diag");
	const report = (kind, data) => {
		try {
			diag.postMessage({ kind, where, at: Date.now(), ...data });
		} catch {
			// diagnostics must never break the engine
		}
	};

	// ---- finding the tunnel worker ----------------------------------------------------------

	let noTunnelWorker = false;
	const answers = new Map();
	control.onmessage = (e) => {
		const m = e.data;
		if (m?.t === "config" && answers.has(m.nonce)) answers.get(m.nonce)(m);
	};
	const askConfig = () =>
		noTunnelWorker
			? Promise.resolve(null)
			: new Promise((resolve) => {
					const nonce = newId();
					const timer = setTimeout(() => {
						answers.delete(nonce);
						noTunnelWorker = true;
						resolve(null);
					}, askTimeoutMs);
					answers.set(nonce, (m) => {
						clearTimeout(timer);
						answers.delete(nonce);
						resolve(m);
					});
					control.postMessage({ t: "hello", nonce, client: clientId() });
				});

	// ---- errors and bytes ---------------------------------------------------------------------

	const wtError = (message, source = "session", streamErrorCode = null) => {
		const E = scope.WebTransportError;
		if (typeof E === "function") {
			try {
				return new E(message, { source, streamErrorCode });
			} catch {
				// constructor without options
			}
		}
		return Object.assign(new Error(message), { name: "WebTransportError", source, streamErrorCode });
	};
	// Structured clone copies a view's whole buffer and cannot carry shared memory over a
	// BroadcastChannel, so send exact, unshared copies.
	const plain = (chunk) => {
		const view = chunk instanceof Uint8Array ? chunk : ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
		const shared = typeof SharedArrayBuffer !== "undefined" && view.buffer instanceof SharedArrayBuffer;
		return shared || view.byteLength !== view.buffer.byteLength ? view.slice() : view;
	};
	const hashesOf = (options) =>
		(options?.serverCertificateHashes || [])
			.filter((h) => String(h?.algorithm).toLowerCase() === "sha-256" && h.value)
			.map((h) => (ArrayBuffer.isView(h.value) ? new Uint8Array(h.value.buffer, h.value.byteOffset, h.value.byteLength).slice() : new Uint8Array(h.value).slice()));
	const closeQuietly = (t, info = { closeCode: 0, reason: "" }) => {
		try {
			t?.close(info);
		} catch {
			// already closed
		}
	};

	// ---- a connection run by the tunnel worker ------------------------------------------------

	class TunnelSession {
		constructor(url, options) {
			this.sid = newId();
			this.channel = new BC(`${CONTROL}:${this.sid}`);
			this.state = "connecting";
			this.maxDatagramSize = 1200;
			this.pending = new Map(); // request key -> { resolve, reject }
			this.outStreams = new Map(); // s -> stream state
			this.inStreams = new Map(); // s -> ReadableStream controller
			this.nextOut = 1;
			this.nextRequest = 1;
			this.droppedIncoming = 0;
			this.ready = new Promise((resolve, reject) => {
				this.resolveReady = resolve;
				this.rejectReady = reject;
			});
			this.closed = new Promise((resolve, reject) => {
				this.resolveClosed = resolve;
				this.rejectClosed = reject;
			});
			this.ready.catch(() => {});
			this.closed.catch(() => {});

			const self = this;
			let dg;
			let uni;
			let bidi;
			this.datagrams = {
				readable: new ReadableStream({ start: (c) => (dg = c) }, { highWaterMark: 0 }),
				writable: new WritableStream({
					write: (chunk) => {
						if (this.state !== "open") throw wtError("the WebTransport session is not open");
						this.post({ t: "dg", d: plain(chunk) });
					},
				}),
				get maxDatagramSize() {
					return self.maxDatagramSize;
				},
				incomingHighWaterMark: 256,
				outgoingHighWaterMark: 256,
				incomingMaxAge: null,
				outgoingMaxAge: null,
			};
			this.incomingUnidirectionalStreams = new ReadableStream({ start: (c) => (uni = c) }, { highWaterMark: 0 });
			this.incomingBidirectionalStreams = new ReadableStream({ start: (c) => (bidi = c) }, { highWaterMark: 0 });
			this.controllers = { dg, uni, bidi };
			this.channel.onmessage = (e) => this.onMessage(e.data);
			control.postMessage({ t: "open", sid: this.sid, client: clientId(), url, hashes: hashesOf(options), origin: scope.location?.origin || "" });
		}

		post(m) {
			try {
				this.channel.postMessage(m);
			} catch {
				// channel closed
			}
		}

		request(key, message) {
			return new Promise((resolve, reject) => {
				this.pending.set(key, { resolve, reject });
				this.post(message);
			});
		}

		settle(key, error, value) {
			const p = this.pending.get(key);
			if (!p) return;
			this.pending.delete(key);
			if (error) p.reject(error);
			else p.resolve(value);
		}

		onMessage(m) {
			switch (m?.t) {
				case "ready":
					if (this.state !== "connecting") return;
					this.state = "open";
					this.maxDatagramSize = m.maxDatagramSize || this.maxDatagramSize;
					this.resolveReady();
					return;
				case "failed":
					return this.finish(wtError(m.message));
				case "closed":
					return m.error ? this.finish(wtError(m.error)) : this.finish(null, { closeCode: m.closeCode ?? 0, reason: m.reason ?? "" });
				case "dg": {
					const c = this.controllers.dg;
					if ((c.desiredSize ?? 0) > -256) c.enqueue(m.d);
					else this.droppedIncoming++;
					return;
				}
				case "uin": {
					let controller;
					const stream = new ReadableStream(
						{
							start: (c) => (controller = c),
							cancel: (reason) => {
								this.inStreams.delete(m.s);
								this.post({ t: "rcancel", s: m.s, code: Number.isInteger(reason?.streamErrorCode) ? reason.streamErrorCode : 0 });
							},
						},
						{ highWaterMark: 0 },
					);
					this.inStreams.set(m.s, controller);
					try {
						this.controllers.uni.enqueue(stream);
					} catch {
						// session already closed
					}
					return;
				}
				case "ud":
					try {
						this.inStreams.get(m.s)?.enqueue(m.d);
					} catch {
						// cancelled by the engine
					}
					return;
				case "ufin":
				case "ureset": {
					const c = this.inStreams.get(m.s);
					this.inStreams.delete(m.s);
					try {
						if (m.t === "ufin") c?.close();
						else c?.error(wtError("the server reset the stream", "stream", m.code ?? 0));
					} catch {
						// cancelled by the engine
					}
					return;
				}
				case "uopened":
					return this.settle(`open${m.s}`);
				case "uopenerr":
					return this.settle(`open${m.s}`, wtError(m.message));
				case "uack":
					return this.outStreams.get(m.s)?.ack(m.n);
				case "uclosed":
					return this.settle(`close${m.s}`);
				case "uerr": {
					const err = wtError(m.message, "stream", m.code ?? 0);
					this.outStreams.get(m.s)?.fail(err);
					return this.settle(`close${m.s}`, err);
				}
				case "stats":
					return this.settle(`stats${m.q}`, null, m.v);
				default:
			}
		}

		finish(error, info) {
			if (this.state === "closed") return;
			const wasConnecting = this.state === "connecting";
			this.state = "closed";
			const err = error || wtError("the WebTransport session is closed");
			if (wasConnecting) this.rejectReady(err);
			if (error) this.rejectClosed(error);
			else this.resolveClosed(info);
			const end = (c) => {
				try {
					if (error) c.error(error);
					else c.close();
				} catch {
					// already closed
				}
			};
			Object.values(this.controllers).forEach(end);
			this.inStreams.forEach(end);
			this.inStreams.clear();
			this.outStreams.forEach((s) => s.fail(err));
			this.pending.forEach((p) => p.reject(err));
			this.pending.clear();
			setTimeout(() => this.channel.close(), 1000);
		}

		async createUnidirectionalStream() {
			await this.ready;
			if (this.state !== "open") throw wtError("the WebTransport session is not open");
			const s = this.nextOut++;
			await this.request(`open${s}`, { t: "uopen", s });
			const st = {
				unacked: 0,
				waiters: [],
				error: null,
				wake: () => st.waiters.splice(0).forEach((w) => w()),
				ack: (n) => {
					st.unacked -= n;
					if (st.unacked < STREAM_WINDOW) st.wake();
				},
				fail: (e) => {
					st.error ||= e;
					st.wake();
				},
			};
			this.outStreams.set(s, st);
			return new WritableStream({
				write: async (chunk) => {
					if (st.error) throw st.error;
					const d = plain(chunk);
					st.unacked += d.byteLength;
					this.post({ t: "uw", s, d });
					while (st.unacked >= STREAM_WINDOW && !st.error) await new Promise((r) => st.waiters.push(r));
					if (st.error) throw st.error;
				},
				close: async () => {
					if (st.error) throw st.error;
					await this.request(`close${s}`, { t: "uclose", s });
					this.outStreams.delete(s);
				},
				abort: (reason) => {
					this.outStreams.delete(s);
					this.post({ t: "uabort", s, code: Number.isInteger(reason?.streamErrorCode) ? reason.streamErrorCode : 0 });
				},
			});
		}

		createBidirectionalStream() {
			return Promise.reject(wtError("bidirectional streams are not supported through the Wisp tunnel"));
		}

		close(info = {}) {
			if (this.state === "closed") return;
			const closeCode = Number.isInteger(info?.closeCode) ? info.closeCode : 0;
			const reason = String(info?.reason ?? "").slice(0, 1024);
			this.post({ t: "close", code: closeCode, reason });
			if (this.state === "connecting") return this.finish(wtError("the WebTransport session was closed before it was ready"));
			// The tunnel answers with "closed"; don't hang if it never does.
			setTimeout(() => this.finish(null, { closeCode, reason }), 3000);
		}

		async getStats() {
			if (this.state !== "open") return EMPTY_STATS();
			const q = this.nextRequest++;
			const v = await Promise.race([this.request(`stats${q}`, { t: "stats", q }).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2000))]);
			if (!v) return EMPTY_STATS();
			return { ...v, datagrams: { ...EMPTY_STATS().datagrams, ...v.datagrams, droppedIncoming: (v.datagrams?.droppedIncoming || 0) + this.droppedIncoming } };
		}
	}

	// ---- the WebTransport the engine sees -----------------------------------------------------

	// Streams handed out before a connection is chosen (auto mode), joined to it once it is.
	const placeholder = (facade) => {
		const dgIn = new TransformStream();
		const dgOut = new TransformStream();
		const uniIn = new TransformStream();
		const bidiIn = new TransformStream();
		return {
			datagrams: {
				readable: dgIn.readable,
				writable: dgOut.writable,
				get maxDatagramSize() {
					return facade._target?.datagrams?.maxDatagramSize ?? 1200;
				},
				incomingHighWaterMark: 256,
				outgoingHighWaterMark: 256,
				incomingMaxAge: null,
				outgoingMaxAge: null,
			},
			incomingUnidirectionalStreams: uniIn.readable,
			incomingBidirectionalStreams: bidiIn.readable,
			attach(t) {
				t.datagrams.readable.pipeTo(dgIn.writable).catch(() => {});
				dgOut.readable.pipeTo(t.datagrams.writable).catch(() => {});
				t.incomingUnidirectionalStreams.pipeTo(uniIn.writable).catch(() => {});
				t.incomingBidirectionalStreams.pipeTo(bidiIn.writable).catch(() => {});
			},
			fail(err) {
				for (const w of [dgIn.writable, uniIn.writable, bidiIn.writable]) w.abort(err).catch(() => {});
				dgOut.readable.cancel(err).catch(() => {});
			},
		};
	};

	class ShimWebTransport {
		constructor(url, options = {}) {
			let target;
			try {
				target = new URL(url, scope.location?.href);
			} catch {
				throw new DOMException(`Invalid URL: ${url}`, "SyntaxError");
			}
			if (target.protocol !== "https:") throw new DOMException("WebTransport URLs must use https", "SyntaxError");
			this._url = target.href;
			this._options = options || {};
			this._target = null;
			this._placeholder = null;
			this._attempts = [];
			this._state = "connecting";
			this._t0 = now();
			this.ready = new Promise((resolve, reject) => {
				this._resolveReady = resolve;
				this._rejectReady = reject;
			});
			this.closed = new Promise((resolve, reject) => {
				this._resolveClosed = resolve;
				this._rejectClosed = reject;
			});
			this.draining = new Promise((resolve) => (this._resolveDraining = resolve));
			this.ready.catch(() => {});
			this.closed.catch(() => {});
			this._route().catch((err) => this._fail(wtError(err?.message || String(err))));
		}

		async _route() {
			const config = await askConfig();
			if (this._state !== "connecting") return;
			let mode = config?.mode || "direct";
			if (mode === "auto" && config.preferTunnel) mode = "wisp";
			if (mode === "direct") return this._adopt(new Native(this._url, this._options), "direct");
			if (mode === "wisp") return this._adopt(new TunnelSession(this._url, this._options), "wisp");
			this._auto(Math.max(500, config.fallbackMs || 3000));
		}

		// Direct first; through Wisp as soon as direct fails, or when it is slow to connect.
		_auto(fallbackMs) {
			let settled = false;
			const attempts = this._attempts;
			let timer = null;
			const failAll = () => {
				settled = true;
				clearTimeout(timer);
				this._fail(wtError(attempts.map((a) => `${a.via === "direct" ? "direct" : "through Wisp"}: ${a.error?.message || a.error}`).join("; ")));
			};
			const startTunnel = (why, error = "") => {
				if (settled || this._state !== "connecting" || attempts.some((a) => a.via === "wisp")) return;
				report("wt-fallback", { url: maskUrl(this._url), why, error, ms: Math.round(now() - this._t0) });
				add("wisp", () => new TunnelSession(this._url, this._options));
			};
			const add = (via, make) => {
				const a = { via, t: null, error: null };
				attempts.push(a);
				const onFail = (err) => {
					a.error = err || wtError("failed");
					if (settled) return;
					if (via === "direct") startTunnel("failed", String(a.error?.message || a.error).slice(0, 200));
					if (attempts.every((x) => x.error)) failAll();
				};
				try {
					a.t = make();
				} catch (err) {
					queueMicrotask(() => onFail(err));
					return;
				}
				a.t.ready.then(() => {
					if (settled) {
						if (this._target !== a.t) closeQuietly(a.t);
						return;
					}
					settled = true;
					clearTimeout(timer);
					for (const other of attempts) if (other !== a) closeQuietly(other.t);
					if (via === "wisp") control.postMessage({ t: "outcome", client: clientId(), via, directFailed: !!attempts[0].error });
					this._adopt(a.t, via);
				}, onFail);
			};
			add("direct", () => new Native(this._url, this._options));
			timer = setTimeout(() => startTunnel("slow"), fallbackMs);
		}

		_adopt(t, via) {
			if (this._state !== "connecting") return closeQuietly(t);
			this._target = t;
			this._via = via;
			this._placeholder?.attach(t);
			t.ready.then(
				() => {
					if (this._state !== "connecting") return;
					this._state = "open";
					report("wt-route", { url: maskUrl(this._url), via, ms: Math.round(now() - this._t0) });
					this._resolveReady();
				},
				(err) => this._fail(err),
			);
			t.closed.then(
				(info) => {
					this._state = "closed";
					this._resolveClosed(info);
				},
				(err) => this._fail(err),
			);
			t.draining?.then?.(this._resolveDraining, () => {});
		}

		_fail(err) {
			if (this._state === "closed") return;
			const wasConnecting = this._state === "connecting";
			this._state = "closed";
			if (wasConnecting) this._rejectReady(err);
			this._rejectClosed(err);
			this._placeholder?.fail(err);
		}

		_parts() {
			if (this._placeholder) return this._placeholder;
			if (this._target) return this._target;
			return (this._placeholder = placeholder(this));
		}

		get datagrams() {
			return this._parts().datagrams;
		}

		get incomingUnidirectionalStreams() {
			return this._parts().incomingUnidirectionalStreams;
		}

		get incomingBidirectionalStreams() {
			return this._parts().incomingBidirectionalStreams;
		}

		get reliability() {
			return this._target?.reliability ?? "pending";
		}

		get congestionControl() {
			return this._target?.congestionControl ?? "default";
		}

		get protocol() {
			return this._target?.protocol ?? "";
		}

		async createUnidirectionalStream(options) {
			await this.ready;
			return this._target.createUnidirectionalStream(options);
		}

		async createBidirectionalStream(options) {
			await this.ready;
			return this._target.createBidirectionalStream(options);
		}

		// Only present when the connection underneath has it: Chromium's own WebTransport has no
		// getStats() yet, and the engine checks for the method before polling it.
		get getStats() {
			const t = this._target;
			if (t && typeof t.getStats !== "function") return undefined;
			return () => (t && this._state !== "connecting" ? t.getStats() : Promise.resolve(EMPTY_STATS()));
		}

		close(info) {
			if (this._state === "closed") return;
			if (this._target) return this._target.close(info);
			for (const a of this._attempts) closeQuietly(a.t);
			this._fail(wtError("the WebTransport session was closed before it was ready"));
		}
	}
	ShimWebTransport.__webbloxShim = true;
	scope.WebTransport = ShimWebTransport;
	return true;
}
