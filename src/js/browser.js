// The sign-in browser: roblox.com inside a Scramjet 2 frame, tunnelled over Wisp. Signing in
// here is what gives the player a Roblox session (it reads Scramjet's cookie jar), and when
// roblox.com tries to launch the desktop app the launch plugin opens the player instead.

import { PersistentJar } from "./lib/cookie-store.js";
import { EpoxyTransport, createEpoxyClient } from "./lib/epoxy.js";
import { createLaunchPlugin } from "./lib/launch-plugin.js";
import { playerUrl } from "./lib/links.js";
import { authenticatedUser } from "./lib/roblox-api.js";
import { RobloxNet } from "./lib/robloxnet.js";
import { importScramjetSession, readScramjetRobloxCookies } from "./lib/scramjet-session.js";
import { loadSettings } from "./lib/settings.js";

const BASE = new URL("./", location.href);
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const settings = loadSettings();

let clientPromise = null;
const getClient = () => (clientPromise ||= createEpoxyClient(settings.wispUrl));

// Only send people back to a player page on this site.
const returnUrl = (() => {
	const r = params.get("return");
	if (!r) return null;
	try {
		const u = new URL(r);
		return u.origin === location.origin && u.pathname.startsWith(`${BASE.pathname}player/`) ? u.href : null;
	} catch {
		return null;
	}
})();

const isRobloxUrl = (u) => /^https:$/.test(u.protocol) && /(^|\.)roblox\.com$/i.test(u.hostname);

function startUrl() {
	try {
		const u = new URL(params.get("url") || "https://www.roblox.com/login");
		if (isRobloxUrl(u)) return u.href;
	} catch {
		// fall through
	}
	return "https://www.roblox.com/login";
}

function banner(text, action) {
	$("banner-text").textContent = text;
	const a = $("banner-action");
	if (action) {
		a.textContent = action.label;
		a.href = action.href;
		a.target = action.newTab ? "_blank" : "";
		a.hidden = false;
	} else a.hidden = true;
	$("banner").hidden = false;
}
$("banner-close").onclick = () => ($("banner").hidden = true);

function onLaunch(intent) {
	if (intent.linkCode || intent.accessCode) {
		banner("That's a private server link. webblox can't join private servers yet.");
		return;
	}
	const url = playerUrl(BASE, intent);
	const tab = window.open(url, "_blank");
	if (tab) banner("The game is starting in a new tab.");
	else banner("Your browser blocked the new tab.", { label: "Play", href: url, newTab: true });
}

let lastSignedIn = null;
async function refreshSession() {
	const snap = await readScramjetRobloxCookies().catch(() => null);
	const signedIn = !!snap?.cookies.some((c) => c.name === ".ROBLOSECURITY" && c.value);
	if (signedIn === lastSignedIn) return;
	lastSignedIn = signedIn;
	const chip = $("session");
	if (!signedIn) {
		chip.hidden = true;
		return;
	}
	chip.textContent = "Signed in";
	chip.hidden = false;
	if (returnUrl) banner("You're signed in.", { label: "Continue to the game", href: returnUrl });
	else banner("You're signed in. You can play from webblox now.", { label: "Back to webblox", href: BASE.href });
	// Carry the session over to webblox right away and show whose it is.
	try {
		const jar = await PersistentJar.open();
		await importScramjetSession(jar);
		const user = await authenticatedUser(new RobloxNet({ client: await getClient(), jar, timeout: 20000 }));
		if (user) chip.textContent = `Signed in as ${user.displayName}`;
	} catch (err) {
		console.warn("[webblox] could not confirm the session:", err);
	}
}

async function start() {
	if (!("serviceWorker" in navigator)) throw new Error("Service workers are unavailable in this browser (private windows often disable them).");
	const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
	if (!navigator.serviceWorker.controller) {
		await navigator.serviceWorker.ready;
		location.reload();
		return;
	}

	const { Controller, ManagedPlugin } = globalThis.$scramjetController;
	const { ScramjetHeaders } = globalThis.$scramjet;
	const controller = new Controller({
		serviceworker: reg.active || navigator.serviceWorker.controller,
		transport: new EpoxyTransport(getClient),
		config: {
			prefix: `${BASE.pathname}~/sj/`,
			scramjetPath: `${BASE.pathname}scramjet/scramjet.js`,
			injectPath: `${BASE.pathname}controller/controller.inject.js`,
			wasmPath: `${BASE.pathname}scramjet/scramjet.wasm`,
		},
	});
	await controller.wait();

	const iframe = $("frame");
	const frame = controller.createFrame(iframe, { plugins: [createLaunchPlugin(ManagedPlugin, ScramjetHeaders, onLaunch)] });

	const address = $("address");
	const currentUrl = () => {
		try {
			const href = iframe.contentWindow.location.href;
			const i = href.indexOf(frame.prefix);
			return i < 0 ? null : decodeURIComponent(href.slice(i + frame.prefix.length));
		} catch {
			return null;
		}
	};
	iframe.addEventListener("load", () => {
		$("frame-status").hidden = true;
		const u = currentUrl();
		if (u && document.activeElement !== address) address.value = u;
		refreshSession();
	});
	$("address-form").addEventListener("submit", (e) => {
		e.preventDefault();
		let u;
		try {
			u = new URL(/^[a-z]+:\/\//i.test(address.value) ? address.value : `https://${address.value}`);
		} catch {
			return;
		}
		if (!isRobloxUrl(u)) {
			banner("This browser is for roblox.com only.");
			return;
		}
		frame.go(u.href);
		address.blur();
	});
	$("nav-back").onclick = () => frame.back();
	$("nav-forward").onclick = () => frame.forward();
	$("nav-reload").onclick = () => frame.reload();

	new BroadcastChannel("__scramjet_controller_channel").onmessage = () => refreshSession();

	const first = startUrl();
	address.value = first;
	$("frame-status").textContent = "Loading roblox.com…";
	frame.go(first);
	refreshSession();
}

start().catch((err) => {
	console.error("[webblox] browser failed to start:", err);
	$("frame-status").textContent = `Couldn't start the browser: ${err.message}`;
});
