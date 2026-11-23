// Everything the engine sends to *.roblox.com / *.rbxcdn.com ends up here (in the player's
// network worker), and so do the launcher's own API calls. Requests leave over Wisp via
// epoxy, with this module playing the part of the browser: cookies, CSRF tokens, and the
// request/response fix-ups the web client needs when it is not running on roblox.com.

import { NULL_BODY_STATUS, epoxyRequest } from "./epoxy.js";
import { isProxiedHost, isRobloxHost } from "./hosts.js";

export { isProxiedHost, isRbxCdnHost, isRobloxHost } from "./hosts.js";

const WEBSITE = "https://www.roblox.com";
const GAMEJOIN = "gamejoin.roblox.com";

// Headers the browser would own, or that must be recomputed for the real request.
const DROP_HEADERS = new Set([
	"host", "connection", "keep-alive", "content-length", "transfer-encoding", "te", "trailer", "upgrade",
	"cookie", "cookie2", "origin", "referer", "user-agent", "accept-encoding", "priority",
	"proxy-authorization", "proxy-connection",
]);

const enc = new TextEncoder();
const dec = new TextDecoder();

// The engine identifies itself as "Roblox/Web … Desktop … Browser/…". Roblox's backend treats
// that as a browser session; the native client identities are what the APIs expect from a
// game client. Game join is sent as the macOS client, everything else as the Windows one.
export function rewriteRbxUserAgent(value, host) {
	if (host === GAMEJOIN) return "Roblox/Darwin";
	if (typeof value === "string" && /^Roblox\/Web\b/.test(value)) return "Roblox/WinInet";
	return value;
}

function ipv4ToInt(ip) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || "").trim());
	if (!m) return null;
	const o = m.slice(1).map(Number);
	if (o.some((n) => n > 255)) return null;
	return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function tokenToHex(token) {
	if (typeof token === "number" && Number.isFinite(token)) return BigInt(Math.trunc(token)).toString(16);
	if (typeof token === "bigint") return token.toString(16);
	if (typeof token !== "string" || !token) return null;
	if (/^\d+$/.test(token)) return BigInt(token).toString(16);
	if (/^(0x)?[0-9a-f]+$/i.test(token)) return token.replace(/^0x/i, "").toLowerCase();
	try {
		const bin = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
		return [...bin].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
	} catch {
		return null;
	}
}

// Depth-first search for the first key (case-insensitive) in a parsed join script.
function findKey(obj, names, depth = 0) {
	if (!obj || typeof obj !== "object" || depth > 4) return undefined;
	const wanted = names.map((n) => n.toLowerCase());
	for (const [k, v] of Object.entries(obj)) if (wanted.includes(k.toLowerCase()) && v !== null && v !== "") return v;
	for (const v of Object.values(obj)) {
		const hit = findKey(v, names, depth + 1);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

// The WASM client only connects over WebTransport and needs joinScript.gameFqdn. When the
// join response leaves it out, it can be rebuilt from the rest of the join script:
//   <netstack token>-<MachineAddress>-<NetStackPort>.<UdmuxEndpoints[0].Address + 1>.qdmux.roblox.com
// with every part in hex, the UDMUX address taken with its last octet incremented.
export function buildGameFqdn(joinScript) {
	if (!joinScript || typeof joinScript !== "object") return null;
	const token = tokenToHex(findKey(joinScript, ["NetStackTokenValue", "NetStackToken", "RbxTransportToken"]));
	const machine = ipv4ToInt(joinScript.MachineAddress ?? findKey(joinScript, ["MachineAddress"]));
	const port = Number(findKey(joinScript, ["NetStackPort"]) ?? joinScript.ServerPort);
	const endpoints = joinScript.UdmuxEndpoints ?? findKey(joinScript, ["UdmuxEndpoints"]);
	const udmux = ipv4ToInt(Array.isArray(endpoints) ? endpoints[0]?.Address : null);
	if (!token || machine === null || !Number.isInteger(port) || port <= 0 || udmux === null) return null;
	const edge = ((udmux & 0xffffff00) >>> 0) + (((udmux & 0xff) + 1) & 0xff);
	return `${token}-${machine.toString(16)}-${port.toString(16)}.${edge.toString(16)}.qdmux.roblox.com`;
}

const json = (status, obj, extra = []) => ({
	status,
	statusText: status === 200 ? "OK" : "",
	headers: [["content-type", "application/json; charset=utf-8"], ["cache-control", "no-store"], ...extra],
	body: enc.encode(JSON.stringify(obj)).buffer,
});

const getHeader = (pairs, name) => pairs.find(([k]) => k === name)?.[1];

export class RobloxNet {
	/**
	 * @param {object} o
	 * @param {import("@mercuryworkshop/epoxy-tls").EpoxyClient} o.client
	 * @param {import("./cookiejar.js").CookieJar & { save?: () => void }} o.jar
	 * @param {object} [o.engine] pinned engine info: { version, clientVersionUpload, flags: { [app]: url } }
	 * @param {object} [o.flagOverrides] fast flags to force on top of the pinned set
	 * @param {object} [o.join] { placeId, gameId } to send the first join to a specific server
	 */
	constructor({ client, jar, engine = null, flagOverrides = {}, join = null }) {
		this.client = client;
		this.jar = jar;
		this.engine = engine;
		this.flagOverrides = flagOverrides;
		this.join = join && join.gameId ? { placeId: String(join.placeId), gameId: String(join.gameId), done: false } : null;
		this.csrf = null;
		this.flagCache = new Map();
		this.onJoin = null;
	}

	// req: { url, method, headers: [[k, v]], body: ArrayBuffer | string | null, credentials }
	async request(req) {
		const url = new URL(req.url);
		if (url.protocol !== "https:") throw new Error(`refusing non-https request to ${url.host}`);
		if (!isProxiedHost(url.hostname)) throw new Error(`${url.host} is not a Roblox host`);
		const method = (req.method || "GET").toUpperCase();

		const synthetic = await this.synthetic(url, method);
		if (synthetic) return synthetic;

		const headers = {};
		for (const [k, v] of req.headers || []) {
			const name = k.toLowerCase();
			if (DROP_HEADERS.has(name) || name.startsWith("sec-") || name.startsWith("proxy-")) continue;
			headers[name] = v;
		}
		let body = req.body ?? null;
		if (body instanceof ArrayBuffer && method !== "GET" && method !== "HEAD") body = new Uint8Array(body);
		if (method === "GET" || method === "HEAD") body = null;

		const roblox = isRobloxHost(url.hostname);
		if (roblox) {
			headers.origin = WEBSITE;
			headers.referer = `${WEBSITE}/`;
			if ("rbx-user-agent" in headers || url.hostname === GAMEJOIN) {
				headers["rbx-user-agent"] = rewriteRbxUserAgent(headers["rbx-user-agent"], url.hostname);
			}
			if (req.credentials !== "omit") {
				const cookie = this.jar.cookieHeader(url);
				if (cookie) headers.cookie = cookie;
			}
			if (method !== "GET" && method !== "HEAD" && !headers["x-csrf-token"] && this.csrf) headers["x-csrf-token"] = this.csrf;
		}

		let joinRewrite = false;
		if (url.hostname === GAMEJOIN && method === "POST") {
			({ body, joinRewrite } = this.rewriteJoin(url, body));
		}

		let res = await this.send(url, method, headers, body);

		// Roblox answers a POST without a valid token with 403 + a fresh x-csrf-token.
		const token = roblox ? getHeader(res.headers, "x-csrf-token") : null;
		if (token && res.status === 403 && token !== headers["x-csrf-token"]) {
			this.csrf = token;
			headers["x-csrf-token"] = token;
			res = await this.send(url, method, headers, body);
		} else if (token) this.csrf = token;

		if (url.hostname === GAMEJOIN && res.body && /^\/v\d+\/join-/.test(url.pathname)) {
			res = this.fixJoinResponse(res, joinRewrite);
		}
		return res;
	}

	async send(url, method, headers, body) {
		const res = await epoxyRequest(this.client, url.href, { method, headers, body });
		if (isRobloxHost(url.hostname)) {
			const setCookies = res.headers.filter(([k]) => k === "set-cookie").map(([, v]) => v);
			if (setCookies.length && this.jar.setCookies(setCookies, url)) this.jar.save?.();
		}
		if (NULL_BODY_STATUS.has(res.status)) res.body = null;
		return res;
	}

	// "Join this server": the engine always asks /v1/join-game for its startup place. Until that
	// join succeeds, send it to /v1/join-game-instance with the chosen gameId instead.
	rewriteJoin(url, body) {
		const m = /^\/v(\d+)\/join-game$/.exec(url.pathname);
		if (!m || !this.join || this.join.done || !body) return { body, joinRewrite: false };
		try {
			const payload = JSON.parse(typeof body === "string" ? body : dec.decode(body));
			if (payload.placeId !== undefined && String(payload.placeId) !== this.join.placeId) return { body, joinRewrite: false };
			payload.gameId = this.join.gameId;
			url.pathname = `/v${m[1]}/join-game-instance`;
			return { body: enc.encode(JSON.stringify(payload)), joinRewrite: true };
		} catch {
			return { body, joinRewrite: false };
		}
	}

	fixJoinResponse(res, joinRewrite) {
		let payload;
		try {
			payload = JSON.parse(dec.decode(res.body));
		} catch {
			return res;
		}
		if (!payload || typeof payload !== "object") return res;
		let changed = false;
		let script = payload.joinScript;
		const scriptIsString = typeof script === "string";
		if (scriptIsString) {
			try {
				script = JSON.parse(script);
			} catch {
				script = null;
			}
		}
		if (script && typeof script === "object") {
			if (joinRewrite && this.join) this.join.done = true;
			if (!script.gameFqdn) {
				const fqdn = buildGameFqdn(script);
				if (fqdn) {
					script.gameFqdn = fqdn;
					payload.joinScript = scriptIsString ? JSON.stringify(script) : script;
					changed = true;
				}
			}
			this.onJoin?.({ placeId: script.PlaceId, gameId: script.GameId ?? payload.jobId, gameFqdn: script.gameFqdn || null });
		}
		if (!changed) return res;
		const body = enc.encode(JSON.stringify(payload)).buffer;
		return { ...res, headers: res.headers.filter(([k]) => k !== "content-length"), body };
	}

	// Answers that must not come from the network: the pinned flags for this engine build, and
	// the engine's own version, so a newer release on Roblox's side cannot change either.
	async synthetic(url, method) {
		if (method !== "GET" || !this.engine) return null;
		if (url.hostname === "clientsettingscdn.roblox.com") {
			const m = /^\/v2\/settings\/application\/([A-Za-z]+)(\/bucket\/[^/]+)?\/?$/.exec(url.pathname);
			if (m && /WebClientApp$/.test(m[1])) {
				const flags = await this.pinnedFlags(m[1]);
				if (flags) return json(200, flags);
			}
		}
		if (url.hostname === "clientsettings.roblox.com" && /^\/v2\/client-version\/[A-Za-z]*WebClientApp\/?$/.test(url.pathname)) {
			return json(200, {
				version: this.engine.version || "",
				clientVersionUpload: this.engine.clientVersionUpload,
				bootstrapperVersion: "",
			});
		}
		return null;
	}

	async pinnedFlags(app) {
		const file = this.engine.flags?.[app] || this.engine.flags?.WebClientApp;
		if (!file) return null;
		if (!this.flagCache.has(file)) {
			this.flagCache.set(
				file,
				fetch(file).then((r) => {
					if (!r.ok) throw new Error(`pinned flags HTTP ${r.status}`);
					return r.json();
				}),
			);
		}
		try {
			const pinned = await this.flagCache.get(file);
			return { applicationSettings: { ...pinned.applicationSettings, ...this.flagOverrides } };
		} catch (err) {
			this.flagCache.delete(file);
			console.warn("[webblox] pinned flags unavailable, falling back to live flags:", err);
			return null;
		}
	}

	// Convenience for webblox's own API calls; resolves parsed JSON or throws.
	async api(href, { method = "GET", body, headers = {} } = {}) {
		const pairs = Object.entries({ accept: "application/json", ...headers });
		let payload = null;
		if (body !== undefined) {
			payload = typeof body === "string" ? body : JSON.stringify(body);
			pairs.push(["content-type", "application/json"]);
		}
		const res = await this.request({ url: href, method, headers: pairs, body: payload, credentials: "include" });
		const text = res.body ? dec.decode(res.body) : "";
		let data = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = null;
		}
		if (res.status < 200 || res.status >= 300) {
			const err = new Error(data?.errors?.[0]?.message || `HTTP ${res.status} from ${new URL(href).host}`);
			err.status = res.status;
			err.data = data;
			throw err;
		}
		return data;
	}
}
