// The player's network worker. It owns the Wisp connection, the cookie jar and the request
// rewriting, off the main thread: requests from the engine's pthread workers (some of them
// synchronous XHR) then never wait on a main thread that is busy running the game.
//
// Messages:  init {options} -> ready | error,  set-join {join},  port (MessagePort) to serve.
// On a served port: { id, req } -> { id, res } (raw request, used by the service worker)
//                   { id, api: { href, init } } -> { id, data } (JSON helper, used by the page)

import { PersistentJar } from "../js/lib/cookie-store.js";
import { createEpoxyClient } from "../js/lib/epoxy.js";
import { RobloxNet } from "../js/lib/robloxnet.js";
import { importScramjetSession } from "../js/lib/scramjet-session.js";

let netReady = null;

async function init(options) {
	const jar = await PersistentJar.open();
	try {
		if (await importScramjetSession(jar)) console.info("[webblox] imported the Roblox session from the sign-in browser");
	} catch (err) {
		console.warn("[webblox] could not read the sign-in browser's session:", err);
	}
	const client = await createEpoxyClient(options.wispUrl, { rootCerts: options.rootCerts || [] });
	const net = new RobloxNet({ client, jar, engine: options.engine, flagOverrides: options.flagOverrides, join: options.join });
	const diag = new BroadcastChannel("webblox:diag");
	net.onGameJoin = (info) => diag.postMessage({ kind: "join", where: "network worker", at: Date.now(), ...info });
	return net;
}

function serve(port) {
	port.onmessage = async (e) => {
		const { id, req, api } = e.data || {};
		try {
			const net = await netReady;
			if (!net) throw new Error("network worker is not initialised");
			if (api) {
				port.postMessage({ id, data: await net.api(api.href, api.init) });
				return;
			}
			const res = await net.request(req);
			port.postMessage({ id, res }, res.body instanceof ArrayBuffer ? [res.body] : []);
		} catch (err) {
			port.postMessage({ id, error: String(err?.message || err), status: err?.status });
		}
	};
}

self.onmessage = (e) => {
	const msg = e.data || {};
	if (msg.type === "init") {
		netReady = init(msg.options);
		netReady.then(
			() => self.postMessage({ type: "ready" }),
			(err) => self.postMessage({ type: "error", message: String(err?.message || err) }),
		);
	} else if (msg.type === "set-join") {
		netReady?.then((net) => {
			net.join = msg.join?.gameId ? { placeId: String(msg.join.placeId), gameId: String(msg.join.gameId), done: false } : null;
		});
	} else if (msg.type === "port" && e.ports[0]) {
		serve(e.ports[0]);
	}
};
