import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RootStore, certificateMatchesHost, parseCertificate, parseIp, verifyHandshakeSignature, verifyServerChain } from "../src/js/lib/quic/x509.js";

// A throwaway PKI (see the "note" field): root (RSA) -> intermediate (P-384, pathLen 0) -> leaves.
const fx = JSON.parse(readFileSync(new URL("./fixtures/test-pki.json", import.meta.url), "utf8"));
const der = (name) => new Uint8Array(Buffer.from(fx[name], "base64"));
const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const roots = () => new RootStore([der("root")]);

test("parses the fields TLS needs", () => {
	const leaf = parseCertificate(der("leaf"));
	assert.equal(leaf.version, 3);
	assert.equal(leaf.ca, false);
	assert.equal(leaf.curve.name, "P-256");
	assert.match(leaf.subject, /2\.5\.4\.3=localhost/);
	assert.deepEqual(leaf.san.dns, ["localhost", "wt.webblox.test"]);
	assert.deepEqual([...leaf.san.ips[0]], [127, 0, 0, 1]);
	assert.ok(leaf.eku.includes("1.3.6.1.5.5.7.3.1"));
	assert.equal(leaf.notBefore, Date.UTC(2025, 0, 1));
	assert.equal(leaf.notAfter, Date.UTC(2125, 0, 1));

	const inter = parseCertificate(der("inter"));
	assert.equal(inter.ca, true);
	assert.equal(inter.pathLen, 0);
	assert.equal(inter.keyUsage.keyCertSign, true);
	assert.equal(inter.curve.name, "P-384");
	assert.equal(leaf.issuer, inter.subject);
});

test("accepts a valid chain for every name in the certificate", async () => {
	const path = await verifyServerChain([der("leaf"), der("inter")], "localhost", roots());
	assert.equal(path.length, 3);
	await verifyServerChain([der("leaf"), der("inter")], "WT.webblox.test.", roots());
	await verifyServerChain([der("leaf"), der("inter")], "127.0.0.1", roots());
	// Unrelated extra certificates and odd order are fine.
	await verifyServerChain([der("leaf"), der("otherRoot"), der("inter"), der("root")], "localhost", roots());
});

test("rejects a certificate for another host", async () => {
	await assert.rejects(verifyServerChain([der("leaf"), der("inter")], "example.com", roots()), /not valid for example\.com/);
	await assert.rejects(verifyServerChain([der("leaf"), der("inter")], "127.0.0.2", roots()), /not valid for/);
});

test("rejects chains that do not reach a trusted root", async () => {
	await assert.rejects(verifyServerChain([der("leaf")], "localhost", roots()), /trusted authority/);
	await assert.rejects(verifyServerChain([der("leaf"), der("inter")], "localhost", new RootStore([der("otherRoot")])), /trusted authority/);
	await assert.rejects(verifyServerChain([], "localhost", roots()), /no certificate/);
	await assert.rejects(verifyServerChain([new Uint8Array([0x30, 0x03, 1, 2, 3])], "localhost", roots()), /could not be read/);
});

test("checks validity dates", async () => {
	const chain = [der("leaf"), der("inter")];
	await assert.rejects(verifyServerChain(chain, "localhost", roots(), { now: Date.UTC(2125, 0, 2) }), /has expired/);
	await assert.rejects(verifyServerChain(chain, "localhost", roots(), { now: Date.UTC(2024, 11, 31) }), /not valid yet/);
});

test("wildcards cover exactly one label", async () => {
	const chain = [der("wild"), der("inter")];
	await verifyServerChain(chain, "0a1b-0a25024a-df70.qdmux.webblox.test", roots());
	// Two labels (like Roblox's "<token>-<addr>-<port>.<relay>.qdmux…") need "*.<relay>.qdmux…".
	await assert.rejects(verifyServerChain(chain, "0a1b-0a25024a-df70.80740223.qdmux.webblox.test", roots()), /not valid for/);
	await assert.rejects(verifyServerChain(chain, "qdmux.webblox.test", roots()), /not valid for/);
	const fake = { san: { dns: ["*.com", "f*o.webblox.test"], ips: [] } };
	assert.equal(certificateMatchesHost(fake, "example.com"), false);
	assert.equal(certificateMatchesHost(fake, "foo.webblox.test"), false);
});

test("verifies RSA PKCS#1 and RSA-PSS certificate signatures", async () => {
	await verifyServerChain([der("rsaLeaf")], "rsa.webblox.test", roots());
	await verifyServerChain([der("pssLeaf")], "pss.webblox.test", roots());
});

test("enforces CA rules: basicConstraints, pathLen, name constraints, critical extensions", async () => {
	await assert.rejects(verifyServerChain([der("underFake"), der("fakeCa")], "victim.webblox.test", roots()), /trusted authority/);
	await assert.rejects(verifyServerChain([der("underSub"), der("sub"), der("inter")], "deep.webblox.test", roots()), /trusted authority/);
	await verifyServerChain([der("ncOk"), der("ncInter")], "a.allowed.webblox.test", roots());
	await assert.rejects(verifyServerChain([der("ncBad"), der("ncInter")], "b.denied.webblox.test", roots()), /name constraints/);
	await assert.rejects(verifyServerChain([der("crit"), der("inter")], "crit.webblox.test", roots()), /critical extension/);
});

test("checks CertificateVerify signatures against the scheme and key", async () => {
	const content = b64(fx.signatures.content);
	const leaf = parseCertificate(der("leaf"));
	await verifyHandshakeSignature(leaf, 0x0403, b64(fx.signatures.ecdsaP256), content);
	await assert.rejects(verifyHandshakeSignature(leaf, 0x0403, b64(fx.signatures.ecdsaP256), content.slice(1)), /invalid/);
	// P-256 key with the P-384 scheme: refused.
	await assert.rejects(verifyHandshakeSignature(leaf, 0x0503, b64(fx.signatures.ecdsaP256), content), /invalid/);
	await verifyHandshakeSignature(parseCertificate(der("inter")), 0x0503, b64(fx.signatures.ecdsaP384), content);
	await verifyHandshakeSignature(parseCertificate(der("rsaLeaf")), 0x0804, b64(fx.signatures.rsaPss), content);
	await assert.rejects(verifyHandshakeSignature(parseCertificate(der("rsaLeaf")), 0x0401, b64(fx.signatures.rsaPss), content), /unsupported signature scheme/);
});

test("reads IP literals", () => {
	assert.deepEqual([...parseIp("10.0.0.1")], [10, 0, 0, 1]);
	assert.equal(parseIp("10.0.0.256"), null);
	assert.equal(parseIp("example.com"), null);
	assert.deepEqual([...parseIp("[::1]")], [...new Array(15).fill(0), 1]);
	assert.deepEqual([...parseIp("2001:db8::8:1")].slice(0, 4), [0x20, 0x01, 0x0d, 0xb8]);
	assert.equal(parseIp("1::2::3"), null);
});
