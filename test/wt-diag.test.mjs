import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the WebTransport recorder still works when minified, stringified and run on its own", async () => {
	// Build the prelude the way the player's service worker does.
	const built = await esbuild.build({
		stdin: {
			contents: 'import { installWebTransportDiag } from "./src/js/lib/wt-diag.js"; globalThis.__prelude = `;try{(${installWebTransportDiag.toString()})(self)}catch(e){}`;',
			resolveDir: ROOT,
		},
		bundle: true,
		minify: true,
		write: false,
		format: "iife",
		target: ["chrome110", "firefox115", "safari16.4"],
	});
	new Function(built.outputFiles[0].text)();
	const prelude = globalThis.__prelude;

	class FakeWebTransport {
		constructor(url, options) {
			this.url = url;
			this.options = options;
			this.ready = Promise.reject(Object.assign(new Error("Opening handshake failed."), { name: "WebTransportError", source: "session" }));
			this.closed = new Promise(() => {});
		}
	}
	// A stand-in channel: a real one would keep the test process alive.
	const seen = [];
	class FakeChannel {
		constructor(name) {
			assert.equal(name, "webblox:diag");
		}
		postMessage(m) {
			seen.push(structuredClone(m));
		}
	}
	const scope = { WebTransport: FakeWebTransport, BroadcastChannel: FakeChannel, name: "em-pthread" };
	new Function("self", prelude)(scope);
	assert.notEqual(scope.WebTransport, FakeWebTransport, "WebTransport was not wrapped (the prelude threw)");

	const wt = new scope.WebTransport("https://0123456789abcdef-a0b0c0d-d188.80742106.qdmux.roblox.com:443/session", { serverCertificateHashes: [{}, {}] });
	assert.ok(wt instanceof FakeWebTransport);
	await new Promise((r) => setTimeout(r, 20));
	const open = seen.find((m) => m.kind === "wt-open");
	const fail = seen.find((m) => m.kind === "wt-fail");
	assert.ok(open && fail, `expected open and fail reports, got ${JSON.stringify(seen)}`);
	assert.equal(open.where, "em-pthread");
	assert.equal(open.certHashes, 2);
	assert.match(open.url, /^https:\/\/0123…-a0b0c0d-d188\.80742106\.qdmux\.roblox\.com /);
	assert.ok(!open.url.includes("0123456789abcdef"), "token was not masked");
	assert.match(fail.error, /WebTransportError: Opening handshake failed\. \[source session\]/);
});
