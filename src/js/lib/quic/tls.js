// TLS 1.3 client handshake for QUIC (RFC 8446 + RFC 9001), enough for WebTransport: one cipher
// suite (TLS_AES_128_GCM_SHA256), X25519 or P-256 key exchange, ECDSA or RSA-PSS server
// signatures, ALPN "h3". The server certificate is checked like a browser does:
//   - with pinned hashes (serverCertificateHashes), it must match one of them;
//   - otherwise its chain must verify for the server name against trusted roots (verifyChain).
// Either way the server must prove it holds the key (CertificateVerify).

import { Reader, Writer, concat, equalBytes, hex, utf8 } from "./bytes.js";
import { generateKeyShares, hkdfExpandLabel, hkdfExtract, hmac, randomBytes, sha256, sharedSecret } from "./crypto.js";
import { CertificateError, SIGNATURE_SCHEMES, parseCertificate, parseIp, verifyHandshakeSignature } from "./x509.js";

const HS = { clientHello: 1, serverHello: 2, newSessionTicket: 4, encryptedExtensions: 8, certificate: 11, certificateRequest: 13, certificateVerify: 15, finished: 20 };
const EXT = { serverName: 0, supportedGroups: 10, signatureAlgorithms: 13, alpn: 16, supportedVersions: 43, keyShare: 51, quicTransportParameters: 57 };
const HRR_RANDOM = "cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c";

// A TLS failure with the alert it maps to (QUIC closes with CRYPTO_ERROR 0x100 + alert).
export class TlsAlert extends Error {
	constructor(message, alert) {
		super(message);
		this.name = "TlsAlert";
		this.alert = alert;
	}
}

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
	 * @param {object} o
	 * @param {string} o.serverName
	 * @param {Uint8Array} o.transportParams
	 * @param {Uint8Array[]} [o.certHashes]   pinned SHA-256 hashes of acceptable server certificates
	 * @param {(chain: Uint8Array[], serverName: string) => Promise<unknown>} [o.verifyChain]
	 *        validates the server's chain (leaf first) when nothing is pinned; throws if untrusted
	 */
	constructor({ serverName, transportParams, certHashes, verifyChain }) {
		this.serverName = serverName;
		this.transportParams = transportParams;
		this.certHashes = certHashes || [];
		this.verifyChain = verifyChain || null;
		this.transcript = [];
		this.buffers = { initial: new Uint8Array(0), handshake: new Uint8Array(0), app: new Uint8Array(0) };
		this.state = "start";
		this.peerParams = null;
		this.leaf = null;
	}

	async clientHello() {
		this.shares = await generateKeyShares();
		const sni = !parseIp(this.serverName); // IP literals never go in server_name (RFC 6066)
		const w = new Writer(512);
		w.u8(HS.clientHello).vec(3, (b) => {
			b.u16(0x0303).bytes(randomBytes(32));
			b.u8(0); // legacy_session_id: empty in QUIC
			b.vec(2, (c) => c.u16(0x1301));
			b.u8(1).u8(0);
			b.vec(2, (e) => {
				const ext = (type, fn) => e.u16(type).vec(2, fn);
				if (sni) ext(EXT.serverName, (x) => x.vec(2, (l) => l.u8(0).vec(2, (n) => n.bytes(utf8(this.serverName)))));
				ext(EXT.supportedGroups, (x) => x.vec(2, (l) => this.shares.forEach((s) => l.u16(s.group))));
				ext(EXT.signatureAlgorithms, (x) => x.vec(2, (l) => SIGNATURE_SCHEMES.forEach((s) => l.u16(s))));
				ext(EXT.alpn, (x) => x.vec(2, (l) => l.vec(1, (p) => p.bytes(utf8("h3")))));
				ext(EXT.supportedVersions, (x) => x.vec(1, (l) => l.u16(0x0304)));
				ext(EXT.keyShare, (x) => x.vec(2, (l) => this.shares.forEach((s) => l.u16(s.group).vec(2, (k) => k.bytes(s.publicRaw)))));
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
		try {
			if (this.state === "wait-server-hello" && type === HS.serverHello) return await this.serverHello(msg, body);
			if (this.state === "wait-ee" && type === HS.encryptedExtensions) return await this.encryptedExtensions(msg, body);
			if (this.state === "wait-cert" && type === HS.certificateRequest) throw new TlsAlert("the server asked for a client certificate", 10);
			if (this.state === "wait-cert" && type === HS.certificate) return await this.certificate(msg, body);
			if (this.state === "wait-cv" && type === HS.certificateVerify) return await this.certificateVerify(msg, body);
			if (this.state === "wait-finished" && type === HS.finished) return await this.finished(msg, body);
		} catch (err) {
			if (err instanceof TlsAlert || err instanceof CertificateError) throw err;
			throw new TlsAlert(`could not read the server's TLS ${type} message (${err.message})`, 50);
		}
		throw new TlsAlert(`unexpected TLS message ${type} in state ${this.state}`, 10);
	}

	async serverHello(msg, r) {
		r.u16();
		const random = r.bytes(32);
		if (hex(random) === HRR_RANDOM) throw new TlsAlert("the server asked for a different key exchange (HelloRetryRequest)", 40);
		r.vec(1);
		const suite = r.u16();
		if (suite !== 0x1301) throw new TlsAlert(`the server chose cipher suite 0x${suite.toString(16)}`, 47);
		r.u8();
		const exts = new Reader(r.vec(2));
		let share = null;
		let peerShare = null;
		while (exts.left) {
			const type = exts.u16();
			const data = new Reader(exts.vec(2));
			if (type === EXT.keyShare) {
				const group = data.u16();
				share = this.shares.find((s) => s.group === group);
				if (!share) throw new TlsAlert(`the server chose key exchange group 0x${group.toString(16)}, which was not offered`, 47);
				peerShare = data.vec(2);
			} else if (type === EXT.supportedVersions && data.u16() !== 0x0304) throw new TlsAlert("the server did not choose TLS 1.3", 70);
		}
		if (!share) throw new TlsAlert("ServerHello without a key share", 109);
		this.transcript.push(msg);
		const shared = await sharedSecret(share, peerShare);
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
		if (alpn !== "h3") throw new TlsAlert(`the server did not agree to HTTP/3 (ALPN ${alpn})`, 120);
		if (!this.peerParams) throw new TlsAlert("the server sent no QUIC transport parameters", 109);
		this.transcript.push(msg);
		this.state = "wait-cert";
		return [];
	}

	async certificate(msg, r) {
		r.vec(1); // certificate_request_context
		const list = new Reader(r.vec(3));
		const chain = [];
		while (list.left) {
			chain.push(list.vec(3).slice());
			list.vec(2); // per-certificate extensions
		}
		if (!chain.length) throw new CertificateError("the server sent no certificate");
		if (this.certHashes.length) {
			const digest = await sha256(chain[0]);
			if (!this.certHashes.some((h) => equalBytes(h, digest))) throw new CertificateError("the server's certificate does not match the pinned hash");
		} else if (this.verifyChain) await this.verifyChain(chain, this.serverName);
		else throw new CertificateError("no way to verify the server's certificate");
		try {
			this.leaf = parseCertificate(chain[0]);
		} catch {
			throw new CertificateError("the server's certificate could not be read");
		}
		this.transcript.push(msg);
		this.state = "wait-cv";
		return [];
	}

	async certificateVerify(msg, r) {
		const scheme = r.u16();
		const signature = r.vec(2);
		const content = concat(new Uint8Array(64).fill(0x20), utf8("TLS 1.3, server CertificateVerify"), new Uint8Array([0]), await this.transcriptHash());
		await verifyHandshakeSignature(this.leaf, scheme, signature, content);
		this.transcript.push(msg);
		this.state = "wait-finished";
		return [];
	}

	async finished(msg, r) {
		const verifyData = r.bytes(32);
		const serverKey = await hkdfExpandLabel(this.serverHs, "finished", new Uint8Array(0), 32);
		const expected = await hmac(serverKey, await this.transcriptHash());
		if (!equalBytes(expected, verifyData)) throw new TlsAlert("the server's Finished message is invalid", 51);
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
