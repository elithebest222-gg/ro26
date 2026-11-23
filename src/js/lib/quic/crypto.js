// Cryptography for the QUIC client, built on Web Crypto (available in pages, workers and Node).
// TLS 1.3 with TLS_AES_128_GCM_SHA256 and the secp256r1 group; QUIC packet and header
// protection (RFC 9001).

import { concat, fromHex, utf8 } from "./bytes.js";

const subtle = globalThis.crypto.subtle;
const ZERO16 = new Uint8Array(16);

export async function sha256(data) {
	return new Uint8Array(await subtle.digest("SHA-256", data));
}

export async function hmac(key, data) {
	const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await subtle.sign("HMAC", k, data));
}

export function hkdfExtract(salt, ikm) {
	return hmac(salt.length ? salt : new Uint8Array(32), ikm);
}

export async function hkdfExpand(prk, info, length) {
	const out = new Uint8Array(length);
	let prev = new Uint8Array(0);
	for (let i = 1, at = 0; at < length; i++) {
		prev = await hmac(prk, concat(prev, info, new Uint8Array([i])));
		out.set(prev.subarray(0, Math.min(prev.length, length - at)), at);
		at += prev.length;
	}
	return out;
}

// HKDF-Expand-Label from RFC 8446 section 7.1.
export function hkdfExpandLabel(secret, label, context, length) {
	const full = utf8(`tls13 ${label}`);
	const info = new Uint8Array(4 + full.length + context.length);
	info[0] = length >> 8;
	info[1] = length & 0xff;
	info[2] = full.length;
	info.set(full, 3);
	info[3 + full.length] = context.length;
	info.set(context, 4 + full.length);
	return hkdfExpand(secret, info, length);
}

// Keys protecting one direction of one encryption level.
export class PacketKeys {
	static async fromSecret(secret) {
		const keys = new PacketKeys();
		keys.secret = secret;
		const [key, iv, hp] = await Promise.all([
			hkdfExpandLabel(secret, "quic key", new Uint8Array(0), 16),
			hkdfExpandLabel(secret, "quic iv", new Uint8Array(0), 12),
			hkdfExpandLabel(secret, "quic hp", new Uint8Array(0), 16),
		]);
		keys.iv = iv;
		[keys.aead, keys.hp] = await Promise.all([
			subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
			subtle.importKey("raw", hp, { name: "AES-CTR" }, false, ["encrypt"]),
		]);
		return keys;
	}

	// Key update (RFC 9001 section 6): new packet keys, same header protection key.
	async next() {
		const secret = await hkdfExpandLabel(this.secret, "quic ku", new Uint8Array(0), 32);
		const keys = new PacketKeys();
		keys.secret = secret;
		keys.hp = this.hp;
		const [key, iv] = await Promise.all([
			hkdfExpandLabel(secret, "quic key", new Uint8Array(0), 16),
			hkdfExpandLabel(secret, "quic iv", new Uint8Array(0), 12),
		]);
		keys.iv = iv;
		keys.aead = await subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
		return keys;
	}

	nonce(pn) {
		const n = this.iv.slice();
		let v = pn;
		for (let i = 11; i >= 4 && v > 0; i--) {
			n[i] ^= v % 256;
			v = Math.floor(v / 256);
		}
		return n;
	}

	async seal(pn, header, payload) {
		return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: this.nonce(pn), additionalData: header, tagLength: 128 }, this.aead, payload));
	}

	async open(pn, header, ciphertext) {
		return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: this.nonce(pn), additionalData: header, tagLength: 128 }, this.aead, ciphertext));
	}

	// AES-ECB(hp, sample), via AES-CTR with the sample as the counter block.
	async mask(sample) {
		return new Uint8Array(await subtle.encrypt({ name: "AES-CTR", counter: sample, length: 64 }, this.hp, ZERO16));
	}
}

const INITIAL_SALT = fromHex("38762cf7f55934b34d179ae6a4c80cadccbb7f0a");

export async function initialKeys(dcid) {
	const initial = await hkdfExtract(INITIAL_SALT, dcid);
	const [c, s] = await Promise.all([
		hkdfExpandLabel(initial, "client in", new Uint8Array(0), 32),
		hkdfExpandLabel(initial, "server in", new Uint8Array(0), 32),
	]);
	const [client, server] = await Promise.all([PacketKeys.fromSecret(c), PacketKeys.fromSecret(s)]);
	return { client, server };
}

// RFC 9001 section 5.8: the Retry integrity tag is an AES-GCM tag over the pseudo-packet.
const RETRY_KEY = fromHex("be0c690b9f66575a1d766b54e368c84e");
const RETRY_NONCE = fromHex("461599d35d632bf2239825bb");
export async function retryTagValid(packet, odcid) {
	const body = packet.subarray(0, packet.length - 16);
	const pseudo = concat(new Uint8Array([odcid.length]), odcid, body);
	const key = await subtle.importKey("raw", RETRY_KEY, { name: "AES-GCM" }, false, ["encrypt"]);
	const tag = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: RETRY_NONCE, additionalData: pseudo, tagLength: 128 }, key, new Uint8Array(0)));
	const got = packet.subarray(packet.length - 16);
	return tag.every((b, i) => b === got[i]);
}

// ---- key exchange -----------------------------------------------------------------------------

export async function generateKeyShare() {
	const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
	const publicRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
	return { privateKey: pair.privateKey, publicRaw };
}

export async function sharedSecret(privateKey, peerRaw) {
	const peer = await subtle.importKey("raw", peerRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
	return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256));
}

// ---- certificates and signatures ---------------------------------------------------------------

function tlv(buf, pos) {
	const tag = buf[pos];
	let len = buf[pos + 1];
	let start = pos + 2;
	if (len & 0x80) {
		const n = len & 0x7f;
		len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
		start += n;
	}
	if (start + len > buf.length) throw new Error("bad DER");
	return { tag, start, end: start + len, next: start + len };
}

// SubjectPublicKeyInfo of an X.509 certificate, as DER.
export function certificateSpki(cert) {
	const outer = tlv(cert, 0);
	const tbs = tlv(cert, outer.start);
	let at = tbs.start;
	let field = tlv(cert, at);
	if (field.tag === 0xa0) at = field.next; // [0] version
	for (let i = 0; i < 5; i++) at = tlv(cert, at).next; // serial, signature, issuer, validity, subject
	const spki = tlv(cert, at);
	return cert.subarray(at, spki.end);
}

function derEcdsaToRaw(sig) {
	const seq = tlv(sig, 0);
	const r = tlv(sig, seq.start);
	const s = tlv(sig, r.next);
	const part = (t) => {
		let v = sig.subarray(t.start, t.end);
		while (v.length > 32 && v[0] === 0) v = v.subarray(1);
		const out = new Uint8Array(32);
		out.set(v, 32 - v.length);
		return out;
	};
	return concat(part(r), part(s));
}

// Verifies a TLS 1.3 CertificateVerify signature with the certificate's key.
export async function verifySignature(cert, scheme, signature, content) {
	const spki = certificateSpki(cert);
	if (scheme === 0x0403) {
		const key = await subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derEcdsaToRaw(signature), content);
	}
	if (scheme === 0x0804) {
		const key = await subtle.importKey("spki", spki, { name: "RSA-PSS", hash: "SHA-256" }, false, ["verify"]);
		return subtle.verify({ name: "RSA-PSS", saltLength: 32 }, key, signature, content);
	}
	throw new Error(`unsupported signature scheme 0x${scheme.toString(16)}`);
}

export function randomBytes(n) {
	return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
