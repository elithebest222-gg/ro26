import assert from "node:assert/strict";
import { test } from "node:test";
import { openWispUdp } from "../src/js/lib/quic/wisp-udp.js";

const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
const packet = (type, stream, payload = []) => new Uint8Array([type, ...u32(stream), ...payload]);

// A WebSocket whose "server" is a script reacting to what the client sends.
function fakeSocket(server) {
	return class FakeWebSocket {
		constructor(url) {
			this.url = url;
			this.readyState = 0;
			this.bufferedAmount = 0;
			this.sent = [];
			FakeWebSocket.last = this;
			setTimeout(() => {
				this.readyState = 1;
				server.open?.(this);
			}, 0);
		}
		send(data) {
			const bytes = new Uint8Array(data);
			this.sent.push(bytes);
			server.receive?.(this, bytes);
		}
		close() {
			this.readyState = 3;
		}
		deliver(bytes) {
			this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
		}
	};
}

test("Wisp v1: CONTINUE, then CONNECT for UDP, DATA both ways, CLOSE reasons", async () => {
	const WS = fakeSocket({ open: (ws) => ws.deliver(packet(0x03, 0, u32(128))) });
	const sock = await openWispUdp("ws://wisp.test/", "game.example", 443, { WebSocket: WS });
	const ws = WS.last;
	assert.equal(sock.version, 1);
	assert.deepEqual([...ws.sent[0]], [0x01, ...u32(1), 0x02, 443 & 0xff, 443 >> 8, ...new TextEncoder().encode("game.example")]);

	assert.equal(sock.send(new Uint8Array([9, 8, 7])), true);
	assert.deepEqual([...ws.sent[1]], [0x02, ...u32(1), 9, 8, 7]);

	const got = [];
	sock.onmessage = (d) => got.push([...d]);
	ws.deliver(packet(0x02, 1, [1, 2]));
	ws.deliver(packet(0x02, 7, [3])); // another stream: ignored
	ws.deliver(packet(0x03, 1, u32(5))); // CONTINUE on a UDP stream: ignored
	assert.deepEqual(got, [[1, 2]]);

	const closed = new Promise((resolve) => (sock.onclose = resolve));
	ws.deliver(packet(0x04, 1, [0x48]));
	const err = await closed;
	assert.equal(err.reason, 0x48);
	assert.match(err.message, /blocks this destination/);
	assert.equal(sock.send(new Uint8Array([1])), false);
});

test("Wisp v2: answers INFO asking for UDP, then connects", async () => {
	const motd = new TextEncoder().encode("hi");
	const WS = fakeSocket({
		open: (ws) => ws.deliver(packet(0x05, 0, [2, 0, 0x01, ...u32(0), 0x04, ...u32(motd.length), ...motd])),
		receive: (ws, bytes) => {
			if (bytes[0] === 0x05) ws.deliver(packet(0x03, 0, u32(128)));
		},
	});
	const sock = await openWispUdp("ws://wisp.test/", "10.0.0.1", 50000, { WebSocket: WS });
	const ws = WS.last;
	assert.equal(sock.version, 2);
	assert.deepEqual([...ws.sent[0]], [0x05, ...u32(0), 2, 0, 0x01, ...u32(0)]);
	assert.equal(ws.sent[1][0], 0x01);
	assert.equal(ws.sent[1][5], 0x02);
});

test("Wisp v2 servers without UDP, or that need a password, are refused with a reason", async () => {
	const noUdp = fakeSocket({ open: (ws) => ws.deliver(packet(0x05, 0, [2, 0])) });
	await assert.rejects(openWispUdp("ws://wisp.test/", "h", 1, { WebSocket: noUdp }), /does not allow UDP/);
	const password = fakeSocket({ open: (ws) => ws.deliver(packet(0x05, 0, [2, 0, 0x01, ...u32(0), 0x02, ...u32(1), 1])) });
	await assert.rejects(openWispUdp("ws://wisp.test/", "h", 1, { WebSocket: password }), /requires a password/);
});

test("connection failures and silence are reported", async () => {
	const refused = fakeSocket({
		open: (ws) => {
			ws.onerror?.({});
			ws.onclose?.({ code: 1006 });
		},
	});
	await assert.rejects(openWispUdp("ws://wisp.test/", "h", 1, { WebSocket: refused }), /could not connect to the Wisp server/);
	const silent = fakeSocket({});
	await assert.rejects(openWispUdp("ws://wisp.test/", "h", 1, { WebSocket: silent, timeout: 30 }), /did not finish its handshake/);
	await assert.rejects(openWispUdp("not a url", "h", 1), /address is invalid/);
});

test("drops datagrams instead of queueing behind a full WebSocket", async () => {
	const WS = fakeSocket({ open: (ws) => ws.deliver(packet(0x03, 0, u32(128))) });
	const sock = await openWispUdp("ws://wisp.test/", "h", 1, { WebSocket: WS });
	WS.last.bufferedAmount = 64 * 1024 * 1024;
	assert.equal(sock.send(new Uint8Array(10)), false);
	assert.equal(sock.dropped, 1);
});
