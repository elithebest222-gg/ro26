// User settings, kept in localStorage by the pages. Workers cannot read localStorage, so
// pages pass the values they need to workers explicitly.

const KEY = "webblox:settings";

// A public Wisp server so the site works out of the box. Traffic to Roblox is TLS
// end-to-end (epoxy terminates TLS in the browser), so the Wisp server only relays
// encrypted bytes. Anyone can point this at their own server in Settings.
export const DEFAULT_WISP = "wss://wisp.mercurywork.shop/";

const DEFAULTS = Object.freeze({
	wispUrl: DEFAULT_WISP,
	renderer: "auto", // "auto" | "webgpu" | "webgl"
	// How the game itself (WebTransport to Roblox's game servers) connects:
	// "auto" direct, falling back to the Wisp server | "direct" | "wisp" always through Wisp.
	gameConnection: "auto",
});

export const GAME_CONNECTIONS = ["auto", "direct", "wisp"];

export function loadSettings() {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
		const out = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
		if (!GAME_CONNECTIONS.includes(out.gameConnection)) out.gameConnection = DEFAULTS.gameConnection;
		return out;
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSettings(patch) {
	const next = { ...loadSettings(), ...patch };
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		// Storage can be unavailable (private mode quotas); settings then last for the page only.
	}
	return next;
}

// Development only: extra PEM root certificates for epoxy, from localStorage key
// "webblox:dev:roots". Lets the site be tested through a TLS-intercepting proxy; leave unset.
export function devRootCerts() {
	try {
		const pem = globalThis.localStorage?.getItem("webblox:dev:roots");
		return pem ? [pem] : [];
	} catch {
		return [];
	}
}

export function normalizeWispUrl(input) {
	try {
		const url = new URL(String(input).trim());
		if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
		return url.href;
	} catch {
		return null;
	}
}
