// Service worker for the player (scope: player/).
//
// 1. Cross-origin isolation on a static host: GitHub Pages cannot send COOP/COEP headers, so
//    every same-origin response under this scope is re-issued with them. The engine needs
//    that for its shared WebAssembly.Memory and pthread workers.
// 2. Engine files: player/engine/<version>/* is served from the copy deployed with the site,
//    or from Roblox's CDN when the site was built without one, and kept in a per-version cache.
// 3. Roblox traffic: fetch/XHR from the page and from the engine's workers to *.roblox.com and
//    *.rbxcdn.com is handed to the page's network worker, which sends it over Wisp.

import { isProxiedHost, isRbxCdnHost } from "../js/lib/hosts.js";
import { installWebTransportDiag } from "../js/lib/wt-diag.js";

// Put in front of WebClient.js when the engine starts one of its worker threads, so WebTransport
// attempts made there show up in the player's diagnostics too.
const WORKER_PRELUDE = `;try{(${installWebTransportDiag.toString()})(self)}catch(e){}\n`;

const SCOPE = new URL(self.registration.scope);
const ORIGIN = self.location.origin;
const ENGINE_CACHE_PREFIX = "webblox-engine-";
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

let engineConfigPromise = null;
function engineConfig() {
	if (!engineConfigPromise) {
		engineConfigPromise = fetch(new URL("engine.json", SCOPE), { cache: "no-cache" })
			.then((r) => (r.ok ? r.json() : null))
			.then((cfg) => {
				if (cfg) pruneEngineCaches(cfg.clientVersionUpload);
				return cfg;
			})
			.catch(() => null);
		engineConfigPromise.then((cfg) => {
			if (!cfg) engineConfigPromise = null;
		});
	}
	return engineConfigPromise;
}

async function pruneEngineCaches(keep) {
	for (const name of await caches.keys()) {
		if (name.startsWith(ENGINE_CACHE_PREFIX) && name !== ENGINE_CACHE_PREFIX + keep) await caches.delete(name);
	}
}

self.addEventListener("fetch", (event) => {
	const req = event.request;
	let url;
	try {
		url = new URL(req.url);
	} catch {
		return;
	}
	if (url.origin === ORIGIN) {
		if (url.pathname.endsWith("/__webblox/probe")) event.respondWith(probe(url));
		else if (req.method === "GET" || req.method === "HEAD") event.respondWith(sameOrigin(event, url));
		return;
	}
	if (url.protocol === "https:" && isProxiedHost(url.hostname)) event.respondWith(proxied(event, url));
	// Anything else is left to the browser.
});

function isolate(res, { method = "GET", extra = {} } = {}) {
	if (res.type === "opaqueredirect" || res.status === 0) return res;
	const headers = new Headers(res.headers);
	// The body is already decoded, so the original length/encoding no longer describe it.
	headers.delete("content-encoding");
	headers.delete("content-length");
	headers.set("Cross-Origin-Opener-Policy", "same-origin");
	headers.set("Cross-Origin-Embedder-Policy", "require-corp");
	headers.set("Cross-Origin-Resource-Policy", "same-origin");
	for (const [k, v] of Object.entries(extra)) headers.set(k, v);
	const body = method === "HEAD" || NULL_BODY.has(res.status) ? null : res.body;
	return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

async function sameOrigin(event, url) {
	const req = event.request;
	const cfg = await engineConfig();
	const enginePrefix = cfg ? new URL(`engine/${cfg.clientVersionUpload}/`, SCOPE).href : null;
	const href = url.href.split("#")[0];
	if (!enginePrefix || !href.startsWith(enginePrefix)) {
		try {
			return isolate(await fetch(req), { method: req.method });
		} catch {
			return Response.error();
		}
	}

	const rel = href.slice(enginePrefix.length).split("?")[0];
	const extra = {};
	if (rel === "WebClient.wasm") {
		extra["Content-Type"] = "application/wasm";
		// WasmPlayer.js shows download progress from Content-Length.
		if (cfg.wasmSize) extra["Content-Length"] = String(cfg.wasmSize);
	}
	try {
		let res = await engineFile(event, cfg, rel, href);
		if (rel === "WebClient.js" && req.destination === "worker" && res.ok) {
			res = new Response(WORKER_PRELUDE + (await res.text()), {
				status: 200,
				headers: { "Content-Type": "text/javascript; charset=utf-8" },
			});
		}
		return isolate(res, { method: req.method, extra });
	} catch (err) {
		console.warn("[webblox] engine file failed:", rel, err);
		return Response.error();
	}
}

// Engine files never change within a version, so they are cached by version, which also
// keeps the ~100 MB WebClient.wasm out of the HTTP cache's size limits.
async function engineFile(event, cfg, rel, href) {
	const cache = await caches.open(ENGINE_CACHE_PREFIX + cfg.clientVersionUpload);
	const hit = await cache.match(href);
	if (hit) return hit;
	let res;
	if (cfg.mode === "cdn" && !rel.startsWith("flags/")) {
		res = await fetch(cfg.cdnBase + rel, { mode: "cors", credentials: "omit" });
	} else if (rel === "WebClient.wasm" && cfg.wasmParts?.length) {
		res = new Response(joinParts(cfg.wasmParts.map((p) => new URL(p.name, href).href)), {
			status: 200,
			headers: { "Content-Type": "application/wasm" },
		});
	} else {
		res = await fetch(href, { credentials: "same-origin" });
	}
	if (res.status === 200) {
		const copy = new Response(res.clone().body, {
			status: 200,
			headers: { "Content-Type": res.headers.get("Content-Type") || "application/octet-stream" },
		});
		event.waitUntil(cache.put(href, copy).catch(() => {}));
	}
	return res;
}

// Streams the parts of a split file in order, all of them requested up front.
function joinParts(urls) {
	const responses = urls.map((u) => fetch(u, { credentials: "same-origin" }));
	let index = 0;
	let reader = null;
	return new ReadableStream({
		async pull(controller) {
			for (;;) {
				if (!reader) {
					if (index >= responses.length) {
						controller.close();
						return;
					}
					const res = await responses[index++];
					if (!res.ok || !res.body) throw new Error(`engine part ${index - 1}: HTTP ${res.status}`);
					reader = res.body.getReader();
				}
				const { done, value } = await reader.read();
				if (done) {
					reader = null;
					continue;
				}
				controller.enqueue(value);
				return;
			}
		},
		cancel(reason) {
			reader?.cancel(reason);
		},
	});
}

// Diagnostics: can this browser reach a Roblox host directly, outside the Wisp tunnel? The game
// connection (WebTransport) cannot use the tunnel, so a network that blocks Roblox breaks it.
async function probe(url) {
	let result;
	try {
		const target = new URL(url.searchParams.get("url"));
		if (target.protocol !== "https:" || !isProxiedHost(target.hostname)) throw new Error("not a Roblox URL");
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 6000);
		const t0 = Date.now();
		try {
			await fetch(target.href, { mode: "no-cors", credentials: "omit", cache: "no-store", signal: ctrl.signal });
			result = { ok: true, ms: Date.now() - t0 };
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		result = { ok: false, error: err?.name === "AbortError" ? "timed out after 6 s" : String(err?.message || err) };
	}
	return new Response(JSON.stringify(result), {
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" },
	});
}

// ---- Roblox traffic -------------------------------------------------------------------------

const STRIP = new Set([
	"connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length",
	"set-cookie", "set-cookie2", "alt-svc", "strict-transport-security", "report-to", "nel",
	"content-security-policy", "content-security-policy-report-only",
	"cross-origin-resource-policy", "cross-origin-embedder-policy", "cross-origin-opener-policy",
	"access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers",
	"access-control-allow-headers", "access-control-allow-methods", "access-control-max-age",
]);

// A synthetic response for a cross-origin request. CORP lets the COEP page embed it; the
// CORS headers (with every header name listed, since "*" does not count for credentialed
// requests) let the engine read headers such as x-csrf-token.
function syntheticResponse({ status, statusText, headers, body }, method) {
	const out = new Headers();
	const names = new Set();
	for (const [k, v] of headers) {
		const name = k.toLowerCase();
		if (STRIP.has(name)) continue;
		try {
			out.append(name, v);
			names.add(name);
		} catch {
			// header values the Headers class rejects are dropped
		}
	}
	out.set("Access-Control-Allow-Origin", ORIGIN);
	out.set("Access-Control-Allow-Credentials", "true");
	if (names.size) out.set("Access-Control-Expose-Headers", [...names].join(", "));
	out.set("Cross-Origin-Resource-Policy", "cross-origin");
	out.set("Timing-Allow-Origin", "*");
	const code = status >= 200 && status <= 599 ? status : 502;
	const nullBody = method === "HEAD" || NULL_BODY.has(code);
	return new Response(nullBody ? null : body, { status: code, statusText: statusText || "", headers: out });
}

// rbxcdn content is public; when the browser can reach it directly with CORS, that is
// cheaper than tunnelling it. Hosts that fail are sent through Wisp for a while.
const directFailed = new Map();
async function tryDirect(req, url) {
	const failedAt = directFailed.get(url.hostname);
	if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) return null;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 8000);
	try {
		const res = await fetch(url.href, { method: req.method, mode: "cors", credentials: "omit", redirect: "follow", signal: ctrl.signal });
		clearTimeout(timer);
		if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
		return syntheticResponse({ status: res.status, statusText: res.statusText, headers: [...res.headers], body: res.body }, req.method);
	} catch {
		clearTimeout(timer);
		directFailed.set(url.hostname, Date.now());
		return null;
	}
}

async function proxied(event, url) {
	const req = event.request;
	try {
		if (isRbxCdnHost(url.hostname) && (req.method === "GET" || req.method === "HEAD")) {
			const direct = await tryDirect(req, url);
			if (direct) return direct;
		}
		const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
		const res = await bridgeCall(
			{ url: req.url, method: req.method, headers: [...req.headers], body, credentials: req.credentials, destination: req.destination },
			body ? [body] : [],
		);
		return syntheticResponse(res, req.method);
	} catch (err) {
		console.warn("[webblox] request failed:", req.method, url.href, err?.message || err);
		return Response.error();
	}
}

// ---- Bridge to the page's network worker --------------------------------------------------
// Each player page hands this worker a MessagePort to its network worker. Service workers
// can be stopped and restarted at any time, losing the ports, so when none is known the
// pages are asked for a fresh one.

const bridges = new Map(); // clientId -> { port, pending, at, checkedAt }
const waiters = [];
let nextId = 1;

self.addEventListener("message", (event) => {
	const data = event.data;
	if (data?.type === "webblox:bridge" && event.ports[0]) attachBridge(event.source?.id || `anon-${nextId++}`, event.ports[0]);
});

function failPending(bridge, why) {
	for (const p of bridge.pending.values()) {
		clearTimeout(p.timer);
		p.reject(new Error(why));
	}
	bridge.pending.clear();
}

function attachBridge(clientId, port) {
	const old = bridges.get(clientId);
	if (old) failPending(old, "bridge replaced");
	const bridge = { clientId, port, pending: new Map(), at: Date.now(), checkedAt: Date.now() };
	port.onmessage = (e) => {
		const { id, res, error } = e.data || {};
		const p = bridge.pending.get(id);
		if (!p) return;
		bridge.pending.delete(id);
		clearTimeout(p.timer);
		if (error) p.reject(new Error(error));
		else p.resolve(res);
	};
	bridges.set(clientId, bridge);
	for (const resolve of waiters.splice(0)) resolve(bridge);
}

async function liveBridge() {
	const list = [...bridges.values()].sort((a, b) => b.at - a.at);
	for (const b of list) {
		if (Date.now() - b.checkedAt < 5000 || b.clientId.startsWith("anon-")) return b;
		if (await self.clients.get(b.clientId)) {
			b.checkedAt = Date.now();
			return b;
		}
		failPending(b, "player page closed");
		bridges.delete(b.clientId);
	}
	return null;
}

async function getBridge() {
	const live = await liveBridge();
	if (live) return live;
	const answered = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no player page answered")), 20000);
		waiters.push((b) => {
			clearTimeout(timer);
			resolve(b);
		});
	});
	for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "webblox:need-bridge" });
	return answered;
}

async function bridgeCall(req, transfer) {
	const bridge = await getBridge();
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			bridge.pending.delete(id);
			reject(new Error("network worker timed out"));
		}, 120000);
		bridge.pending.set(id, { resolve, reject, timer });
		bridge.port.postMessage({ id, req }, transfer);
	});
}
