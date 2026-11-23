import assert from "node:assert/strict";
import { test } from "node:test";
import { fromHex, hex, readVarint, Writer } from "../src/js/lib/quic/bytes.js";
import { hkdfExpandLabel, hkdfExtract, initialKeys } from "../src/js/lib/quic/crypto.js";

// RFC 9001, Appendix A.1 and A.2.
test("initial secrets, IVs and header protection match RFC 9001", async () => {
	const dcid = fromHex("8394c8f03e515708");
	const initial = await hkdfExtract(fromHex("38762cf7f55934b34d179ae6a4c80cadccbb7f0a"), dcid);
	assert.equal(hex(await hkdfExpandLabel(initial, "client in", new Uint8Array(0), 32)), "c00cf151ca5be075ed0ebfb5c80323c42d6b7db67881289af4008f1f6c357aea");
	const { client, server } = await initialKeys(dcid);
	assert.equal(hex(client.iv), "fa044b2f42a3fd3b46fb255c");
	assert.equal(hex(server.iv), "0ac1493ca1905853b0bba03e");
	const mask = await client.mask(fromHex("d1b1c98dd7689fb8ec11d242b123dc9b"));
	assert.equal(hex(mask.subarray(0, 5)), "437b9aec36");
	// Sealing then opening round-trips, and the nonce mixes in the packet number.
	const header = fromHex("c300000001088394c8f03e5157080000449e00000002");
	const sealed = await client.seal(2, header, new Uint8Array([1, 2, 3]));
	assert.deepEqual([...(await client.open(2, header, sealed))], [1, 2, 3]);
	await assert.rejects(client.open(3, header, sealed));
});

test("varints round-trip at every size", () => {
	for (const v of [0, 37, 63, 64, 15293, 16383, 16384, 494878333, 2 ** 30, 2 ** 50 + 12345]) {
		const w = new Writer().varint(v).done();
		assert.equal(readVarint(w, 0), v, `value ${v}`);
	}
	assert.equal(hex(new Writer().varint(494878333).done()), "9d7f3e7d");
});
