// TLS 1.3 client handshake for QUIC (RFC 8446 + RFC 9001), just enough for WebTransport with
// pinned certificate hashes: one cipher suite (TLS_AES_128_GCM_SHA256), one group (secp256r1),
// ECDSA-P256 or RSA-PSS server signatures, ALPN "h3". The server certificate is accepted only if
// its SHA-256 matches one of the pinned hashes, and must prove it holds the key (CertificateVerify).

import { Reader, Writer, concat, equalBytes, utf8 } from "./bytes.js";
import { generateKeyShare, hkdfExpandLabel, hkdfExtract, hmac, randomBytes, sha256, sharedSecret, verifySignature } from "./crypto.js";

const HS = { clientHello: 1, serverHello: 2, newSessionTicket: 4, encryptedExtensions: 8, certificate: 11, certificateRequest: 13, certificateVerify: 15, finished: 20 };
const EXT = { serverName: 0, supportedGroups: 10, signatureAlgorithms: 13, alpn: 16, supportedVersions: 43, keyShare: 51, quicTransportParameters: 57 };
const HRR_RANDOM = "cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c";

export const TP = {
	originalDestinationConnectionId: 0x00,
	maxIdleTimeout: 0x01,
	maxUdpPayloadSize: 0x03,
	initialMaxData: 0x04,
	initialMaxStreamDataBidiLocal: 0x05,
	initialMaxStreamDataBidiRemote: 0x06,
	initialMaxStreamDataUni: 0x07,
	initialMaxStreamsBidi: 0x08,
	initialMaxStreamsUni: 0x09,
	ackDelayExponent: 0x0a,
	maxAckDelay: 0x0b,
	activeConnectionIdLimit: 0x0e,
	initialSourceConnectionId: 0x0f,
	retrySourceConnectionId: 0x10,
	maxDatagramFrameSize: 0x20,
};
const BYTE_PARAMS = new Set([TP.originalDestinationConnectionId, TP.initialSourceConnectionId, TP.retrySourceConnectionId, 0x02]);

export function encodeTransportParams(params) {
	const w = new Writer();
	for (const [id, value] of params) {
		w.varint(id);
		if (value instanceof Uint8Array) w.varint(value.length).bytes(value);
		else {
			const v = new Writer().varint(value).done();
			w.varint(v.length).bytes(v);
		}
	}
	return w.done();
}

export function decodeTransportParams(bytes) {
	const r = new Reader(bytes);
	const out = new Map();
	while (r.left) {
		const id = r.varint();
		const value = r.bytes(r.varint());
		out.set(id, BYTE_PARAMS.has(id) || id === 0x0d ? value : value.length ? new Reader(value).varint() : 0);
	}
	return out;
}

export class TlsClient {
	/**
	 * @param {{serverName: string, transportParams: Uint8Array, certHashes: Uint8Array[]}} o
	 */
	constructor({ serverName, transportParams, certHashes }) {
		this.serverName = serverName;
		this.transportParams = transportParams;
		this.certHashes = certHashes || [];
		this.transcript = [];
		this.buffers = { initial: new Uint8Array(0), handshake: new Uint8Array(0), app: new Uint8Array(0) };
		this.state = "start";
		this.peerParams = null;
		this.cert = null;
	}

	async clientHello() {
		this.share = await generateKeyShare();
		const w = new Writer(512);
		w.u8(HS.clientHello).vec(3, (b) => {
			b.u16(0x0303).bytes(randomBytes(32));
			b.u8(0); // legacy_session_id: empty in QUIC
			b.vec(2, (c) => c.u16(0x1301));
			b.u8(1).u8(0);
			b.vec(2, (e) => {
				const ext = (type, fn) => e.u16(type).vec(2, fn);
				ext(EXT.serverName, (x) => x.vec(2, (l) => l.u8(0).vec(2, (n) => n.bytes(utf8(this.serverName)))));
				ext(EXT.supportedGroups, (x) => x.vec(2, (l) => l.u16(0x0017)));
				ext(EXT.signatureAlgorithms, (x) => x.vec(2, (l) => l.u16(0x0403).u16(0x0804)));
				ext(EXT.alpn, (x) => x.vec(2, (l) => l.vec(1, (p) => p.bytes(utf8("h3")))));
				ext(EXT.supportedVersions, (x) => x.vec(1, (l) => l.u16(0x0304)));
				ext(EXT.keyShare, (x) => x.vec(2, (l) => l.u16(0x0017).vec(2, (k) => k.bytes(this.share.publicRaw))));
				ext(EXT.quicTransportParameters, (x) => x.bytes(this.transportParams));
			});
		});
		const msg = w.done();
		this.transcript.push(msg);
		this.state = "wait-server-hello";
		return msg;
	}

	transcriptHash() {
		return sha256(concat(...this.transcript));
	}

	// Feeds CRYPTO data for one encryption level. Returns actions for the QUIC layer:
	//   { keys: "handshake" | "app", client, server }  new secrets
	//   { send: "handshake", data }                    client Finished
	//   { done: true }                                 handshake complete
	async receive(level, data) {
		this.buffers[level] = concat(this.buffers[level], data);
		const actions = [];
		for (;;) {
			const buf = this.buffers[level];
			if (buf.length < 4) break;
			const len = (buf[1] << 16) | (buf[2] << 8) | buf[3];
			if (buf.length < 4 + len) break;
			const msg = buf.slice(0, 4 + len);
			this.buffers[level] = buf.slice(4 + len);
			actions.push(...(await this.handle(level, msg[0], msg)));
		}
		return actions;
	}

	async handle(level, type, msg) {
		const body = new Reader(msg, 4);
		if (level === "app") return []; // NewSessionTicket etc.: not used
		if (this.state === "wait-server-hello" && type === HS.serverHello) return this.serverHello(msg, body);
		if (this.state === "wait-ee" && type === HS.encryptedExtensions) return this.encryptedExtensions(msg, body);
		if (this.state === "wait-cert" && type === HS.certificateRequest) throw new Error("server asked for a client certificate");
		if (this.state === "wait-cert" && type === HS.certificate) return this.certificate(msg, body);
		if (this.state === "wait-cv" && type === HS.certificateVerify) return this.certificateVerify(msg, body);
		if (this.state === "wait-finished" && type === HS.finished) return this.finished(msg, body);
		throw new Error(`unexpected TLS message ${type} in state ${this.state}`);
	}

	async serverHello(msg, r) {
		r.u16();
		const random = r.bytes(32);
		if ([...random].map((b) => b.toString(16).padStart(2, "0")).join("") === HRR_RANDOM) throw new Error("server sent HelloRetryRequest");
		r.vec(1);
		const suite = r.u16();
		if (suite !== 0x1301) throw new Error(`server chose cipher suite 0x${suite.toString(16)}`);
		r.u8();
		const exts = new Reader(r.vec(2));
		let peerShare = null;
		while (exts.left) {
			const type = exts.u16();
			const data = new Reader(exts.vec(2));
			if (type === EXT.keyShare) {
				if (data.u16() !== 0x0017) throw new Error("server chose an unsupported key exchange group");
				peerShare = data.vec(2);
			} else if (type === EXT.supportedVersions && data.u16() !== 0x0304) throw new Error("server did not choose TLS 1.3");
		}
		if (!peerShare) throw new Error("ServerHello without a key share");
		this.transcript.push(msg);
		const shared = await sharedSecret(this.share.privateKey, peerShare);
		const zeros = new Uint8Array(32);
		const early = await hkdfExtract(zeros, zeros);
		const emptyHash = await sha256(new Uint8Array(0));
		const derived = await hkdfExpandLabel(early, "derived", emptyHash, 32);
		this.handshakeSecret = await hkdfExtract(derived, shared);
		const th = await this.transcriptHash();
		this.clientHs = await hkdfExpandLabel(this.handshakeSecret, "c hs traffic", th, 32);
		this.serverHs = await hkdfExpandLabel(this.handshakeSecret, "s hs traffic", th, 32);
		this.state = "wait-ee";
		return [{ keys: "handshake", client: this.clientHs, server: this.serverHs }];
	}

	async encryptedExtensions(msg, r) {
		const exts = new Reader(r.vec(2));
		let alpn = null;
		while (exts.left) {
			const type = exts.u16();
			const data = exts.vec(2);
			if (type === EXT.alpn) alpn = new TextDecoder().decode(new Reader(new Reader(data).vec(2)).vec(1));
			else if (type === EXT.quicTransportParameters) this.peerParams = decodeTransportParams(data);
		}
		if (alpn !== "h3") throw new Error(`server did not agree to h3 (ALPN ${alpn})`);
		if (!this.peerParams) throw new Error("server sent no QUIC transport parameters");
		this.transcript.push(msg);
		this.state = "wait-cert";
		return [];
	}

	async certificate(msg, r) {
		r.vec(1);
		const list = new Reader(r.vec(3));
		if (!list.left) throw new Error("server sent no certificate");
		this.cert = list.vec(3).slice();
		const digest = await sha256(this.cert);
		if (!this.certHashes.some((h) => equalBytes(h, digest))) throw new Error("server certificate does not match the pinned hash");
		this.transcript.push(msg);
		this.state = "wait-cv";
		return [];
	}

	async certificateVerify(msg, r) {
		const scheme = r.u16();
		const signature = r.vec(2);
		const content = concat(new Uint8Array(64).fill(0x20), utf8("TLS 1.3, server CertificateVerify"), new Uint8Array([0]), await this.transcriptHash());
		if (!(await verifySignature(this.cert, scheme, signature, content))) throw new Error("server CertificateVerify signature is invalid");
		this.transcript.push(msg);
		this.state = "wait-finished";
		return [];
	}

	async finished(msg, r) {
		const verifyData = r.bytes(32);
		const serverKey = await hkdfExpandLabel(this.serverHs, "finished", new Uint8Array(0), 32);
		const expected = await hmac(serverKey, await this.transcriptHash());
		if (!equalBytes(expected, verifyData)) throw new Error("server Finished is invalid");
		this.transcript.push(msg);

		const thServerFinished = await this.transcriptHash();
		const emptyHash = await sha256(new Uint8Array(0));
		const derived = await hkdfExpandLabel(this.handshakeSecret, "derived", emptyHash, 32);
		const master = await hkdfExtract(derived, new Uint8Array(32));
		const clientApp = await hkdfExpandLabel(master, "c ap traffic", thServerFinished, 32);
		const serverApp = await hkdfExpandLabel(master, "s ap traffic", thServerFinished, 32);

		const clientKey = await hkdfExpandLabel(this.clientHs, "finished", new Uint8Array(0), 32);
		const clientVerify = await hmac(clientKey, thServerFinished);
		const finished = concat(new Uint8Array([HS.finished, 0, 0, 32]), clientVerify);
		this.transcript.push(finished);
		this.state = "done";
		return [{ keys: "app", client: clientApp, server: serverApp }, { send: "handshake", data: finished }, { done: true }];
	}
}
