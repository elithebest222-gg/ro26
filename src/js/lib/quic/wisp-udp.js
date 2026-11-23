// A UDP stream through a Wisp server, on a WebSocket of its own. Speaks Wisp v1 and v2 (UDP
// extension). epoxy can also open UDP streams, but it shares one WebSocket with every HTTP
// request, so game packets would wait behind asset downloads.
//
// Packets: type u8, stream id u32 LE, payload.
//   CONNECT 0x01  stream type u8 (0x02 = UDP), port u16 LE, host (UTF-8)
//   DATA    0x02  one datagram
//   CONTINUE 0x03 buffer size u32 LE (TCP flow control; ignored for UDP)
//   CLOSE   0x04  reason u8
//   INFO    0x05  (v2) major u8, minor u8, then extensions: id u8, length u32 LE, payload

const PACKET = { connect: 0x01, data: 0x02, cont: 0x03, close: 0x04, info: 0x05 };
const EXT = { udp: 0x01, password: 0x02 };
const MAX_BUFFERED = 2 * 1024 * 1024; // past this, drop datagrams rather than queue them (UDP semantics)

const REASONS = {
	0x01: "the stream closed for an unknown reason",
	0x02: "the stream was closed",
	0x03: "a network error closed the stream",
	0x04: "the Wisp server and webblox have no extensions in common",
	0x41: "the Wisp server rejected the destination",
	0x42: "the Wisp server cannot reach the game server",
	0x43: "the game server did not answer the Wisp server",
	0x44: "the game server refused the Wisp server's connection",
	0x47: "the connection through the Wisp server timed out",
	0x48: "the Wisp server blocks this destination (UDP may be turned off there)",
	0x49: "the Wisp server is throttling connections",
	0x81: "the stream failed on this side",
	0xc0: "the Wisp server rejected the password",
	0xc1: "the Wisp server rejected the certificate",
	0xc2: "the Wisp server requires signing in",
};

export class WispError extends Error {
	constructor(message, reason = 0) {
		super(message);
		this.name = "WispError";
		this.reason = reason;
	}
}

export const wispReason = (code) => REASONS[code] || `the Wisp server closed the stream (reason 0x${code.toString(16)})`;

function packet(type, stream, payload) {
	const out = new Uint8Array(5 + payload.length);
	out[0] = type;
	new DataView(out.buffer).setUint32(1, stream, true);
	out.set(payload, 5);
	return out;
}

/**
 * Opens a UDP stream to host:port through the Wisp server. Resolves once the Wisp handshake is
 * done and the stream is requested. Wisp has no success reply for UDP: if the server cannot open
 * it, a CLOSE arrives later and `onclose` is called with a WispError.
 *
 * @returns {Promise<{send(data: Uint8Array): boolean, close(): void, onmessage: ((d: Uint8Array) => void)|null,
 *   onclose: ((err: WispError) => void)|null, version: number, closed: boolean, dropped: number}>}
 */
export function openWispUdp(wispUrl, host, port, { WebSocket: WS = globalThis.WebSocket, timeout = 10000 } = {}) {
	return new Promise((resolve, reject) => {
		const STREAM = 1;
		let ws;
		try {
			ws = new WS(wispUrl);
		} catch (err) {
			reject(new WispError(`the Wisp server address is invalid (${err.message})`));
			return;
		}
		ws.binaryType = "arraybuffer";
		let stage = "hello";
		const sock = {
			version: 1,
			closed: false,
			dropped: 0,
			onmessage: null,
			onclose: null,
			send(data) {
				if (sock.closed || ws.readyState !== 1) return false;
				if (ws.bufferedAmount > MAX_BUFFERED) {
					sock.dropped++;
					return false;
				}
				ws.send(packet(PACKET.data, STREAM, data));
				return true;
			},
			close() {
				if (sock.closed) return;
				sock.closed = true;
				try {
					if (ws.readyState === 1) ws.send(packet(PACKET.close, STREAM, new Uint8Array([0x02])));
					ws.close(1000);
				} catch {
					// already closing
				}
			},
		};
		const end = (err) => {
			clearTimeout(timer);
			if (stage !== "open") {
				stage = "failed";
				try {
					ws.close();
				} catch {
					// not open
				}
				reject(err);
				return;
			}
			if (sock.closed) return;
			sock.closed = true;
			try {
				ws.close();
			} catch {
				// not open
			}
			sock.onclose?.(err);
		};
		const timer = setTimeout(() => end(new WispError(`the Wisp server did not finish its handshake within ${timeout / 1000}s`)), timeout);

		ws.onerror = () => end(new WispError("could not connect to the Wisp server"));
		ws.onclose = (e) => end(new WispError(stage === "open" ? "the Wisp server closed the connection" : `the Wisp server closed the connection during its handshake${e?.code ? ` (${e.code})` : ""}`, 0x03));
		ws.onmessage = (e) => {
			if (typeof e.data === "string") return;
			const p = new Uint8Array(e.data);
			if (p.length < 5) return;
			const type = p[0];
			const stream = new DataView(p.buffer, p.byteOffset).getUint32(1, true);
			if (stage === "open") {
				if (stream !== STREAM) return;
				if (type === PACKET.data) sock.onmessage?.(p.subarray(5));
				else if (type === PACKET.close) end(new WispError(wispReason(p[5] ?? 0x01), p[5] ?? 0x01));
				return;
			}
			if (type === PACKET.info && stage === "hello") {
				// Wisp v2: answer with our own INFO, asking for the UDP extension.
				const exts = new Map();
				let at = 7;
				if (p[5] !== 2) return end(new WispError(`the Wisp server speaks an unsupported version (${p[5]}.${p[6]})`));
				while (at + 5 <= p.length) {
					const id = p[at];
					const len = new DataView(p.buffer, p.byteOffset + at + 1).getUint32(0, true);
					exts.set(id, p.subarray(at + 5, at + 5 + len));
					at += 5 + len;
				}
				if (exts.get(EXT.password)?.[0]) return end(new WispError("the Wisp server requires a password, which webblox does not support", 0xc2));
				if (!exts.has(EXT.udp)) return end(new WispError("the Wisp server does not allow UDP, which the game connection needs", 0x48));
				ws.send(packet(PACKET.info, 0, new Uint8Array([2, 0, EXT.udp, 0, 0, 0, 0])));
				sock.version = 2;
				stage = "continue";
			} else if (type === PACKET.cont && stream === 0) {
				const hostBytes = new TextEncoder().encode(host);
				const connect = new Uint8Array(3 + hostBytes.length);
				connect[0] = 0x02; // UDP
				connect[1] = port & 0xff;
				connect[2] = port >> 8;
				connect.set(hostBytes, 3);
				ws.send(packet(PACKET.connect, STREAM, connect));
				stage = "open";
				clearTimeout(timer);
				resolve(sock);
			} else if (type === PACKET.close) {
				end(new WispError(wispReason(p[5] ?? 0x01), p[5] ?? 0x01));
			}
		};
	});
}
