// Host-side loader for Roblox's WebClientApp. It stands in for the WasmLoader.js/stub.js
// that roblox.com uses: it makes the page cross-origin isolated (via sw.js), starts the
// network worker, resolves what to join, then hands over to the engine's WasmPlayer.js.

import { authenticatedUser, followUser } from "../js/lib/roblox-api.js";
import { devRootCerts, loadSettings } from "../js/lib/settings.js";

const APP_BASE = new URL("../", location.href);
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

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
			else if (e.data?.type === "joined") console.info("[webblox] joined", e.data.info);
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

async function main() {
	installExitHooks();
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
		throw wispProblem(err, settings.wispUrl);
	}
	if (!user) {
		const back = new URL("browser.html", APP_BASE);
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
