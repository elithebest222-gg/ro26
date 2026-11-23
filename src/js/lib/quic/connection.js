// A QUIC v1 client connection (RFC 9000, 9001, 9002, 9221), written sans-IO: feed it UDP
// payloads with receive(), and it hands outgoing UDP payloads to the sendDatagram callback.
// Scope: what a WebTransport client needs. One path, no 0-RTT, no migration; simple NewReno-style
// congestion control and loss recovery.

import { Reader, Writer, concat, equalBytes } from "./bytes.js";
import { PacketKeys, initialKeys, randomBytes, retryTagValid } from "./crypto.js";
import { TP, TlsClient, encodeTransportParams } from "./tls.js";

const MAX_UDP = 1250; // what Chrome uses; every packet fits the smallest common path MTU
const INITIAL_DATAGRAM = 1200;
const LOCAL_WINDOW = 4 * 1024 * 1024;
const LOCAL_STREAM_WINDOW = 2 * 1024 * 1024;
const LOCAL_STREAMS_UNI = 256;
const LOCAL_STREAMS_BIDI = 16;
const IDLE_TIMEOUT_MS = 30000;
const KEEPALIVE_MS = 10000;
const ACK_DELAY_MS = 20;
const MAX_DATAGRAM_QUEUE = 256;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// Contiguous delivery of possibly overlapping, out-of-order byte ranges.
class Reassembler {
	constructor() {
		this.offset = 0;
		this.chunks = new Map();
	}

	push(offset, data) {
		if (offset + data.length <= this.offset) return [];
		if (offset < this.offset) {
			data = data.subarray(this.offset - offset);
			offset = this.offset;
		}
		const prev = this.chunks.get(offset);
		if (!prev || prev.length < data.length) this.chunks.set(offset, data);
		const out = [];
		for (;;) {
			let hit = this.chunks.get(this.offset);
			if (hit) this.chunks.delete(this.offset);
			else {
				for (const [o, d] of this.chunks) {
					if (o < this.offset && o + d.length > this.offset) {
						this.chunks.delete(o);
						hit = d.subarray(this.offset - o);
						break;
					}
				}
			}
			if (!hit) break;
			out.push(hit);
			this.offset += hit.length;
		}
		for (const [o, d] of this.chunks) if (o + d.length <= this.offset) this.chunks.delete(o);
		return out;
	}
}

class Space {
	constructor(name) {
		this.name = name;
		this.send = null;
		this.recv = null;
		this.nextPn = 0;
		this.largestRecv = -1;
		this.largestRecvTime = 0;
		this.ranges = []; // received packet numbers as [lo, hi], highest first
		this.ackNeeded = false;
		this.elicitingSinceAck = 0;
		this.sent = new Map(); // pn -> { time, size, eliciting, frames }
		this.largestAcked = -1;
		this.cryptoOut = [];
		this.cryptoOffset = 0;
		this.cryptoIn = new Reassembler();
		this.discarded = false;
	}

	addReceived(pn) {
		const r = this.ranges;
		for (let i = 0; i < r.length; i++) {
			const [lo, hi] = r[i];
			if (pn >= lo && pn <= hi) return false;
			if (pn === hi + 1) {
				r[i][1] = pn;
				if (i > 0 && r[i - 1][0] === pn + 1) {
					r[i - 1][0] = lo;
					r.splice(i, 1);
				}
				return true;
			}
			if (pn === lo - 1) {
				r[i][0] = pn;
				if (i + 1 < r.length && r[i + 1][1] === pn - 1) {
					r[i][0] = r[i + 1][0];
					r.splice(i + 1, 1);
				}
				return true;
			}
			if (pn > hi) {
				r.splice(i, 0, [pn, pn]);
				return true;
			}
		}
		r.push([pn, pn]);
		if (r.length > 64) r.length = 64;
		return true;
	}
}

class Stream {
	constructor(id, sendLimit, recvLimit) {
		this.id = id;
		this.local = (id & 1) === 0;
		this.uni = (id & 2) !== 0;
		this.canSend = !this.uni || this.local;
		this.canRecv = !this.uni || !this.local;
		// send side
		this.sendBuf = [];
		this.sendBuffered = 0;
		this.sendOffset = 0;
		this.retransmit = [];
		this.finQueued = false;
		this.finSent = false;
		this.peerMax = sendLimit;
		this.resetCode = null;
		this.unacked = 0; // STREAM frames sent and not yet acknowledged or declared lost
		this.finAcked = false;
		// receive side
		this.recv = new Reassembler();
		this.finalSize = null;
		this.recvHighest = 0;
		this.recvDone = false;
		this.window = recvLimit;
		this.advertised = recvLimit;
		this.needMaxStreamData = false;
	}
}

export class QuicError extends Error {
	constructor(message, code = 0, app = false) {
		super(message);
		this.code = code;
		this.app = app;
	}
}

export class QuicConnection {
	/**
	 * @param {object} o
	 * @param {(data: Uint8Array) => void} o.sendDatagram   send one UDP payload
	 * @param {string} o.serverName                         SNI
	 * @param {Uint8Array[]} o.certHashes                    pinned SHA-256 certificate hashes
	 * @param {object} o.events   { streamOpen(id), streamData(id, data, fin), streamReset(id, code),
	 *                              stopSending(id, code), datagram(data), closed(info) }
	 */
	constructor({ sendDatagram, serverName, certHashes, events }) {
		this.sendUdp = sendDatagram;
		this.events = events;
		this.scid = randomBytes(8);
		this.dcid = randomBytes(8);
		this.odcid = this.dcid;
		this.token = new Uint8Array(0);
		this.spaces = { initial: new Space("initial"), handshake: new Space("handshake"), app: new Space("app") };
		this.state = "connecting";
		this.queue = Promise.resolve();
		this.pending = []; // packets waiting for keys

		this.tls = new TlsClient({
			serverName,
			certHashes,
			transportParams: encodeTransportParams([
				[TP.maxIdleTimeout, IDLE_TIMEOUT_MS],
				[TP.initialMaxData, LOCAL_WINDOW],
				[TP.initialMaxStreamDataBidiLocal, LOCAL_STREAM_WINDOW],
				[TP.initialMaxStreamDataBidiRemote, LOCAL_STREAM_WINDOW],
				[TP.initialMaxStreamDataUni, LOCAL_STREAM_WINDOW],
				[TP.initialMaxStreamsBidi, LOCAL_STREAMS_BIDI],
				[TP.initialMaxStreamsUni, LOCAL_STREAMS_UNI],
				[TP.activeConnectionIdLimit, 2],
				[TP.initialSourceConnectionId, this.scid],
				[TP.maxDatagramFrameSize, 65535],
			]),
		});

		// flow control
		this.peerMaxData = 0;
		this.dataSent = 0;
		this.recvWindow = LOCAL_WINDOW;
		this.recvAdvertised = LOCAL_WINDOW;
		this.recvConsumed = 0;
		this.recvHighest = 0;
		this.needMaxData = false;

		// streams
		this.streams = new Map();
		this.nextUni = 2;
		this.nextBidi = 0;
		this.peerMaxStreamsUni = 0;
		this.peerMaxStreamsBidi = 0;
		this.localMaxStreamsUni = LOCAL_STREAMS_UNI;
		this.localMaxStreamsBidi = LOCAL_STREAMS_BIDI;
		this.peerStreamsDoneUni = 0;
		this.peerStreamsDoneBidi = 0;
		this.peerHighestUni = -1;
		this.peerHighestBidi = -1;
		this.needMaxStreams = { uni: false, bidi: false };
		this.streamWaiters = { uni: [], bidi: [] };

		// control frames waiting to go out
		this.control = [];
		this.datagrams = [];
		this.peerMaxDatagramFrame = 0;

		// recovery and congestion control
		this.smoothedRtt = 333;
		this.rttVar = 166;
		this.minRtt = Infinity;
		this.latestRtt = 0;
		this.ptoCount = 0;
		this.probe = false;
		this.cwnd = 14720;
		this.ssthresh = Infinity;
		this.inFlight = 0;
		this.recoveryStart = -1;
		this.peerAckDelayExponent = 3;
		this.peerMaxAckDelay = 25;
		this.idleTimeout = IDLE_TIMEOUT_MS;
		this.lastReceived = now();
		this.lastSent = now();
		this.timer = null;

		// connection IDs offered by the peer: seq -> cid
		this.peerCids = new Map([[0, this.dcid]]);
		this.dcidSeq = 0;

		this.stats = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, bytesReceived: 0, packetsLost: 0 };
		this.established = new Promise((resolve, reject) => {
			this.resolveEstablished = resolve;
			this.rejectEstablished = reject;
		});
		this.established.catch(() => {});
	}

	// ---- public API ---------------------------------------------------------------------------

	async connect() {
		const keys = await initialKeys(this.dcid);
		this.spaces.initial.send = keys.client;
		this.spaces.initial.recv = keys.server;
		this.clientHello = await this.tls.clientHello();
		this.queueCrypto(this.spaces.initial, this.clientHello);
		this.schedule();
		return this.established;
	}

	receive(datagram) {
		this.run(() => this.processDatagram(datagram));
	}

	// Opens a stream once the peer's stream limit allows it. Resolves with its id.
	openStream(bidi = false) {
		const kind = bidi ? "bidi" : "uni";
		return new Promise((resolve, reject) => {
			const tryOpen = () => {
				if (this.state === "closed") return reject(new QuicError("connection closed"));
				const index = bidi ? this.nextBidi >> 2 : (this.nextUni - 2) >> 2;
				const limit = bidi ? this.peerMaxStreamsBidi : this.peerMaxStreamsUni;
				if (index >= limit) return false;
				const id = bidi ? this.nextBidi : this.nextUni;
				if (bidi) this.nextBidi += 4;
				else this.nextUni += 4;
				const sendLimit = this.peerParams?.get(bidi ? TP.initialMaxStreamDataBidiRemote : TP.initialMaxStreamDataUni) ?? 0;
				this.streams.set(id, new Stream(id, sendLimit, LOCAL_STREAM_WINDOW));
				resolve(id);
				return true;
			};
			if (tryOpen() === false) this.streamWaiters[kind].push(tryOpen);
		});
	}

	write(id, data, fin = false) {
		const s = this.streams.get(id);
		if (!s || !s.canSend || s.finQueued || s.resetCode !== null) throw new QuicError(`stream ${id} is not writable`);
		if (data && data.length) {
			s.sendBuf.push(data);
			s.sendBuffered += data.length;
		}
		if (fin) s.finQueued = true;
		this.schedule();
	}

	resetStream(id, code = 0) {
		const s = this.streams.get(id);
		if (!s || !s.canSend || s.resetCode !== null) return;
		s.resetCode = code;
		s.sendBuf = [];
		s.sendBuffered = 0;
		s.retransmit = [];
		this.control.push({ t: "reset", id, code, finalSize: s.sendOffset });
		this.schedule();
	}

	stopSending(id, code = 0) {
		const s = this.streams.get(id);
		if (!s || !s.canRecv || s.recvDone) return;
		this.control.push({ t: "stop", id, code });
		this.schedule();
	}

	get maxDatagramPayload() {
		if (!this.peerMaxDatagramFrame) return 0;
		const overhead = 1 + this.dcid.length + 4 + 16 + 1 + 2; // header, pn, tag, frame type, length
		return Math.min(this.peerMaxDatagramFrame - 3, MAX_UDP - overhead);
	}

	sendDatagram(data) {
		if (this.state !== "established" || data.length > this.maxDatagramPayload) return false;
		this.datagrams.push(data);
		if (this.datagrams.length > MAX_DATAGRAM_QUEUE) this.datagrams.shift();
		this.schedule();
		return true;
	}

	close(code = 0, reason = "", app = true) {
		if (this.state === "closed" || this.state === "closing") return;
		this.closeInfo = { code, reason, app, local: true };
		this.state = "closing";
		this.schedule();
	}

	// ---- plumbing -----------------------------------------------------------------------------

	run(fn) {
		this.queue = this.queue.then(fn).catch((err) => this.fail(err));
		return this.queue;
	}

	schedule() {
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => this.run(() => this.flush()));
	}

	fail(err) {
		if (this.state === "closed") return;
		const e = err instanceof QuicError ? err : new QuicError(err?.message || String(err), 0x01);
		if (this.state === "established" || this.state === "connecting") {
			this.closeInfo = { code: e.code || 0x01, reason: e.message.slice(0, 100), app: false, local: true, error: e };
			this.state = "closing";
			this.run(() => this.flush());
		} else this.finish({ code: e.code, reason: e.message, local: true, error: e });
	}

	finish(info) {
		if (this.state === "closed") return;
		this.state = "closed";
		clearTimeout(this.timer);
		this.rejectEstablished(new QuicError(info.reason || "connection closed", info.code, info.app));
		for (const kind of ["uni", "bidi"]) for (const w of this.streamWaiters[kind].splice(0)) w();
		this.events.closed?.(info);
	}

	queueCrypto(space, data) {
		space.cryptoOut.push({ offset: space.cryptoOffset, data });
		space.cryptoOffset += data.length;
	}

	// ---- receiving ----------------------------------------------------------------------------

	async processDatagram(data) {
		if (this.state === "closed") return;
		this.stats.bytesReceived += data.length;
		let at = 0;
		while (at < data.length) {
			const first = data[at];
			if (!(first & 0x80)) {
				await this.processPacket(this.spaces.app, data.subarray(at), 1 + this.scid.length, false);
				break;
			}
			const r = new Reader(data, at + 1);
			const version = r.u32();
			r.bytes(r.u8());
			const scid = r.bytes(r.u8()).slice();
			if (version === 0) throw new QuicError("the server does not speak QUIC version 1", 0x0a);
			const type = (first >> 4) & 3;
			if (type === 3) {
				await this.processRetry(data.subarray(at), scid);
				return;
			}
			if (type === 0) r.bytes(r.varint());
			const length = r.varint();
			const end = r.pos + length;
			if (end > data.length) return;
			const space = type === 0 ? this.spaces.initial : type === 2 ? this.spaces.handshake : null;
			if (space) await this.processPacket(space, data.subarray(at, end), r.pos - at, true, scid);
			at = end;
		}
		this.schedule();
	}

	async processRetry(packet, scid) {
		if (this.retried || this.serverScid || this.state !== "connecting") return;
		const r = new Reader(packet, 5);
		r.bytes(r.u8());
		r.bytes(r.u8());
		const token = packet.slice(r.pos, packet.length - 16);
		if (!token.length || !(await retryTagValid(packet, this.odcid))) return;
		this.retried = true;
		this.retryScid = scid;
		this.token = token;
		this.dcid = scid;
		this.peerCids.set(0, scid);
		const keys = await initialKeys(this.dcid);
		const space = this.spaces.initial;
		space.send = keys.client;
		space.recv = keys.server;
		for (const p of space.sent.values()) if (p.eliciting) this.inFlight -= p.size;
		space.sent.clear();
		space.cryptoOut = [{ offset: 0, data: this.clientHello }];
		this.schedule();
	}

	async processPacket(space, packet, pnOffset, long, scid) {
		if (space.discarded) return;
		if (!space.recv) {
			if (this.pending.length < 16) this.pending.push([space, packet.slice(), pnOffset, long, scid]);
			return;
		}
		if (packet.length < pnOffset + 20) return;
		const p = packet.slice();
		const mask = await space.recv.mask(p.subarray(pnOffset + 4, pnOffset + 20));
		p[0] ^= mask[0] & (long ? 0x0f : 0x1f);
		const pnLen = (p[0] & 3) + 1;
		let truncated = 0;
		for (let i = 0; i < pnLen; i++) {
			p[pnOffset + i] ^= mask[1 + i];
			truncated = truncated * 256 + p[pnOffset + i];
		}
		const pn = decodePn(space.largestRecv, truncated, pnLen * 8);
		const header = p.subarray(0, pnOffset + pnLen);
		const body = p.subarray(pnOffset + pnLen);

		let keys = space.recv;
		let keyUpdate = false;
		if (!long) {
			const phase = (p[0] >> 2) & 1;
			if (phase !== this.recvPhase) {
				this.nextRecv ||= await space.recv.next();
				keys = this.nextRecv;
				keyUpdate = true;
			}
		}
		let payload;
		try {
			payload = await keys.open(pn, header, body);
		} catch {
			return; // not ours, corrupted, or keys out of step: drop it
		}
		if (keyUpdate) {
			this.recvPhase ^= 1;
			space.recv = this.nextRecv;
			this.nextRecv = null;
			if (this.sendPhase !== this.recvPhase) {
				space.send = await space.send.next();
				this.sendPhase = this.recvPhase;
			}
		}
		if (!space.addReceived(pn)) return; // duplicate
		this.stats.packetsReceived++;
		this.lastReceived = now();
		if (pn > space.largestRecv) {
			space.largestRecv = pn;
			space.largestRecvTime = this.lastReceived;
		}
		if (space.name === "initial" && !this.serverScid && scid) {
			this.serverScid = scid;
			this.dcid = scid;
			this.peerCids.set(0, scid);
		}
		const eliciting = await this.processFrames(space, payload);
		if (eliciting) {
			space.ackNeeded = true;
			space.elicitingSinceAck++;
		}
	}

	async processFrames(space, payload) {
		const r = new Reader(payload);
		let eliciting = false;
		while (r.left) {
			const type = r.varint();
			if (type !== 0x00 && type !== 0x02 && type !== 0x03 && type !== 0x1c && type !== 0x1d) eliciting = true;
			if (type === 0x00) continue;
			if (type === 0x01) continue;
			if (type === 0x02 || type === 0x03) {
				const largest = r.varint();
				const delay = r.varint();
				const count = r.varint();
				let hi = largest;
				let lo = largest - r.varint();
				const ranges = [[lo, hi]];
				for (let i = 0; i < count; i++) {
					hi = lo - r.varint() - 2;
					lo = hi - r.varint();
					ranges.push([lo, hi]);
				}
				if (type === 0x03) {
					r.varint();
					r.varint();
					r.varint();
				}
				this.onAck(space, ranges, delay);
			} else if (type === 0x04) {
				const id = r.varint();
				const code = r.varint();
				r.varint();
				const s = this.streams.get(id);
				if (s && !s.recvDone) {
					s.recvDone = true;
					this.streamFinished(s);
					this.events.streamReset?.(id, code);
				}
			} else if (type === 0x05) {
				const id = r.varint();
				const code = r.varint();
				this.events.stopSending?.(id, code);
				this.resetStream(id, code);
			} else if (type === 0x06) {
				const offset = r.varint();
				const data = r.bytes(r.varint());
				for (const chunk of space.cryptoIn.push(offset, data.slice())) await this.onCrypto(space, chunk);
			} else if (type === 0x07) {
				r.bytes(r.varint());
			} else if (type >= 0x08 && type <= 0x0f) {
				const id = r.varint();
				const offset = type & 0x04 ? r.varint() : 0;
				const len = type & 0x02 ? r.varint() : r.left;
				this.onStreamFrame(id, offset, r.bytes(len).slice(), !!(type & 0x01));
			} else if (type === 0x10) {
				this.peerMaxData = Math.max(this.peerMaxData, r.varint());
			} else if (type === 0x11) {
				const s = this.streams.get(r.varint());
				const max = r.varint();
				if (s) s.peerMax = Math.max(s.peerMax, max);
			} else if (type === 0x12 || type === 0x13) {
				const max = r.varint();
				if (type === 0x12) this.peerMaxStreamsBidi = Math.max(this.peerMaxStreamsBidi, max);
				else this.peerMaxStreamsUni = Math.max(this.peerMaxStreamsUni, max);
				this.wakeStreamWaiters();
			} else if (type === 0x14) r.varint();
			else if (type === 0x15) {
				r.varint();
				r.varint();
			} else if (type === 0x16 || type === 0x17) r.varint();
			else if (type === 0x18) {
				const seq = r.varint();
				const retirePriorTo = r.varint();
				const cid = r.bytes(r.u8()).slice();
				r.bytes(16);
				this.peerCids.set(seq, cid);
				if (retirePriorTo > this.dcidSeq) {
					for (const [s] of this.peerCids) {
						if (s < retirePriorTo) {
							this.peerCids.delete(s);
							this.control.push({ t: "retire", seq: s });
						}
					}
					const next = Math.min(...this.peerCids.keys());
					this.dcidSeq = next;
					this.dcid = this.peerCids.get(next);
				}
			} else if (type === 0x19) r.varint();
			else if (type === 0x1a) this.control.push({ t: "pathResponse", data: r.bytes(8).slice() });
			else if (type === 0x1b) r.bytes(8);
			else if (type === 0x1c || type === 0x1d) {
				const code = r.varint();
				if (type === 0x1c) r.varint();
				const reason = new TextDecoder().decode(r.bytes(r.varint()));
				this.finish({ code, reason, app: type === 0x1d, local: false });
				return false;
			} else if (type === 0x1e) {
				this.handshakeConfirmed = true;
				this.discard(this.spaces.handshake);
			} else if (type === 0x30 || type === 0x31) {
				const len = type === 0x31 ? r.varint() : r.left;
				this.events.datagram?.(r.bytes(len).slice());
			} else throw new QuicError(`unknown frame type 0x${type.toString(16)}`, 0x07);
		}
		return eliciting;
	}

	async onCrypto(space, chunk) {
		for (const action of await this.tls.receive(space.name, chunk)) {
			if (action.keys === "handshake") {
				const hs = this.spaces.handshake;
				[hs.send, hs.recv] = await Promise.all([PacketKeys.fromSecret(action.client), PacketKeys.fromSecret(action.server)]);
				await this.retryPending();
			} else if (action.keys === "app") {
				const app = this.spaces.app;
				[app.send, app.recv] = await Promise.all([PacketKeys.fromSecret(action.client), PacketKeys.fromSecret(action.server)]);
				this.sendPhase = 0;
				this.recvPhase = 0;
			} else if (action.send) {
				this.queueCrypto(this.spaces.handshake, action.data);
			} else if (action.done) {
				this.applyPeerParams(this.tls.peerParams);
				this.state = "established";
				this.resolveEstablished();
				await this.retryPending();
			}
		}
	}

	async retryPending() {
		const waiting = this.pending.splice(0);
		for (const args of waiting) await this.processPacket(...args);
	}

	applyPeerParams(params) {
		const odcid = params.get(TP.originalDestinationConnectionId);
		if (!odcid || !equalBytes(odcid, this.odcid)) throw new QuicError("server sent the wrong original_destination_connection_id", 0x08);
		const iscid = params.get(TP.initialSourceConnectionId);
		if (!iscid || !equalBytes(iscid, this.serverScid)) throw new QuicError("server sent the wrong initial_source_connection_id", 0x08);
		if (this.retried) {
			const rscid = params.get(TP.retrySourceConnectionId);
			if (!rscid || !equalBytes(rscid, this.retryScid)) throw new QuicError("server sent the wrong retry_source_connection_id", 0x08);
		}
		this.peerParams = params;
		this.peerMaxData = params.get(TP.initialMaxData) ?? 0;
		this.peerMaxStreamsBidi = params.get(TP.initialMaxStreamsBidi) ?? 0;
		this.peerMaxStreamsUni = params.get(TP.initialMaxStreamsUni) ?? 0;
		this.peerMaxDatagramFrame = params.get(TP.maxDatagramFrameSize) ?? 0;
		this.peerAckDelayExponent = params.get(TP.ackDelayExponent) ?? 3;
		this.peerMaxAckDelay = params.get(TP.maxAckDelay) ?? 25;
		const idle = params.get(TP.maxIdleTimeout) ?? 0;
		if (idle > 0) this.idleTimeout = Math.min(this.idleTimeout, idle);
		this.wakeStreamWaiters();
	}

	wakeStreamWaiters() {
		for (const kind of ["uni", "bidi"]) {
			const waiters = this.streamWaiters[kind];
			while (waiters.length && waiters[0]() !== false) waiters.shift();
		}
	}

	onStreamFrame(id, offset, data, fin) {
		let s = this.streams.get(id);
		if (!s) {
			const local = (id & 1) === 0;
			if (local) return; // a stream we closed and forgot
			const uni = (id & 2) !== 0;
			const index = id >> 2;
			// Peer streams open in order, so a lower id we no longer track has already finished;
			// this is a retransmission, not a new stream.
			if (index <= (uni ? this.peerHighestUni : this.peerHighestBidi)) return;
			const limit = uni ? this.localMaxStreamsUni : this.localMaxStreamsBidi;
			if (index >= limit) throw new QuicError("peer exceeded the stream limit", 0x04);
			if (uni) this.peerHighestUni = index;
			else this.peerHighestBidi = index;
			const sendLimit = uni ? 0 : (this.peerParams?.get(TP.initialMaxStreamDataBidiLocal) ?? 0);
			s = new Stream(id, sendLimit, LOCAL_STREAM_WINDOW);
			this.streams.set(id, s);
			this.events.streamOpen?.(id);
		}
		if (!s.canRecv) throw new QuicError(`peer sent data on send-only stream ${id}`, 0x05);
		if (s.recvDone) return;
		const end = offset + data.length;
		if (end > s.recvHighest) {
			this.recvHighest += end - s.recvHighest;
			s.recvHighest = end;
		}
		if (fin) s.finalSize = end;
		for (const chunk of s.recv.push(offset, data)) {
			this.consumed(s, chunk.length);
			this.events.streamData?.(id, chunk, false);
		}
		if (s.finalSize !== null && s.recv.offset >= s.finalSize && !s.recvDone) {
			s.recvDone = true;
			this.events.streamData?.(id, new Uint8Array(0), true);
			this.streamFinished(s);
		}
	}

	// Data handed to the application frees flow-control credit.
	consumed(s, n) {
		this.recvConsumed += n;
		if (this.recvConsumed + this.recvWindow / 2 > this.recvAdvertised) {
			this.recvAdvertised = this.recvConsumed + this.recvWindow;
			this.needMaxData = true;
		}
		const used = s.recv.offset;
		if (used + s.window / 2 > s.advertised) {
			s.advertised = used + s.window;
			s.needMaxStreamData = true;
		}
	}

	streamFinished(s) {
		if (s.local) return;
		if (s.uni) {
			this.peerStreamsDoneUni++;
			this.localMaxStreamsUni = this.peerStreamsDoneUni + LOCAL_STREAMS_UNI;
			this.needMaxStreams.uni = true;
		} else {
			this.peerStreamsDoneBidi++;
			this.localMaxStreamsBidi = this.peerStreamsDoneBidi + LOCAL_STREAMS_BIDI;
			this.needMaxStreams.bidi = true;
		}
		this.maybeForget(s);
	}

	// ---- acknowledgements and loss -------------------------------------------------------------

	onAck(space, ranges, ackDelayRaw) {
		const t = now();
		const inRanges = (pn) => ranges.some(([lo, hi]) => pn >= lo && pn <= hi);
		const largest = ranges[0][1];
		let newestAcked = null;
		for (const [pn, p] of space.sent) {
			if (!inRanges(pn)) continue;
			space.sent.delete(pn);
			if (pn === largest) newestAcked = p;
			if (p.eliciting) {
				this.inFlight -= p.size;
				if (p.time > this.recoveryStart) {
					if (this.cwnd < this.ssthresh) this.cwnd += p.size;
					else this.cwnd += (1200 * p.size) / this.cwnd;
				}
			}
			for (const f of p.frames) {
				if (f.t !== "stream") continue;
				const s = this.streams.get(f.id);
				if (!s) continue;
				s.unacked--;
				if (f.fin) s.finAcked = true;
				this.maybeForget(s);
			}
		}
		if (largest > space.largestAcked) space.largestAcked = largest;
		if (newestAcked?.eliciting) {
			let rtt = t - newestAcked.time;
			this.minRtt = Math.min(this.minRtt, rtt);
			if (space.name === "app") {
				const delay = Math.min((ackDelayRaw * 2 ** this.peerAckDelayExponent) / 1000, this.peerMaxAckDelay);
				if (rtt - delay >= this.minRtt) rtt -= delay;
			}
			this.latestRtt = rtt;
			if (!this.rttSampled) {
				this.rttSampled = true;
				this.smoothedRtt = rtt;
				this.rttVar = rtt / 2;
			} else {
				this.rttVar = 0.75 * this.rttVar + 0.25 * Math.abs(this.smoothedRtt - rtt);
				this.smoothedRtt = 0.875 * this.smoothedRtt + 0.125 * rtt;
			}
		}
		this.ptoCount = 0;
		this.detectLoss(space, t);
	}

	detectLoss(space, t) {
		const lossDelay = Math.max(1.125 * Math.max(this.latestRtt, this.smoothedRtt), 1);
		for (const [pn, p] of space.sent) {
			if (pn > space.largestAcked) continue;
			if (pn <= space.largestAcked - 3 || p.time <= t - lossDelay) {
				space.sent.delete(pn);
				this.onLost(space, p, t);
			}
		}
	}

	onLost(space, p, t) {
		this.stats.packetsLost++;
		if (p.eliciting) this.inFlight -= p.size;
		this.requeue(space, p);
		if (p.eliciting && p.time > this.recoveryStart) {
			this.recoveryStart = t;
			this.ssthresh = Math.max(this.cwnd / 2, 2 * 1200);
			this.cwnd = this.ssthresh;
		}
	}

	requeue(space, p) {
		for (const f of p.frames) {
			if (f.t === "crypto") space.cryptoOut.unshift({ offset: f.offset, data: f.data });
			else if (f.t === "stream") {
				const s = this.streams.get(f.id);
				if (!s) continue;
				s.unacked--;
				if (s.resetCode === null) s.retransmit.push({ offset: f.offset, data: f.data, fin: f.fin });
			} else if (f.t === "maxData") this.needMaxData = true;
			else if (f.t === "maxStreamData") {
				const s = this.streams.get(f.id);
				if (s) s.needMaxStreamData = true;
			} else if (f.t === "maxStreams") this.needMaxStreams[f.kind] = true;
			else if (f.t === "reset" || f.t === "stop" || f.t === "retire") this.control.push(f);
		}
	}

	// A stream is dropped once both directions are finished: everything we sent on it has been
	// acknowledged (or it was reset), and everything the peer sends on it has arrived.
	maybeForget(s) {
		const sendDone = !s.canSend || s.resetCode !== null || (s.finAcked && s.unacked === 0 && !s.retransmit.length && s.sendBuffered === 0);
		const recvDone = !s.canRecv || s.recvDone;
		if (sendDone && recvDone) this.streams.delete(s.id);
	}

	discard(space) {
		if (space.discarded) return;
		space.discarded = true;
		for (const p of space.sent.values()) if (p.eliciting) this.inFlight -= p.size;
		space.sent.clear();
		space.cryptoOut = [];
		space.ackNeeded = false;
	}

	ptoDuration(space) {
		const base = this.smoothedRtt + Math.max(4 * this.rttVar, 1) + (space.name === "app" ? this.peerMaxAckDelay : 0);
		return base * 2 ** this.ptoCount;
	}

	// ---- sending ------------------------------------------------------------------------------

	async flush() {
		this.flushQueued = false;
		if (this.state === "closed") return;
		if (this.state === "closing") {
			await this.sendClose();
			return;
		}
		for (const name of ["initial", "handshake", "app"]) {
			const space = this.spaces[name];
			if (!space.send || space.discarded) continue;
			if (name === "app" && this.state !== "established") continue;
			for (let i = 0; i < 64; i++) {
				const pkt = this.collect(space);
				if (!pkt) break;
				await this.sendPacket(space, pkt, name === "initial" ? INITIAL_DATAGRAM : 0);
				if (name === "handshake" && !this.spaces.initial.discarded) this.discard(this.spaces.initial);
			}
		}
		this.armTimer();
	}

	collect(space) {
		const app = space.name === "app";
		const headerLen = app
			? 1 + this.dcid.length + 4
			: 1 + 4 + 1 + this.dcid.length + 1 + this.scid.length + (space.name === "initial" ? 1 + this.token.length + (this.token.length > 63 ? 1 : 0) : 0) + 2 + 4;
		let room = MAX_UDP - headerLen - 16;
		const w = new Writer(1300);
		const frames = [];
		let eliciting = false;
		const t = now();

		const ackDue = space.ackNeeded && (!app || space.elicitingSinceAck >= 2 || t - space.largestRecvTime >= ACK_DELAY_MS || this.probe);
		if (ackDue && space.ranges.length) {
			const ack = this.ackFrame(space, t);
			w.bytes(ack);
			room -= ack.length;
			space.ackNeeded = false;
			space.elicitingSinceAck = 0;
		}

		while (space.cryptoOut.length && room > 32) {
			const c = space.cryptoOut[0];
			const overhead = 1 + 8 + 4;
			const take = Math.min(c.data.length, room - overhead);
			const data = c.data.subarray(0, take);
			w.u8(0x06).varint(c.offset).varint(take).bytes(data);
			room -= overhead + take;
			frames.push({ t: "crypto", offset: c.offset, data });
			if (take === c.data.length) space.cryptoOut.shift();
			else space.cryptoOut[0] = { offset: c.offset + take, data: c.data.subarray(take) };
			eliciting = true;
		}

		if (app) {
			const ctl = (fn) => {
				const before = w.len;
				fn();
				room -= w.len - before;
				eliciting = true;
			};
			if (this.needMaxData && room > 16) {
				ctl(() => w.u8(0x10).varint(this.recvAdvertised));
				frames.push({ t: "maxData" });
				this.needMaxData = false;
			}
			for (const kind of ["uni", "bidi"]) {
				if (this.needMaxStreams[kind] && room > 16) {
					ctl(() => w.u8(kind === "uni" ? 0x13 : 0x12).varint(kind === "uni" ? this.localMaxStreamsUni : this.localMaxStreamsBidi));
					frames.push({ t: "maxStreams", kind });
					this.needMaxStreams[kind] = false;
				}
			}
			for (const s of this.streams.values()) {
				if (s.needMaxStreamData && room > 24) {
					ctl(() => w.u8(0x11).varint(s.id).varint(s.advertised));
					frames.push({ t: "maxStreamData", id: s.id });
					s.needMaxStreamData = false;
				}
			}
			while (this.control.length && room > 40) {
				const f = this.control.shift();
				if (f.t === "reset") ctl(() => w.u8(0x04).varint(f.id).varint(f.code).varint(f.finalSize));
				else if (f.t === "stop") ctl(() => w.u8(0x05).varint(f.id).varint(f.code));
				else if (f.t === "retire") ctl(() => w.u8(0x19).varint(f.seq));
				else if (f.t === "pathResponse") ctl(() => w.u8(0x1b).bytes(f.data));
				if (f.t !== "pathResponse") frames.push(f);
			}
			const cwndOpen = () => this.inFlight === 0 || this.inFlight + (MAX_UDP - room) < this.cwnd;
			while (this.datagrams.length && cwndOpen()) {
				const d = this.datagrams[0];
				const need = 1 + 2 + d.length;
				if (need > room) break;
				this.datagrams.shift();
				w.u8(0x31).varint(d.length).bytes(d);
				room -= need;
				eliciting = true;
			}
			for (const s of this.streams.values()) {
				if (room < 32 || !cwndOpen()) break;
				while (s.retransmit.length && room > 32) {
					const rt = s.retransmit[0];
					const take = Math.min(rt.data.length, room - 1 - 8 - 8 - 2);
					const data = rt.data.subarray(0, take);
					const fin = rt.fin && take === rt.data.length;
					w.u8(0x08 | 0x04 | 0x02 | (fin ? 1 : 0)).varint(s.id).varint(rt.offset).varint(take).bytes(data);
					room -= 1 + 8 + 8 + 2 + take;
					frames.push({ t: "stream", id: s.id, offset: rt.offset, data, fin });
					s.unacked++;
					if (take === rt.data.length) s.retransmit.shift();
					else s.retransmit[0] = { offset: rt.offset + take, data: rt.data.subarray(take), fin: rt.fin };
					eliciting = true;
				}
				const credit = Math.min(s.peerMax - s.sendOffset, this.peerMaxData - this.dataSent);
				const wantFin = s.finQueued && !s.finSent;
				if ((s.sendBuffered > 0 && credit > 0) || (wantFin && s.sendBuffered === 0)) {
					const take = Math.max(0, Math.min(s.sendBuffered, credit, room - 1 - 8 - 8 - 2));
					if (take === 0 && !(wantFin && s.sendBuffered === 0)) continue;
					const data = takeBytes(s, take);
					const fin = wantFin && s.sendBuffered === 0;
					w.u8(0x08 | 0x04 | 0x02 | (fin ? 1 : 0)).varint(s.id).varint(s.sendOffset).varint(take).bytes(data);
					room -= 1 + 8 + 8 + 2 + take;
					frames.push({ t: "stream", id: s.id, offset: s.sendOffset, data, fin });
					s.unacked++;
					s.sendOffset += take;
					this.dataSent += take;
					if (fin) s.finSent = true;
					eliciting = true;
				}
			}
		}

		if (this.probe && !eliciting && room > 1) {
			w.u8(0x01);
			eliciting = true;
		}
		if (w.len === 0) return null;
		if (eliciting) this.probe = false;
		// Header protection samples 16 bytes after the packet number; keep the payload long enough.
		while (w.len < 4) w.u8(0x00);
		return { payload: w.done(), frames, eliciting };
	}

	ackFrame(space, t) {
		const r = space.ranges;
		const w = new Writer(64);
		const delay = Math.floor(((t - space.largestRecvTime) * 1000) / 8); // our ack_delay_exponent is 3
		w.u8(0x02).varint(r[0][1]).varint(Math.max(0, delay)).varint(Math.min(r.length, 32) - 1).varint(r[0][1] - r[0][0]);
		for (let i = 1; i < Math.min(r.length, 32); i++) w.varint(r[i - 1][0] - r[i][1] - 2).varint(r[i][1] - r[i][0]);
		return w.done();
	}

	async sendPacket(space, { payload, frames, eliciting }, padTo = 0) {
		const pn = space.nextPn++;
		const long = space.name !== "app";
		const h = new Writer(64);
		if (long) {
			h.u8(0xc0 | ((space.name === "initial" ? 0 : 2) << 4) | 3).u32(1).u8(this.dcid.length).bytes(this.dcid).u8(this.scid.length).bytes(this.scid);
			if (space.name === "initial") h.varint(this.token.length).bytes(this.token);
			let length = 4 + payload.length + 16;
			if (padTo) {
				const total = h.len + 2 + length;
				if (total < padTo) {
					payload = concat(payload, new Uint8Array(padTo - total));
					length = 4 + payload.length + 16;
				}
			}
			h.u16(0x4000 | length);
		} else {
			h.u8(0x40 | ((this.sendPhase || 0) << 2) | 3).bytes(this.dcid);
		}
		const pnOffset = h.len;
		h.u32(pn >>> 0);
		const header = h.done();
		const sealed = await space.send.seal(pn, header, payload);
		const mask = await space.send.mask(sealed.subarray(0, 16));
		const packet = concat(header, sealed);
		packet[0] ^= mask[0] & (long ? 0x0f : 0x1f);
		for (let i = 0; i < 4; i++) packet[pnOffset + i] ^= mask[1 + i];
		const t = now();
		space.sent.set(pn, { time: t, size: packet.length, eliciting, frames });
		if (eliciting) this.inFlight += packet.length;
		this.lastSent = t;
		this.stats.packetsSent++;
		this.stats.bytesSent += packet.length;
		this.sendUdp(packet);
	}

	async sendClose() {
		const { code, reason, app } = this.closeInfo;
		const r = new TextEncoder().encode(reason || "").subarray(0, 100);
		const space = this.state !== "closing" ? null : this.spaces.app.send && this.spaces.app.recv ? this.spaces.app : this.spaces.handshake.send ? this.spaces.handshake : this.spaces.initial;
		if (space?.send) {
			const w = new Writer(128);
			if (app && space.name === "app") w.u8(0x1d).varint(code).varint(r.length).bytes(r);
			else w.u8(0x1c).varint(app ? 0x0c : code).varint(0).varint(r.length).bytes(r);
			try {
				await this.sendPacket(space, { payload: w.done(), frames: [], eliciting: false }, space.name === "initial" ? INITIAL_DATAGRAM : 0);
			} catch {
				// closing anyway
			}
		}
		this.finish({ ...this.closeInfo });
	}

	// ---- timers -------------------------------------------------------------------------------

	armTimer() {
		clearTimeout(this.timer);
		if (this.state === "closed") return;
		const t = now();
		let at = this.lastReceived + this.idleTimeout;
		const app = this.spaces.app;
		if (app.ackNeeded) at = Math.min(at, app.largestRecvTime + ACK_DELAY_MS);
		for (const space of Object.values(this.spaces)) {
			if (space.discarded) continue;
			let oldest = Infinity;
			for (const p of space.sent.values()) if (p.eliciting && p.time < oldest) oldest = p.time;
			if (oldest !== Infinity) at = Math.min(at, oldest + this.ptoDuration(space));
		}
		if (this.state === "established") at = Math.min(at, this.lastSent + KEEPALIVE_MS);
		// Until the handshake completes, keep probing even with nothing in flight: a server held
		// back by its anti-amplification limit waits for more bytes from us (RFC 9002 6.2.2.1).
		if (this.state === "connecting") at = Math.min(at, this.lastSent + this.ptoDuration(this.spaces.initial));
		this.timer = setTimeout(() => this.run(() => this.onTimer()), Math.max(1, at - t));
	}

	async onTimer() {
		if (this.state === "closed") return;
		const t = now();
		if (t - this.lastReceived >= this.idleTimeout) {
			this.finish({ code: 0, reason: "idle timeout", local: true, idle: true });
			return;
		}
		let probe = false;
		for (const space of Object.values(this.spaces)) {
			if (space.discarded) continue;
			let oldest = null;
			for (const p of space.sent.values()) if (p.eliciting && (!oldest || p.time < oldest.time)) oldest = p;
			if (oldest && t >= oldest.time + this.ptoDuration(space)) {
				// Probe: resend everything outstanding in this space (receivers drop duplicates).
				for (const [pn, p] of space.sent) {
					if (!p.eliciting) continue;
					space.sent.delete(pn);
					this.inFlight -= p.size;
					this.requeue(space, p);
				}
				probe = true;
			}
		}
		if (this.state === "connecting" && t >= this.lastSent + this.ptoDuration(this.spaces.initial)) probe = true;
		if (probe) this.ptoCount++;
		if (probe || (this.state === "established" && t - this.lastSent >= KEEPALIVE_MS)) this.probe = true;
		await this.flush();
	}
}

function takeBytes(s, n) {
	if (n === 0) return new Uint8Array(0);
	const out = new Uint8Array(n);
	let at = 0;
	while (at < n) {
		const head = s.sendBuf[0];
		const need = n - at;
		if (head.length <= need) {
			out.set(head, at);
			at += head.length;
			s.sendBuf.shift();
		} else {
			out.set(head.subarray(0, need), at);
			s.sendBuf[0] = head.subarray(need);
			at += need;
		}
	}
	s.sendBuffered -= n;
	return out;
}

// RFC 9000 appendix A.3, with arithmetic instead of 32-bit bitwise operators.
function decodePn(largest, truncated, bits) {
	const expected = largest + 1;
	const win = 2 ** bits;
	const hwin = win / 2;
	const candidate = Math.floor(expected / win) * win + truncated;
	if (candidate <= expected - hwin && candidate < 2 ** 62 - win) return candidate + win;
	if (candidate > expected + hwin && candidate >= win) return candidate - win;
	return candidate;
}
