// X.509 for the QUIC client: reads the certificate fields TLS needs and validates a server's chain
// the way browsers do for the public web (RFC 5280 path validation, without revocation checks or
// Certificate Transparency) against a bundled root store. Used when the engine does not pin the
// game server's certificate with serverCertificateHashes.

import { equalBytes } from "./bytes.js";

const subtle = globalThis.crypto.subtle;

export class CertificateError extends Error {
	// alert: the TLS alert to close with (42 bad_certificate, 45 certificate_expired,
	// 48 unknown_ca, 51 decrypt_error)
	constructor(message, alert = 42) {
		super(message);
		this.name = "CertificateError";
		this.alert = alert;
	}
}

// ---- DER ----------------------------------------------------------------------------------------

function node(buf, pos) {
	if (pos + 2 > buf.length) throw new Error("truncated DER");
	const tag = buf[pos];
	let len = buf[pos + 1];
	let start = pos + 2;
	if (len & 0x80) {
		const n = len & 0x7f;
		if (n < 1 || n > 4) throw new Error("bad DER length");
		len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
		start += n;
	}
	const end = start + len;
	if (end > buf.length) throw new Error("truncated DER");
	return { tag, pos, start, end };
}

function kids(buf, parent) {
	const out = [];
	for (let at = parent.start; at < parent.end; ) {
		const c = node(buf, at);
		out.push(c);
		at = c.end;
	}
	return out;
}

const body = (buf, n) => buf.subarray(n.start, n.end);
const whole = (buf, n) => buf.subarray(n.pos, n.end);

function oid(buf, n) {
	const b = body(buf, n);
	const parts = [];
	let v = 0;
	for (const byte of b) {
		v = v * 128 + (byte & 0x7f);
		if (byte & 0x80) continue;
		if (!parts.length) {
			const first = Math.min(2, Math.floor(v / 40));
			parts.push(first, v - first * 40);
		} else parts.push(v);
		v = 0;
	}
	return parts.join(".");
}

function time(buf, n) {
	const s = new TextDecoder().decode(body(buf, n));
	let m;
	let year;
	if (n.tag === 0x17) {
		m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s);
		if (!m) throw new Error("bad UTCTime");
		year = Number(m[1]);
		year += year < 50 ? 2000 : 1900;
	} else if (n.tag === 0x18) {
		m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.\d+)?Z$/.exec(s);
		if (!m) throw new Error("bad GeneralizedTime");
		year = Number(m[1]);
	} else throw new Error("bad time");
	return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
}

// A Name as a comparable string: attribute type=value pairs, string values compared without case
// and with runs of spaces collapsed (RFC 5280 section 7.1, close enough for real chains).
function nameKey(buf, n) {
	return kids(buf, n)
		.map((set) =>
			kids(buf, set)
				.map((atv) => {
					const [type, value] = kids(buf, atv);
					let text;
					if (value.tag === 0x0c || value.tag === 0x13 || value.tag === 0x16) text = new TextDecoder().decode(body(buf, value));
					else if (value.tag === 0x14) text = String.fromCharCode(...body(buf, value));
					else if (value.tag === 0x1e) {
						const b = body(buf, value);
						text = "";
						for (let i = 0; i + 1 < b.length; i += 2) text += String.fromCharCode((b[i] << 8) | b[i + 1]);
					} else text = `#${[...whole(buf, value)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
					if (!text.startsWith("#")) text = text.trim().replace(/\s+/g, " ").toLowerCase();
					return `${oid(buf, type)}=${text}`;
				})
				.sort()
				.join("+"),
		)
		.join(",");
}

// ---- certificates -------------------------------------------------------------------------------

const OID = {
	rsa: "1.2.840.113549.1.1.1",
	rsaPss: "1.2.840.113549.1.1.10",
	ec: "1.2.840.10045.2.1",
	keyUsage: "2.5.29.15",
	subjectAltName: "2.5.29.17",
	basicConstraints: "2.5.29.19",
	nameConstraints: "2.5.29.30",
	extKeyUsage: "2.5.29.37",
	serverAuth: "1.3.6.1.5.5.7.3.1",
	anyExtendedKeyUsage: "2.5.29.37.0",
};
// Extensions that may be critical without us acting on them beyond what is checked below.
const UNDERSTOOD = new Set([
	OID.keyUsage,
	OID.subjectAltName,
	OID.basicConstraints,
	OID.nameConstraints,
	OID.extKeyUsage,
	"2.5.29.14", // subjectKeyIdentifier
	"2.5.29.35", // authorityKeyIdentifier
	"2.5.29.31", // cRLDistributionPoints
	"2.5.29.32", // certificatePolicies
	"2.5.29.36", // policyConstraints
	"2.5.29.54", // inhibitAnyPolicy
	"1.3.6.1.5.5.7.1.1", // authorityInfoAccess
]);
const SIGNATURES = {
	"1.2.840.113549.1.1.11": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
	"1.2.840.113549.1.1.12": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
	"1.2.840.113549.1.1.13": { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
	"1.2.840.10045.4.3.2": { name: "ECDSA", hash: "SHA-256" },
	"1.2.840.10045.4.3.3": { name: "ECDSA", hash: "SHA-384" },
	"1.2.840.10045.4.3.4": { name: "ECDSA", hash: "SHA-512" },
};
const HASHES = { "2.16.840.1.101.3.4.2.1": "SHA-256", "2.16.840.1.101.3.4.2.2": "SHA-384", "2.16.840.1.101.3.4.2.3": "SHA-512" };
const CURVES = {
	"1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
	"1.3.132.0.34": { name: "P-384", size: 48 },
	"1.3.132.0.35": { name: "P-521", size: 66 },
};

function algorithm(buf, n) {
	const [id, params] = kids(buf, n);
	return { oid: oid(buf, id), params: params || null };
}

function generalNames(buf, n, into) {
	for (const g of kids(buf, n)) {
		if (g.tag === 0x82) into.dns.push(new TextDecoder().decode(body(buf, g)).toLowerCase());
		else if (g.tag === 0x87) into.ips.push(body(buf, g).slice());
	}
}

/** Reads a DER certificate. Throws on anything it cannot parse. */
export function parseCertificate(der) {
	const cert = node(der, 0);
	const [tbsNode, sigAlgNode, sigNode] = kids(der, cert);
	const tbs = kids(der, tbsNode);
	let i = 0;
	let version = 1;
	if (tbs[0].tag === 0xa0) {
		version = der[kids(der, tbs[0])[0].start] + 1;
		i++;
	}
	i += 2; // serialNumber, signature
	const issuer = tbs[i++];
	const [notBefore, notAfter] = kids(der, tbs[i++]);
	const subject = tbs[i++];
	const spki = tbs[i++];
	const keyAlg = algorithm(der, kids(der, spki)[0]);
	const c = {
		der,
		tbs: whole(der, tbsNode),
		sigAlg: algorithm(der, sigAlgNode),
		signature: der.subarray(sigNode.start + 1, sigNode.end), // BIT STRING minus the unused-bits byte
		version,
		issuer: nameKey(der, issuer),
		subject: nameKey(der, subject),
		notBefore: time(der, notBefore),
		notAfter: time(der, notAfter),
		spki: whole(der, spki),
		keyAlg: keyAlg.oid,
		curve: keyAlg.params && keyAlg.params.tag === 0x06 ? CURVES[oid(der, keyAlg.params)] || null : null,
		ca: false,
		pathLen: null,
		keyUsage: null,
		eku: null,
		san: null,
		permitted: null,
		excluded: null,
		unknownCritical: [],
	};
	for (; i < tbs.length; i++) {
		if (tbs[i].tag !== 0xa3) continue;
		for (const ext of kids(der, kids(der, tbs[i])[0])) {
			const parts = kids(der, ext);
			const id = oid(der, parts[0]);
			const critical = parts.length === 3 && parts[1].tag === 0x01 && der[parts[1].start] !== 0;
			const value = parts[parts.length - 1];
			const inner = node(der, value.start);
			if (id === OID.basicConstraints) {
				for (const f of kids(der, inner)) {
					if (f.tag === 0x01) c.ca = der[f.start] !== 0;
					else if (f.tag === 0x02) c.pathLen = [...body(der, f)].reduce((a, b) => a * 256 + b, 0);
				}
			} else if (id === OID.keyUsage) {
				const bits = body(der, inner);
				c.keyUsage = { digitalSignature: !!(bits[1] & 0x80), keyCertSign: !!(bits[1] & 0x04) };
			} else if (id === OID.extKeyUsage) {
				c.eku = kids(der, inner).map((k) => oid(der, k));
			} else if (id === OID.subjectAltName) {
				c.san = { dns: [], ips: [] };
				generalNames(der, inner, c.san);
			} else if (id === OID.nameConstraints) {
				for (const part of kids(der, inner)) {
					const into = { dns: [], ips: [] };
					for (const subtree of kids(der, part)) generalNames(der, { ...subtree }, into);
					if (part.tag === 0xa0) c.permitted = into;
					else if (part.tag === 0xa1) c.excluded = into;
				}
			} else if (critical && !UNDERSTOOD.has(id)) c.unknownCritical.push(id);
		}
	}
	return c;
}

// ---- signatures ---------------------------------------------------------------------------------

const keyCache = new WeakMap();

function importKey(cert, algo) {
	let byAlgo = keyCache.get(cert);
	if (!byAlgo) keyCache.set(cert, (byAlgo = new Map()));
	const id = JSON.stringify(algo);
	if (!byAlgo.has(id)) byAlgo.set(id, subtle.importKey("spki", cert.spki, algo, false, ["verify"]));
	return byAlgo.get(id);
}

// ECDSA signatures are DER SEQUENCE { r, s }; Web Crypto wants r || s at the curve's size.
function ecdsaRaw(sig, size) {
	const seq = node(sig, 0);
	const [r, s] = kids(sig, seq);
	const part = (n) => {
		let v = body(sig, n);
		while (v.length > size && v[0] === 0) v = v.subarray(1);
		if (v.length > size) throw new Error("bad ECDSA signature");
		const out = new Uint8Array(size);
		out.set(v, size - v.length);
		return out;
	};
	const out = new Uint8Array(size * 2);
	out.set(part(r));
	out.set(part(s), size);
	return out;
}

async function verifyWith(key, { name, hash, curve, salt }, signature, data) {
	try {
		if (name === "ECDSA") {
			if (key.keyAlg !== OID.ec || !key.curve || (curve && key.curve.name !== curve)) return false;
			const k = await importKey(key, { name: "ECDSA", namedCurve: key.curve.name });
			return await subtle.verify({ name: "ECDSA", hash }, k, ecdsaRaw(signature, key.curve.size), data);
		}
		if (key.keyAlg !== OID.rsa) return false;
		const k = await importKey(key, { name, hash });
		return await subtle.verify(name === "RSA-PSS" ? { name, saltLength: salt } : { name }, k, signature, data);
	} catch {
		return false;
	}
}

// RSASSA-PSS-params: hash [0], mask generation [1] (assumed MGF1 with the same hash), salt [2].
function pssParams(cert) {
	const p = cert.sigAlg.params;
	let hash = "SHA-1";
	let salt = 20;
	if (p && p.tag === 0x30) {
		for (const f of kids(cert.der, p)) {
			const inner = node(cert.der, f.start);
			if (f.tag === 0xa0) hash = HASHES[algorithm(cert.der, inner).oid] || "unsupported";
			else if (f.tag === 0xa2) salt = [...body(cert.der, inner)].reduce((a, b) => a * 256 + b, 0);
		}
	}
	return { name: "RSA-PSS", hash, salt };
}

function signedBy(cert, issuer) {
	const scheme = cert.sigAlg.oid === OID.rsaPss ? pssParams(cert) : SIGNATURES[cert.sigAlg.oid];
	if (!scheme || scheme.hash === "unsupported" || scheme.hash === "SHA-1") return false;
	return verifyWith(issuer, scheme, cert.signature, cert.tbs);
}

// TLS 1.3 CertificateVerify schemes we accept from servers (RFC 8446 section 4.2.3).
const HANDSHAKE_SCHEMES = {
	0x0403: { name: "ECDSA", hash: "SHA-256", curve: "P-256" },
	0x0503: { name: "ECDSA", hash: "SHA-384", curve: "P-384" },
	0x0603: { name: "ECDSA", hash: "SHA-512", curve: "P-521" },
	0x0804: { name: "RSA-PSS", hash: "SHA-256", salt: 32 },
	0x0805: { name: "RSA-PSS", hash: "SHA-384", salt: 48 },
	0x0806: { name: "RSA-PSS", hash: "SHA-512", salt: 64 },
};
/** signature_algorithms to offer: the handshake schemes above plus PKCS#1 for certificates. */
export const SIGNATURE_SCHEMES = [0x0403, 0x0503, 0x0603, 0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601];

/** Checks a CertificateVerify signature made with the leaf certificate's key. */
export async function verifyHandshakeSignature(leaf, scheme, signature, content) {
	const s = HANDSHAKE_SCHEMES[scheme];
	if (!s) throw new CertificateError(`server used an unsupported signature scheme 0x${scheme.toString(16)}`, 47);
	if (!(await verifyWith(leaf, s, signature, content))) throw new CertificateError("server CertificateVerify signature is invalid", 51);
}

// ---- names --------------------------------------------------------------------------------------

export function parseIp(host) {
	const h = host.replace(/^\[|\]$/g, "");
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (v4) {
		const b = v4.slice(1).map(Number);
		return b.every((x) => x < 256) ? new Uint8Array(b) : null;
	}
	if (!/^[0-9a-f:]+$/i.test(h) || !h.includes(":")) return null;
	const halves = h.split("::");
	if (halves.length > 2) return null;
	const words = (s) => (s ? s.split(":").map((x) => (x.length <= 4 ? parseInt(x, 16) : NaN)) : []);
	const head = words(halves[0]);
	const tail = halves.length === 2 ? words(halves[1]) : [];
	const fill = 8 - head.length - tail.length;
	if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
	const all = [...head, ...new Array(Math.max(0, fill)).fill(0), ...tail];
	if (all.some((w) => !(w >= 0 && w <= 0xffff))) return null;
	const out = new Uint8Array(16);
	all.forEach((w, i) => {
		out[2 * i] = w >> 8;
		out[2 * i + 1] = w & 0xff;
	});
	return out;
}

function dnsMatches(pattern, host) {
	if (pattern === host) return true;
	// A wildcard covers exactly one whole label, never a public suffix like "*.com".
	if (!pattern.startsWith("*.")) return false;
	const rest = pattern.slice(2);
	const dot = host.indexOf(".");
	return rest.includes(".") && dot > 0 && host.slice(dot + 1) === rest;
}

/** True if the certificate's subjectAltName covers the host (a DNS name or an IP literal). */
export function certificateMatchesHost(cert, host) {
	const h = host.toLowerCase().replace(/\.$/, "");
	if (!cert.san) return false;
	const ip = parseIp(h);
	if (ip) return cert.san.ips.some((a) => equalBytes(a, ip));
	return cert.san.dns.some((d) => dnsMatches(d.replace(/\.$/, ""), h));
}

function inSubtree(name, base) {
	const n = name.replace(/^\*\./, "x.");
	const b = base.toLowerCase().replace(/\.$/, "");
	if (!b) return true;
	if (b.startsWith(".")) return n.endsWith(b);
	return n === b || n.endsWith(`.${b}`);
}

function withinConstraints(leaf, ca) {
	const names = leaf.san?.dns || [];
	for (const name of names) {
		if (ca.excluded?.dns.some((b) => inSubtree(name, b))) return false;
		if (ca.permitted?.dns.length && !ca.permitted.dns.some((b) => inSubtree(name, b))) return false;
	}
	return true;
}

// ---- path validation ----------------------------------------------------------------------------

function fromBase64(s) {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Trusted roots, indexed by subject on first use. */
export class RootStore {
	constructor(ders) {
		this.ders = ders;
		this.bySubject = null;
	}

	static fromBase64(list) {
		return new RootStore(list.map(fromBase64));
	}

	candidates(name) {
		if (!this.bySubject) {
			this.bySubject = new Map();
			for (const der of this.ders) {
				let c;
				try {
					c = parseCertificate(der);
				} catch {
					continue;
				}
				if (!this.bySubject.has(c.subject)) this.bySubject.set(c.subject, []);
				this.bySubject.get(c.subject).push(c);
			}
		}
		return this.bySubject.get(name) || [];
	}
}

const serverAuthOk = (c) => !c.eku || c.eku.includes(OID.serverAuth) || c.eku.includes(OID.anyExtendedKeyUsage);

/**
 * Validates the chain a server sent (leaf first) for `host` against `roots`. Resolves with the
 * path (leaf … root); throws CertificateError saying what is wrong.
 */
export async function verifyServerChain(ders, host, roots, { now = Date.now() } = {}) {
	if (!ders.length) throw new CertificateError("the server sent no certificate");
	let leaf;
	try {
		leaf = parseCertificate(ders[0]);
	} catch {
		throw new CertificateError("the server's certificate could not be read");
	}
	if (now < leaf.notBefore) throw new CertificateError(`the certificate for ${host} is not valid yet`, 45);
	if (now > leaf.notAfter) throw new CertificateError(`the certificate for ${host} has expired`, 45);
	if (!certificateMatchesHost(leaf, host)) throw new CertificateError(`the server's certificate is not valid for ${host}`);
	if (!serverAuthOk(leaf)) throw new CertificateError(`the certificate for ${host} is not meant for servers`);
	if (leaf.unknownCritical.length) throw new CertificateError(`the certificate for ${host} has an unsupported critical extension`);

	const pool = [];
	for (const der of ders.slice(1)) {
		try {
			pool.push(parseCertificate(der));
		} catch {
			// unreadable extra certificates are ignored, like browsers do
		}
	}

	const usableCa = (c, below) =>
		c.version === 3 &&
		c.ca &&
		now >= c.notBefore &&
		now <= c.notAfter &&
		(c.pathLen === null || below <= c.pathLen) &&
		(!c.keyUsage || c.keyUsage.keyCertSign) &&
		serverAuthOk(c) &&
		!c.unknownCritical.length;

	// Depth-first search from the leaf towards a root; roots are tried first at every step.
	const build = async (cert, path) => {
		if (path.length > 8) return null;
		for (const root of roots.candidates(cert.issuer)) {
			if (equalBytes(root.der, cert.der)) return path;
			if (await signedBy(cert, root)) return [...path, root];
		}
		for (const ca of pool) {
			if (ca.subject !== cert.issuer || path.includes(ca) || !usableCa(ca, path.length - 1)) continue;
			if (!(await signedBy(cert, ca))) continue;
			const found = await build(ca, [...path, ca]);
			if (found) return found;
		}
		return null;
	};
	const path = await build(leaf, [leaf]);
	if (!path) throw new CertificateError(`the certificate for ${host} is not from a trusted authority`, 48);
	for (const ca of path.slice(1)) {
		if (!withinConstraints(leaf, ca)) throw new CertificateError(`the certificate for ${host} breaks its issuer's name constraints`);
	}
	return path;
}
