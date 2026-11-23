// WebTransport over HTTP/3, on top of the userland QUIC client, exposing the same API as the
// browser's WebTransport class (the parts Roblox's engine uses): ready, closed, close(),
// datagrams.{readable, writable, maxDatagramSize}, createUnidirectionalStream(),
// incomingUnidirectionalStreams, getStats().
//
// HTTP/3 (RFC 9114) with QPACK limited to the static table and literals (RFC 9204), the extended
// CONNECT handshake and stream/datagram framing of draft-ietf-webtrans-http3.

import { Reader, Writer, fromHex, utf8 } from "./bytes.js";
import { QuicConnection } from "./connection.js";

const FRAME = { data: 0x00, headers: 0x01, settings: 0x04, goaway: 0x07 };
const UNI = { control: 0x00, qpackEncoder: 0x02, qpackDecoder: 0x03, webtransport: 0x54 };
const SETTINGS = [
	[0x01, 0], // QPACK_MAX_TABLE_CAPACITY
	[0x07, 0], // QPACK_BLOCKED_STREAMS
	[0x33, 1], // H3_DATAGRAM
	[0xffd277, 1], // H3_DATAGRAM (draft 04)
	[0x2b603742, 1], // ENABLE_WEBTRANSPORT (draft 02)
	[0xc671706a, 1], // WEBTRANSPORT_MAX_SESSIONS
];
const H3_NO_ERROR = 0x100;
const CLOSE_SESSION_CAPSULE = 0x2843;

export class WebTransportError extends Error {
	constructor(message, { source = "session", streamErrorCode = null } = {}) {
		super(message);
		this.name = "WebTransportError";
		this.source = source;
		this.streamErrorCode = streamErrorCode;
	}
}

// ---- QPACK, just enough ------------------------------------------------------------------------

function prefixInt(w, value, bits, flags) {
	const max = (1 << bits) - 1;
	if (value < max) {
		w.u8(flags | value);
		return;
	}
	w.u8(flags | max);
	value -= max;
	while (value >= 128) {
		w.u8((value & 0x7f) | 0x80);
		value = Math.floor(value / 128);
	}
	w.u8(value);
}

function readPrefixInt(r, first, bits) {
	const max = (1 << bits) - 1;
	let v = first & max;
	if (v < max) return v;
	let shift = 0;
	for (;;) {
		const b = r.u8();
		v += (b & 0x7f) * 2 ** shift;
		shift += 7;
		if (!(b & 0x80)) return v;
	}
}

// Every field as a literal with a literal name: valid for any QPACK decoder, no tables needed.
function encodeHeaders(fields) {
	const w = new Writer(256);
	w.u8(0).u8(0); // Required Insert Count 0, Delta Base 0
	for (const [name, value] of fields) {
		const n = utf8(name);
		const v = utf8(value);
		prefixInt(w, n.length, 3, 0x20);
		w.bytes(n);
		prefixInt(w, v.length, 7, 0x00);
		w.bytes(v);
	}
	return w.done();
}

// Static table entries for :status (RFC 9204 appendix A).
const STATUS_STATIC = { 24: "103", 25: "200", 26: "304", 27: "404", 28: "503", 63: "100", 64: "204", 65: "206", 66: "302", 67: "400", 68: "403", 69: "421", 70: "425", 71: "500" };
// HPACK Huffman codes for the digits, which is all a status code needs (RFC 7541 appendix B).
const DIGIT_CODES = [
	[0b00000, 5],
	[0b00001, 5],
	[0b00010, 5],
	[0b011001, 6],
	[0b011010, 6],
	[0b011011, 6],
	[0b011100, 6],
	[0b011101, 6],
	[0b011110, 6],
	[0b011111, 6],
];

function huffmanDigits(bytes) {
	let bits = "";
	for (const b of bytes) bits += b.toString(2).padStart(8, "0");
	let out = "";
	let at = 0;
	outer: while (at < bits.length) {
		for (let d = 0; d < 10; d++) {
			const [code, len] = DIGIT_CODES[d];
			if (at + len <= bits.length && parseInt(bits.slice(at, at + len), 2) === code) {
				out += d;
				at += len;
				continue outer;
			}
		}
		break; // remaining bits are EOS padding (all ones) or not a digit
	}
	return out;
}

function readString(r) {
	const first = r.u8();
	const huffman = !!(first & 0x80);
	const len = readPrefixInt(r, first, 7);
	const bytes = r.bytes(len);
	return huffman ? { huffman, bytes } : { huffman, text: new TextDecoder().decode(bytes) };
}

// Pulls :status out of a QPACK field section; null if it cannot be read.
function statusOf(block) {
	const r = new Reader(block);
	r.u8();
	r.u8(); // Required Insert Count, Delta Base (dynamic table unused)
	while (r.left) {
		const first = r.u8();
		if (first & 0x80) {
			const index = readPrefixInt(r, first, 6);
			if (first & 0x40 && STATUS_STATIC[index]) return STATUS_STATIC[index];
		} else if (first & 0x40) {
			const index = readPrefixInt(r, first, 4);
			const value = readString(r);
			if (first & 0x10 && STATUS_STATIC[index]) return value.huffman ? huffmanDigits(value.bytes) : value.text;
		} else if (first & 0x20) {
			const nameLen = readPrefixInt(r, first, 3);
			const name = first & 0x08 ? null : new TextDecoder().decode(r.bytes(nameLen));
			if (first & 0x08) r.bytes(nameLen);
			const value = readString(r);
			if (name === ":status") return value.huffman ? huffmanDigits(value.bytes) : value.text;
		} else if ((first & 0xf0) === 0x10) {
			readPrefixInt(r, first, 4);
		} else {
			readPrefixInt(r, first, 3);
			readString(r);
		}
	}
	return null;
}

// ---- WebTransport session ----------------------------------------------------------------------

/**
 * @param {string} url
 * @param {{serverCertificateHashes?: {algorithm: string, value: BufferSource}[],
 *          verifyChain?: (chain: Uint8Array[], host: string) => Promise<unknown>}} options
 *        verifyChain (not part of the browser API) checks the server's certificate chain when no
 *        hashes are pinned, as the browser would with its own trust store
 * @param {{send(data: Uint8Array): void, onReceive(cb: (data: Uint8Array) => void): void, close(): void}} udp
 * @param {string} origin  value of the Origin header (the page's origin)
 */
export class TunnelWebTransport {
	constructor(url, options = {}, udp, origin) {
		const target = new URL(url);
		if (target.protocol !== "https:") throw new TypeError("WebTransport URL must use https");
		const hashes = (options.serverCertificateHashes || [])
			.filter((h) => String(h.algorithm).toLowerCase() === "sha-256")
			.map((h) => new Uint8Array(h.value instanceof ArrayBuffer ? h.value : h.value.buffer.slice(h.value.byteOffset, h.value.byteOffset + h.value.byteLength)));
		this.udp = udp;
		this.sessionId = 0;
		this.uniStreams = new Map(); // incoming id -> { controller, header: Uint8Array|null, kind }
		this.controlBuf = new Uint8Array(0);
		this.connectBuf = new Uint8Array(0);
		this.state = "connecting";

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

		let incomingController;
		this.incomingUnidirectionalStreams = new ReadableStream({ start: (c) => (incomingController = c) }, { highWaterMark: 64 });
		this.incomingController = incomingController;
		this.incomingBidirectionalStreams = new ReadableStream({ start: () => {} });

		let dgController;
		const readable = new ReadableStream({ start: (c) => (dgController = c) }, { highWaterMark: 256 });
		this.dgController = dgController;
		const writable = new WritableStream({
			write: (chunk) => {
				const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
				const w = new Writer(data.length + 8).varint(this.sessionId / 4).bytes(data);
				if (!this.conn.sendDatagram(w.done())) throw new WebTransportError("datagram could not be sent");
			},
		});
		const self = this;
		this.datagrams = {
			readable,
			writable,
			get maxDatagramSize() {
				return Math.max(0, self.conn.maxDatagramPayload - 1);
			},
			incomingHighWaterMark: 256,
			outgoingHighWaterMark: 256,
			incomingMaxAge: null,
			outgoingMaxAge: null,
		};

		this.conn = new QuicConnection({
			serverName: target.hostname.replace(/^\[|\]$/g, ""),
			certHashes: hashes,
			verifyChain: options.verifyChain,
			sendDatagram: (d) => udp.send(d),
			events: {
				streamOpen: (id) => this.onStreamOpen(id),
				streamData: (id, data, fin) => this.onStreamData(id, data, fin),
				streamReset: (id, code) => this.onStreamReset(id, code),
				datagram: (d) => this.onDatagram(d),
				closed: (info) => this.onClosed(info),
			},
		});
		udp.onReceive((d) => this.conn.receive(d));
		this.start(target, origin).catch((err) => this.fail(err));
	}

	async start(target, origin) {
		await this.conn.connect();
		// Control stream with our SETTINGS, then the (unused) QPACK streams.
		const control = await this.conn.openStream(false);
		const settings = new Writer(64);
		for (const [id, value] of SETTINGS) settings.varint(id).varint(value);
		const s = settings.done();
		this.conn.write(control, new Writer(64).varint(UNI.control).varint(FRAME.settings).varint(s.length).bytes(s).done());
		this.conn.write(await this.conn.openStream(false), new Uint8Array([UNI.qpackEncoder]));
		this.conn.write(await this.conn.openStream(false), new Uint8Array([UNI.qpackDecoder]));

		this.sessionId = await this.conn.openStream(true);
		const headers = encodeHeaders([
			[":method", "CONNECT"],
			[":protocol", "webtransport"],
			[":scheme", "https"],
			[":authority", target.host],
			[":path", `${target.pathname}${target.search}`],
			["origin", origin],
			["sec-webtransport-http3-draft02", "1"],
		]);
		this.conn.write(this.sessionId, new Writer(headers.length + 8).varint(FRAME.headers).varint(headers.length).bytes(headers).done());
	}

	fail(err) {
		const e = err instanceof WebTransportError ? err : new WebTransportError(err?.message || String(err));
		if (this.state === "connecting") this.rejectReady(e);
		if (this.state !== "closed") {
			this.state = "closed";
			this.rejectClosed(e);
			this.errorStreams(e);
			this.conn.close(H3_NO_ERROR, e.message.slice(0, 60));
			setTimeout(() => this.udp.close(), 100);
		}
	}

	errorStreams(e) {
		for (const s of this.uniStreams.values()) {
			try {
				s.controller?.error(e);
			} catch {
				// already closed
			}
		}
		for (const c of [this.incomingController, this.dgController]) {
			try {
				c.error(e);
			} catch {
				// already closed
			}
		}
	}

	onClosed(info) {
		if (this.state === "closed") return;
		const wasConnecting = this.state === "connecting";
		this.state = "closed";
		setTimeout(() => this.udp.close(), 100);
		const graceful = !info.error && (info.code === H3_NO_ERROR || info.code === 0) && !info.idle;
		if (graceful && !wasConnecting) {
			this.resolveClosed({ closeCode: this.closeCode ?? 0, reason: this.closeReason ?? info.reason ?? "" });
			for (const c of [this.incomingController, this.dgController]) {
				try {
					c.close();
				} catch {
					// already closed
				}
			}
			return;
		}
		const e = new WebTransportError(info.error?.message || info.reason || (info.idle ? "connection timed out" : "connection closed"));
		if (wasConnecting) this.rejectReady(e);
		this.rejectClosed(e);
		this.errorStreams(e);
	}

	// ---- incoming HTTP/3 traffic -------------------------------------------------------------

	onStreamOpen(id) {
		if ((id & 2) === 0) {
			// Peer-initiated bidirectional streams are not used by the engine.
			this.conn.stopSending(id, 0x10b);
			this.conn.resetStream(id, 0x10b);
			return;
		}
		this.uniStreams.set(id, { header: new Uint8Array(0), kind: null, controller: null });
	}

	onStreamData(id, data, fin) {
		if (id === this.sessionId) return this.onConnectStream(data, fin);
		const s = this.uniStreams.get(id);
		if (!s) return;
		if (s.kind === null) {
			// Stream type, and for WebTransport streams the session id, prefix the data.
			const buf = new Uint8Array(s.header.length + data.length);
			buf.set(s.header);
			buf.set(data, s.header.length);
			const r = new Reader(buf);
			try {
				const type = r.varint();
				if (type === UNI.webtransport) {
					const session = r.varint();
					if (session !== this.sessionId) {
						s.kind = "ignored";
						this.conn.stopSending(id, 0x10b);
						return;
					}
					s.kind = "wt";
					let controller;
					const stream = new ReadableStream({ start: (c) => (controller = c), cancel: () => this.conn.stopSending(id, 0) });
					s.controller = controller;
					this.incomingController.enqueue(stream);
				} else s.kind = type === UNI.control ? "control" : "ignored";
			} catch {
				s.header = buf; // the prefix has not fully arrived yet
				if (fin) this.uniStreams.delete(id);
				return;
			}
			data = buf.subarray(r.pos);
		}
		if (s.kind === "wt") {
			if (data.length) s.controller.enqueue(data);
			if (fin) {
				s.controller.close();
				this.uniStreams.delete(id);
			}
		} else if (s.kind === "control") {
			this.controlBuf = joinBytes(this.controlBuf, data);
			this.controlBuf = this.readFrames(this.controlBuf, (type, payload) => {
				if (type === FRAME.goaway) this.fail(new WebTransportError("server is going away"));
				void payload;
			});
		}
		if (fin && s.kind !== "wt") this.uniStreams.delete(id);
	}

	onStreamReset(id, code) {
		const s = this.uniStreams.get(id);
		if (s?.controller) s.controller.error(new WebTransportError("stream reset by server", { source: "stream", streamErrorCode: code }));
		this.uniStreams.delete(id);
		if (id === this.sessionId) this.fail(new WebTransportError("session stream reset by server"));
	}

	onConnectStream(data, fin) {
		this.connectBuf = joinBytes(this.connectBuf, data);
		this.connectBuf = this.readFrames(this.connectBuf, (type, payload) => {
			if (type === FRAME.headers && this.state === "connecting") {
				let status = null;
				try {
					status = statusOf(payload);
				} catch {
					status = null;
				}
				if (status && /^2\d\d$/.test(status)) {
					this.state = "open";
					this.resolveReady();
				} else this.fail(new WebTransportError(`server refused the WebTransport session (status ${status ?? "unreadable"})`));
			} else if (type === FRAME.data) {
				// Capsules: CLOSE_WEBTRANSPORT_SESSION carries the close code and reason.
				const r = new Reader(payload);
				try {
					while (r.left) {
						const ctype = r.varint();
						const body = r.bytes(r.varint());
						if (ctype === CLOSE_SESSION_CAPSULE) {
							const br = new Reader(body);
							this.closeCode = br.u32();
							this.closeReason = new TextDecoder().decode(br.bytes(br.left));
						}
					}
				} catch {
					// partial capsule: ignore
				}
			}
		});
		if (fin && this.state !== "closed") {
			this.state = "closing";
			this.conn.close(H3_NO_ERROR, "");
		}
	}

	// Parses complete HTTP/3 frames from a buffer; returns the unparsed remainder.
	readFrames(buf, onFrame) {
		let at = 0;
		for (;;) {
			const r = new Reader(buf, at);
			let type;
			let payload;
			try {
				type = r.varint();
				const len = r.varint();
				payload = r.bytes(len);
			} catch {
				break;
			}
			at = r.pos;
			onFrame(type, payload);
		}
		return buf.subarray(at);
	}

	onDatagram(d) {
		try {
			const r = new Reader(d);
			if (r.varint() * 4 !== this.sessionId) return;
			if ((this.dgController.desiredSize ?? 1) > -1024) this.dgController.enqueue(d.subarray(r.pos));
		} catch {
			// malformed or the readable was closed
		}
	}

	// ---- outgoing ----------------------------------------------------------------------------

	async createUnidirectionalStream() {
		await this.ready;
		const id = await this.conn.openStream(false);
		this.conn.write(id, new Writer(8).varint(UNI.webtransport).varint(this.sessionId).done());
		return new WritableStream({
			write: async (chunk) => {
				this.conn.write(id, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
				await this.drained(id);
			},
			close: () => this.conn.write(id, null, true),
			abort: (reason) => this.conn.resetStream(id, typeof reason?.streamErrorCode === "number" ? reason.streamErrorCode : 0),
		});
	}

	createBidirectionalStream() {
		return Promise.reject(new WebTransportError("bidirectional streams are not supported by this tunnel"));
	}

	// Simple backpressure: wait while a stream has a lot buffered.
	async drained(id) {
		for (let i = 0; i < 200; i++) {
			const s = this.conn.streams.get(id);
			if (!s || s.sendBuffered < 256 * 1024 || this.state === "closed") return;
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	close({ closeCode = 0, reason = "" } = {}) {
		if (this.state === "closed" || this.state === "closing") return;
		this.closeCode = closeCode;
		this.closeReason = reason;
		if (this.state === "connecting") {
			this.fail(new WebTransportError("session closed before it was ready"));
			return;
		}
		this.state = "closing";
		const r = utf8(reason).subarray(0, 1024);
		const capsule = new Writer(r.length + 16).varint(CLOSE_SESSION_CAPSULE).varint(4 + r.length).u32(closeCode >>> 0).bytes(r).done();
		try {
			this.conn.write(this.sessionId, new Writer(capsule.length + 8).varint(FRAME.data).varint(capsule.length).bytes(capsule).done(), true);
		} catch {
			// stream already finished
		}
		setTimeout(() => this.conn.close(H3_NO_ERROR, ""), 50);
	}

	async getStats() {
		const c = this.conn;
		return {
			smoothedRtt: c.smoothedRtt,
			minRtt: Number.isFinite(c.minRtt) ? c.minRtt : 0,
			rttVariation: c.rttVar,
			estimatedSendRate: null,
			packetsSent: c.stats.packetsSent,
			bytesSent: c.stats.bytesSent,
			packetsReceived: c.stats.packetsReceived,
			bytesReceived: c.stats.bytesReceived,
			packetsLost: c.stats.packetsLost,
			datagrams: { droppedIncoming: 0, expiredIncoming: 0, expiredOutgoing: 0, lostOutgoing: 0 },
		};
	}
}

function joinBytes(a, b) {
	if (!a.length) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

export { fromHex };
