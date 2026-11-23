// epoxy-tls runs TLS inside the browser and tunnels the TCP stream over a Wisp WebSocket,
// so a static page can talk HTTPS to hosts that do not allow it via CORS.

import initEpoxy, { EpoxyClient, EpoxyClientOptions, EpoxyHandlers } from "@mercuryworkshop/epoxy-tls";
import { devRootCerts } from "./settings.js";

let wasmReady = null;

export async function createEpoxyClient(wispUrl, { rootCerts = devRootCerts() } = {}) {
	wasmReady ||= initEpoxy();
	await wasmReady;
	const options = new EpoxyClientOptions();
	options.user_agent = navigator.userAgent;
	options.redirect_limit = 0;
	if (rootCerts.length) options.pem_files = rootCerts;
	return new EpoxyClient(wispUrl, options);
}

export const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

// epoxy reports connection failures as raw hyper/rustls errors; say what actually happened.
function describe(err, url) {
	const msg = String(err?.message || err);
	const host = new URL(url).host;
	if (/tls handshake eof|connection (refused|reset)|stream closed|ConnectionRefused|UnexpectedEof/i.test(msg)) {
		return `the Wisp server could not connect to ${host}`;
	}
	if (/websocket|wisp/i.test(msg)) return `the Wisp server is unreachable (${msg.slice(0, 120)})`;
	if (/certificate|webpki|UnknownIssuer/i.test(msg)) return `${host} presented a certificate that did not verify`;
	return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

function headerPairs(raw) {
	const out = [];
	for (const [key, value] of Object.entries(raw || {})) {
		const name = key.toLowerCase();
		if (Array.isArray(value)) for (const v of value) out.push([name, String(v)]);
		else out.push([name, String(value)]);
	}
	return out;
}

function withTimeout(promise, ms, what) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

// One HTTPS request through epoxy. Redirects are returned, not followed, so callers decide.
// Resolves { status, statusText, headers: [[name, value]], body: ArrayBuffer | null }.
export async function epoxyRequest(client, url, { method = "GET", headers = {}, body = null, timeout = 60000 } = {}) {
	const send = async () => {
		const res = await withTimeout(
			client.fetch(url, { method, headers, body: body ?? undefined, redirect: "manual" }),
			timeout,
			`${method} ${new URL(url).host}`,
		);
		const pairs = headerPairs(res.rawHeaders);
		const noBody = method === "HEAD" || NULL_BODY_STATUS.has(res.status);
		const buf = noBody ? null : await withTimeout(res.arrayBuffer(), timeout, `reading ${new URL(url).host}`);
		return { status: res.status, statusText: res.statusText || "", headers: pairs, body: buf };
	};
	try {
		return await send();
	} catch (err) {
		// A dropped Wisp socket surfaces as a failed request; reconnect once for requests that
		// are safe to repeat.
		if (method === "GET" || method === "HEAD") {
			try {
				await client.replace_stream_provider();
				return await send();
			} catch (again) {
				err = again;
			}
		}
		throw new Error(describe(err, url), { cause: err });
	}
}

// Scramjet 2's ProxyTransport interface, backed by a shared EpoxyClient.
export class EpoxyTransport {
	constructor(getClient) {
		this.getClient = getClient;
		this.client = null;
		this.ready = false;
	}

	async init() {
		this.client = await this.getClient();
		this.ready = true;
	}

	async request(remote, method, body, headers) {
		if (!this.client) await this.init();
		if (body instanceof Blob) body = await body.arrayBuffer();
		else if (body instanceof ReadableStream) body = await new Response(body).arrayBuffer();
		const obj = {};
		for (const [k, v] of headers) obj[k] = v;
		const res = await this.client.fetch(remote.href, { method, body: body ?? undefined, headers: obj, redirect: "manual" });
		return { body: res.body, headers: headerPairs(res.rawHeaders), status: res.status, statusText: res.statusText || "" };
	}

	connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
		const handlers = new EpoxyHandlers(
			() => onopen("", ""),
			() => onclose(1000, ""),
			(err) => onerror(String(err)),
			(data) => onmessage(data instanceof Uint8Array ? data.slice().buffer : data),
		);
		const headers = {};
		for (const [k, v] of requestHeaders) headers[k] = v;
		const ws = (this.client ? Promise.resolve() : this.init()).then(() =>
			this.client.connect_websocket(handlers, url.href, protocols, headers),
		);
		ws.catch((err) => onerror(String(err)));
		return [
			async (data) => {
				if (data instanceof Blob) data = await data.arrayBuffer();
				(await ws).send(data);
			},
			async (code, reason) => {
				(await ws).close(code ?? 1000, reason || "");
			},
		];
	}
}
