// Host-side loader for Roblox's WebClientApp. It stands in for the WasmLoader.js/stub.js
// that roblox.com uses: it makes the page cross-origin isolated (via sw.js), starts the
// network worker, resolves what to join, then hands over to the engine's WasmPlayer.js.

import { authenticatedUser, followUser } from "../js/lib/roblox-api.js";
import { devRootCerts, loadSettings } from "../js/lib/settings.js";
import { installWebTransportDiag } from "../js/lib/wt-diag.js";
import { installWebTransportShim } from "../js/lib/wt-shim.js";

const APP_BASE = new URL("../", location.href);
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ---- diagnostics ---------------------------------------------------------------------------
// Join results (from the network worker), WebTransport attempts (page and engine workers) and
// engine failures, shown under the error message with a copy button when a join fails.

const diag = { events: [], context: {} };
new BroadcastChannel("webblox:diag").onmessage = (e) => noteDiag(e.data);
function noteDiag(event) {
	diag.events.push({ at: Date.now(), where: "page", ...event });
	renderDiag();
}

function browserName() {
	const brands = navigator.userAgentData?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand));
	return brands?.length ? brands.map((b) => `${b.brand} ${b.version}`).join(", ") : navigator.userAgent;
}

function formatEvent(e) {
	const t = new Date(e.at).toISOString().slice(11, 23);
	const has = (v) => v !== null && v !== undefined && v !== "";
	switch (e.kind) {
		case "join": {
			let line = `${t} join ${e.path}: HTTP ${e.httpStatus}`;
			if (has(e.status)) line += `, status ${e.status}`;
			if (has(e.message)) line += ` "${e.message}"`;
			if (e.note) line += ` (${e.note})`;
			if (e.identity) line += `, joined as ${e.identity}`;
			if (e.attempts?.length) line += `\n    attempts: ${e.attempts.join("; ")}`;
			if (e.hasJoinScript) {
				line += `\n    gameFqdn ${e.fqdnSource} (field: ${e.fqdnRaw})${e.gameFqdn ? ` ${e.gameFqdn}` : ""}, UdmuxEndpoints: ${e.udmuxRaw}, ServerConnections: ${e.serverConnections}`;
				if (e.certHashKeys?.length) line += `, ${e.certHashKeys.join("/")}`;
				if (e.netStackKeys?.length) line += `\n    NetStackConfig keys: ${e.netStackKeys.join(", ")}`;
				line += `\n    script keys: ${e.scriptKeys.join(", ")}`;
			}
			return line;
		}
		case "wt-open":
			return `${t} [${e.where}] WebTransport to ${e.url}, ${e.certHashes} cert hash(es)`;
		case "wt-ready":
			return `${t} [${e.where}] WebTransport connected after ${e.ms} ms`;
		case "wt-fail":
			return `${t} [${e.where}] WebTransport failed after ${e.ms} ms: ${e.error}`;
		case "wt-closed":
			return `${t} [${e.where}] WebTransport closed after ${e.ms} ms${has(e.closeCode) ? `, code ${e.closeCode}` : ""}${e.reason ? `, "${e.reason}"` : ""}${e.error ? `: ${e.error}` : ""}`;
		case "wt-route":
			return `${t} [${e.where}] game connection to ${e.url} ${e.via === "wisp" ? "through Wisp" : "direct"}, ready after ${e.ms} ms`;
		case "wt-fallback":
			return `${t} [${e.where}] direct game connection ${e.why === "slow" ? `not ready after ${e.ms} ms` : `failed after ${e.ms} ms${e.error ? ` (${e.error})` : ""}`}; trying through Wisp`;
		case "tunnel-open":
			return `${t} [tunnel] opening ${e.url} through ${e.wisp}, ${e.pinned ? `${e.pinned} pinned cert hash(es)` : "checking the certificate chain"}`;
		case "tunnel-ready":
			return `${t} [tunnel] connected after ${e.ms} ms (Wisp v${e.wispVersion})`;
		case "tunnel-fail":
			return `${t} [tunnel] ${e.stage === "wisp" ? "Wisp" : "QUIC"} failed after ${e.ms} ms: ${e.error}`;
		case "tunnel-closed":
			return `${t} [tunnel] closed after ${e.ms} ms${e.rtt !== null ? `, rtt ${e.rtt} ms, ${e.lost} of ${e.sent} packets lost` : ""}${e.dropped ? `, ${e.dropped} dropped at the WebSocket` : ""}`;
		case "tunnel-preferred":
			return `${t} [tunnel] later game connections go through Wisp`;
		case "tunnel-error":
			return `${t} [tunnel] worker error: ${e.error}`;
		case "probe":
			return `${t} direct HTTPS from this browser to ${e.host} (outside Wisp): ${e.ok ? `reachable (${e.ms} ms)` : `blocked (${e.error})`}`;
		case "engine-failure":
			return `${t} engine ${e.source}: "${e.message}"${has(e.errorCode) ? `, code ${e.errorCode}` : ""}${has(e.statusCode) ? `, status ${e.statusCode}` : ""}`;
		default:
			return `${t} ${e.kind}`;
	}
}

function diagText() {
	const c = diag.context;
	return [
		"webblox diagnostics",
		`engine: ${c.engine || "?"}   place: ${c.placeId || "?"}   server: ${c.gameId || "any"}`,
		`browser: ${browserName()}`,
		`isolated: ${crossOriginIsolated ? "yes" : "no"}   WebTransport: ${typeof WebTransport === "undefined" ? "no" : "yes"}   renderer: ${c.renderer || "?"}`,
		`wisp: ${c.wisp || "?"}   game connection: ${c.gameConnection || "?"}   signed in: ${c.signedIn || "?"}`,
		"",
		...diag.events.map(formatEvent),
	].join("\n");
}

function diagHint() {
	const ev = diag.events;
	const join = [...ev].reverse().find((e) => e.kind === "join" && e.hasJoinScript);
	const fail = [...ev].reverse().find((e) => e.kind === "wt-fail");
	const probe = ev.find((e) => e.kind === "probe");
	const tunnelFail = [...ev].reverse().find((e) => e.kind === "tunnel-fail");
	const direct = diag.context.gameConnection === "direct";
	if (tunnelFail?.stage === "wisp") {
		return `The game connection couldn't go through the Wisp server: ${tunnelFail.error}. It needs a Wisp server that allows UDP; many public ones turn it off. Run your own (for example wisp-server-python) and set it in webblox's settings.`;
	}
	if (tunnelFail) {
		return `The game connection through the Wisp server failed: ${tunnelFail.error}. Copy the details below and report the problem.`;
	}
	if (fail && direct && ((probe && !probe.ok) || fail.ms >= 8000)) {
		return "Your network seems to block Roblox's game servers. Set Game connection to Automatic or Through Wisp in webblox's settings to send the game through the Wisp server as well.";
	}
	if (fail && fail.ms >= 8000) {
		return "Roblox's game server never answered, directly or through the Wisp server. Try another network, such as a phone hotspot, to check.";
	}
	if (fail) {
		return `The game server refused the connection${join?.fqdnSource === "rebuilt" ? ". Roblox didn't send the server's address, so webblox built it, and it may not match" : ""}. Copy the details below and report the problem.`;
	}
	if (join?.fqdnSource === "missing") return "Roblox didn't send a game server address and webblox couldn't rebuild one.";
	if (join && !ev.some((e) => e.kind === "wt-open")) return "Roblox assigned a server, but the engine never tried to connect to it.";
	return "";
}

let probed = false;
function probeDirect() {
	if (probed) return;
	probed = true;
	const target = "https://www.roblox.com/favicon.ico";
	fetch(`__webblox/probe?url=${encodeURIComponent(target)}`)
		.then((r) => r.json())
		.then((r) => noteDiag({ kind: "probe", host: new URL(target).host, ...r }))
		.catch(() => {});
}

function renderDiag() {
	if (!$("loading-overlay")?.classList.contains("loading-failed")) return;
	probeDirect();
	if (!diag.events.length) return;
	$("diag").hidden = false;
	$("diag-text").textContent = diagText();
	const hint = diagHint();
	$("diag-hint").hidden = !hint;
	$("diag-hint").textContent = hint;
}

function installDiagnostics() {
	installWebTransportDiag(window);
	// WasmPlayer.js assigns this hook; wrap whatever it assigns to also record failures.
	let inner = null;
	Object.defineProperty(window, "__onEngineLoadingStatus", {
		configurable: true,
		get() {
			return (s) => {
				if (s?.kind === "failure") noteDiag({ kind: "engine-failure", source: s.source, message: s.message, errorCode: s.errorCode, statusCode: s.statusCode });
				inner?.(s);
			};
		},
		set(fn) {
			inner = fn;
		},
	});
	new MutationObserver(renderDiag).observe($("loading-overlay"), { attributes: true, attributeFilter: ["class"] });
	$("diag-copy").addEventListener("click", async () => {
		const button = $("diag-copy");
		try {
			await navigator.clipboard.writeText(diagText());
			button.textContent = "Copied";
		} catch {
			getSelection()?.selectAllChildren($("diag-text"));
			button.textContent = "Press Ctrl+C to copy";
		}
		setTimeout(() => (button.textContent = "Copy details"), 2500);
	});
}

let engineStarted = false;

function setStatus(text) {
	if (!engineStarted) $("status").textContent = text;
}

function leave() {
	try {
		window.close();
	} catch {
		// not script-closable
	}
	setTimeout(() => location.replace(APP_BASE.href), 150);
}

// Our own failure screen for problems found before the engine is loaded.
function fail(title, message) {
	const overlay = $("loading-overlay");
	overlay.classList.add("loading-failed");
	overlay.setAttribute("aria-busy", "false");
	$("loading-error-title").textContent = title;
	$("loading-error-message").textContent = message;
	$("loading-error-code").textContent = "";
	document.querySelector(".loading-error-panel").hidden = false;
	$("loading-error-leave").textContent = "Back to webblox";
}

function prompt(text, primary, secondary) {
	const box = $("boot-prompt");
	$("boot-prompt-text").textContent = text;
	const a = $("boot-prompt-primary");
	a.textContent = primary.label;
	a.href = primary.href;
	const b = $("boot-prompt-secondary");
	b.textContent = secondary.label;
	box.hidden = false;
	document.querySelector(".loading-bar").hidden = true;
	return new Promise((resolve) => {
		b.onclick = () => {
			box.hidden = true;
			document.querySelector(".loading-bar").hidden = false;
			resolve("secondary");
		};
	});
}

// WasmPlayer.js closes the tab (or blanks it) when the player leaves; send people back to
// the launcher instead. Its exit promise resolves through window.__resolveGameExit, which
// it assigns itself, so wrap whatever it assigns.
function installExitHooks() {
	let inner = null;
	Object.defineProperty(window, "__resolveGameExit", {
		configurable: true,
		get() {
			return (result) => {
				if (result && (result.reason === "leave" || result.reason === "native_exit")) {
					leave();
					return;
				}
				inner?.(result);
			};
		},
		set(fn) {
			inner = fn;
		},
	});
	document.addEventListener(
		"click",
		(e) => {
			if (e.target instanceof Element && e.target.closest("#loading-cancel, #loading-error-leave")) {
				e.preventDefault();
				e.stopImmediatePropagation();
				leave();
			}
		},
		true,
	);
	window.__onExperienceJoined = () => {
		const name = $("loading-experience-title").textContent.trim();
		if (name && name !== "Joining experience") document.title = `${name} · webblox`;
	};
}

async function ensureIsolated() {
	if (!("serviceWorker" in navigator)) {
		throw Object.assign(new Error("This browser has service workers turned off (private windows often do), and webblox needs one to run Roblox."), { title: "Service workers unavailable" });
	}
	await navigator.serviceWorker.register("sw.js", { scope: "./" });
	const mine = new URL("sw.js", location.href).href;
	if (navigator.serviceWorker.controller?.scriptURL !== mine) {
		// First visit (or the app's root worker answered this page): once the player's own
		// worker is active, reload so the page itself is served with COOP/COEP.
		setStatus("Setting up…");
		await navigator.serviceWorker.ready;
		location.reload();
		return false;
	}
	if (!crossOriginIsolated) {
		if (!sessionStorage.getItem("webblox:isolation-retry")) {
			sessionStorage.setItem("webblox:isolation-retry", "1");
			location.reload();
			return false;
		}
		throw Object.assign(
			new Error("The page could not be cross-origin isolated, which Roblox's engine needs for its threads. Open the player in its own tab, not inside a frame, and make sure the browser is up to date."),
			{ title: "Can't start Roblox here" },
		);
	}
	sessionStorage.removeItem("webblox:isolation-retry");
	return true;
}

function checkRequirements() {
	if (typeof WebAssembly !== "object" || typeof SharedArrayBuffer !== "function") {
		throw Object.assign(new Error("This browser lacks WebAssembly threads."), { title: "Browser not supported" });
	}
	if (typeof WebTransport === "undefined") {
		throw Object.assign(
			new Error("This browser has no WebTransport, which Roblox's web client uses for game traffic. Use a current Chrome, Edge or Firefox."),
			{ title: "Browser not supported" },
		);
	}
}

// The pinned flags prefer WebGPU, but the engine needs BC or ETC2 texture compression there.
// Returns flag overrides, or {} to keep the pinned choice.
async function rendererOverrides(pref) {
	const webgl = { FFlagWasmPreferWebGPU: "False" };
	const hasWebGL2 = !!document.createElement("canvas").getContext("webgl2");
	if (pref === "webgl") return webgl;
	if (pref === "webgpu") return { FFlagWasmPreferWebGPU: "True" };
	try {
		const adapter = navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }));
		if (adapter && (adapter.features.has("texture-compression-bc") || adapter.features.has("texture-compression-etc2"))) return {};
	} catch {
		// fall through to WebGL
	}
	if (!hasWebGL2) {
		throw Object.assign(new Error("Neither usable WebGPU nor WebGL 2 is available in this browser."), { title: "Graphics not supported" });
	}
	return webgl;
}

function startNetWorker(options) {
	const worker = new Worker("net.worker.js", { type: "module", name: "webblox-net" });
	const ready = new Promise((resolve, reject) => {
		worker.addEventListener("message", (e) => {
			if (e.data?.type === "ready") resolve();
			else if (e.data?.type === "error") reject(new Error(e.data.message));
		});
		worker.addEventListener("error", (e) => reject(new Error(e.message || "The network worker failed to start.")));
	});
	worker.postMessage({ type: "init", options });

	const portFor = () => {
		const ch = new MessageChannel();
		worker.postMessage({ type: "port" }, [ch.port1]);
		return ch.port2;
	};
	const giveBridge = () => navigator.serviceWorker.controller?.postMessage({ type: "webblox:bridge" }, [portFor()]);
	navigator.serviceWorker.addEventListener("message", (e) => {
		if (e.data?.type === "webblox:need-bridge") giveBridge();
	});
	navigator.serviceWorker.addEventListener("controllerchange", giveBridge);
	navigator.serviceWorker.startMessages();
	giveBridge();

	const port = portFor();
	const pending = new Map();
	let next = 1;
	port.onmessage = (e) => {
		const { id, data, error, status } = e.data || {};
		const p = pending.get(id);
		if (!p) return;
		pending.delete(id);
		if (error) p.reject(Object.assign(new Error(error), { status }));
		else p.resolve(data);
	};
	return {
		ready,
		api(href, init) {
			const id = next++;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				port.postMessage({ id, api: { href, init } });
			});
		},
		setJoin(join) {
			worker.postMessage({ type: "set-join", join });
		},
	};
}

function wispProblem(err, wispUrl) {
	return Object.assign(
		new Error(`Could not reach Roblox through the Wisp server ${wispUrl} (${err.message}). Pick another server in webblox's settings.`),
		{ title: "Connection failed" },
	);
}

// The page's id as its service worker knows it. Engine threads get the same id, so this page's
// tunnel worker only serves this page's engine when several player tabs are open.
let pageClientId = "";
function askClientId() {
	return new Promise((resolve) => {
		const sw = navigator.serviceWorker;
		if (!sw?.controller) return resolve("");
		const timer = setTimeout(() => resolve(""), 2000);
		const onMessage = (e) => {
			if (e.data?.type !== "webblox:client-id") return;
			clearTimeout(timer);
			sw.removeEventListener("message", onMessage);
			resolve(e.data.id || "");
		};
		sw.addEventListener("message", onMessage);
		sw.startMessages();
		sw.controller.postMessage({ type: "webblox:client-id" });
	});
}

// Runs game connections that go through Wisp, and tells the engine's WebTransport stand-in which
// route the "Game connection" setting picks.
function startTunnelWorker(options) {
	const worker = new Worker("tunnel.worker.js", { type: "module", name: "webblox-tunnel" });
	worker.addEventListener("error", (e) => noteDiag({ kind: "tunnel-error", error: e.message || "the tunnel worker failed to start" }));
	worker.postMessage({ type: "init", options });
	return worker;
}

async function main() {
	installWebTransportShim(window, { client: () => pageClientId });
	installExitHooks();
	installDiagnostics();
	$("canvas").addEventListener("contextmenu", (e) => e.preventDefault());

	let placeId = params.get("placeId");
	let gameId = params.get("gameId");
	const followUserId = params.get("followUserId");
	if (!placeId && !followUserId) {
		location.replace(APP_BASE.href);
		return;
	}

	if (!(await ensureIsolated())) return;
	checkRequirements();

	setStatus("Loading engine info…");
	const res = await fetch("engine.json", { cache: "no-cache" });
	if (!res.ok) throw Object.assign(new Error("player/engine.json is missing; the site was built without an engine."), { title: "Engine not installed" });
	const engine = await res.json();
	const engineBase = new URL(`engine/${engine.clientVersionUpload}`, location.href).href;
	const flags = {};
	for (const [app, file] of Object.entries(engine.flags || {})) flags[app] = `${engineBase}/${file}`;

	const settings = loadSettings();
	const flagOverrides = await rendererOverrides(settings.renderer);
	Object.assign(diag.context, {
		engine: `${engine.clientVersionUpload} (${engine.version || "?"}, ${engine.mode})`,
		placeId,
		gameId,
		wisp: settings.wispUrl,
		gameConnection: settings.gameConnection,
		renderer: flagOverrides.FFlagWasmPreferWebGPU === "False" ? `webgl (setting ${settings.renderer})` : `webgpu (setting ${settings.renderer})`,
	});

	pageClientId = await askClientId();
	startTunnelWorker({
		mode: settings.gameConnection,
		wispUrl: settings.wispUrl,
		fallbackMs: 3000,
		client: pageClientId,
		origin: location.origin,
	});

	setStatus("Connecting…");
	const net = startNetWorker({
		wispUrl: settings.wispUrl,
		rootCerts: devRootCerts(),
		engine: { version: engine.version, clientVersionUpload: engine.clientVersionUpload, flags },
		flagOverrides,
		join: placeId && gameId ? { placeId, gameId } : null,
	});
	await net.ready;

	setStatus("Checking your Roblox session…");
	let user;
	try {
		user = await authenticatedUser(net);
	} catch (err) {
		console.warn("[webblox] session check failed:", err);
		await prompt(wispProblem(err, settings.wispUrl).message, { label: "Open settings", href: APP_BASE.href }, { label: "Try anyway" });
		user = undefined;
	}
	diag.context.signedIn = user ? "yes" : user === null ? "no" : "unknown (session check failed)";
	if (user === null) {
		const back = new URL(APP_BASE);
		back.searchParams.set("signin", "1");
		back.searchParams.set("return", location.href);
		await prompt(
			"You're not signed in. Roblox needs an account to join games (without one, joining fails with error 524).",
			{ label: "Sign in", href: back.href },
			{ label: "Try anyway" },
		);
	}

	if (followUserId) {
		setStatus("Finding where they're playing…");
		const target = await followUser(net, followUserId).catch((err) => {
			throw Object.assign(err, { title: "Can't join" });
		});
		placeId = target.placeId;
		Object.assign(diag.context, { placeId, gameId: target.gameId, followed: followUserId });
		gameId = target.gameId;
		net.setJoin({ placeId, gameId });
	}

	// WasmPlayer.js reads the place from the page URL.
	const url = new URL(location.href);
	url.search = "";
	url.searchParams.set("placeId", placeId);
	if (gameId) url.searchParams.set("gameId", gameId);
	history.replaceState(null, "", url);

	window.__wasmLoaderContext = { engineBase, channel: null, server: "prod" };
	engineStarted = true;
	const script = document.createElement("script");
	script.src = `${engineBase}/WasmPlayer.js`;
	script.onerror = () => fail("Engine failed to load", "WasmPlayer.js could not be downloaded. Reload to try again.");
	document.head.appendChild(script);
}

main().catch((err) => {
	console.error("[webblox] startup failed:", err);
	fail(err.title || "Couldn't start Roblox", err.message || String(err));
});
