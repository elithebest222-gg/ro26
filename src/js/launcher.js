// The launcher: find an experience (search or a pasted link), pick a server, and open the
// player in its own tab. Roblox's APIs only allow roblox.com via CORS, so calls go over Wisp.

import { CookieJar, isRobloxCookieDomain } from "./lib/cookiejar.js";
import { PersistentJar } from "./lib/cookie-store.js";
import { createEpoxyClient } from "./lib/epoxy.js";
import { parseLaunchInput, playerUrl } from "./lib/links.js";
import {
	authenticatedUser,
	gameDetails,
	gameIcons,
	newSearchSession,
	placeToUniverse,
	publicServers,
	resolveShareLink,
	searchGames,
	userHeadshot,
} from "./lib/roblox-api.js";
import { RobloxNet } from "./lib/robloxnet.js";
import { clearScramjetRobloxCookies, importScramjetSession } from "./lib/scramjet-session.js";
import { loadSettings, normalizeWispUrl, saveSettings } from "./lib/settings.js";

const BASE = new URL("./", location.href);
const $ = (id) => document.getElementById(id);
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

let settings = loadSettings();

// Installing the player's service worker now saves a reload when the first game starts.
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("player/sw.js", { scope: "player/" }).catch(() => {});
	navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
}

let netPromise = null;
function getNet() {
	if (!netPromise) {
		netPromise = (async () => {
			const jar = await PersistentJar.open();
			await importScramjetSession(jar).catch(() => {});
			return new RobloxNet({ client: await createEpoxyClient(settings.wispUrl), jar });
		})();
		netPromise.catch(() => (netPromise = null));
	}
	return netPromise;
}

function notice(text, kind = "info") {
	const el = $("notice");
	el.textContent = text;
	el.dataset.kind = kind;
	el.hidden = !text;
}

function connectionHint(err) {
	return `Couldn't reach Roblox through the Wisp server (${err.message}). Check the server in Settings.`;
}

// ---- images -----------------------------------------------------------------------------

// Thumbnails live on rbxcdn.com; when the browser can't load them directly (blocked
// networks), fetch them through Wisp instead.
function setImage(img, url) {
	if (!url) return;
	img.onerror = async () => {
		img.onerror = null;
		try {
			const net = await getNet();
			const res = await net.request({ url, method: "GET", headers: [], credentials: "omit" });
			if (res.status === 200 && res.body) img.src = URL.createObjectURL(new Blob([res.body]));
		} catch {
			// leave the placeholder
		}
	};
	img.src = url;
}

// ---- recent ------------------------------------------------------------------------------

const RECENT_KEY = "webblox:recent";
function loadRecent() {
	try {
		const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}
function remember(game) {
	if (!game?.placeId || !game.name) return;
	const list = loadRecent().filter((g) => g.placeId !== game.placeId);
	list.unshift({ placeId: game.placeId, universeId: game.universeId, name: game.name, icon: game.icon || null });
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
	} catch {
		// storage full or unavailable
	}
	renderRecent();
}
function renderRecent() {
	const list = loadRecent();
	$("recent-section").hidden = list.length === 0;
	const grid = $("recent");
	grid.replaceChildren(...list.map((g) => card(g)));
}
$("clear-recent").onclick = () => {
	localStorage.removeItem(RECENT_KEY);
	renderRecent();
};

// ---- cards -------------------------------------------------------------------------------

function card(game) {
	const el = document.createElement("button");
	el.type = "button";
	el.className = "card";
	const icon = document.createElement("div");
	icon.className = "card-icon";
	const img = document.createElement("img");
	img.alt = "";
	img.loading = "lazy";
	icon.append(img);
	if (game.icon) setImage(img, game.icon);
	const body = document.createElement("div");
	body.className = "card-body";
	const title = document.createElement("div");
	title.className = "card-title";
	title.textContent = game.name;
	const meta = document.createElement("div");
	meta.className = "card-meta";
	const votes = (game.upVotes || 0) + (game.downVotes || 0);
	const bits = [];
	if (votes > 0) bits.push(`${Math.round((100 * game.upVotes) / votes)}% rating`);
	if (game.playerCount !== null && game.playerCount !== undefined) bits.push(`${compact.format(game.playerCount)} playing`);
	meta.textContent = bits.join(" · ");
	body.append(title, meta);
	el.append(icon, body);
	el.onclick = () => openDetails({ ...game, icon: img.currentSrc || game.icon });
	el._img = img;
	return el;
}

// ---- search ------------------------------------------------------------------------------

let search = { query: "", token: null, session: newSearchSession(), busy: false };

async function runSearch(query, more = false) {
	if (search.busy) return;
	search.busy = true;
	if (!more) search = { query, token: null, session: newSearchSession(), busy: true };
	$("results-section").hidden = false;
	$("results-title").textContent = `Results for “${query}”`;
	if (!more) $("results").replaceChildren(skeletons(12));
	$("more").hidden = true;
	try {
		const net = await getNet();
		const { games, nextPageToken } = await searchGames(net, query, { pageToken: search.token, sessionId: search.session });
		search.token = nextPageToken;
		const cards = games.map((g) => card(g));
		if (more) $("results").append(...cards);
		else $("results").replaceChildren(...cards);
		if (!games.length && !more) $("results").replaceChildren(emptyState("No experiences found."));
		$("more").hidden = !nextPageToken || !games.length;
		// Icons are decoration: a failure here must not take the results away.
		gameIcons(net, games.map((g) => g.universeId))
			.then((icons) =>
				games.forEach((g, i) => {
					g.icon = icons.get(g.universeId) || null;
					if (g.icon) setImage(cards[i]._img, g.icon);
				}),
			)
			.catch((err) => console.warn("[webblox] game icons unavailable:", err));
	} catch (err) {
		if (!more) $("results").replaceChildren(emptyState("Search failed."));
		notice(connectionHint(err), "error");
	} finally {
		search.busy = false;
	}
}
$("more").onclick = () => runSearch(search.query, true);

function skeletons(n) {
	const frag = document.createDocumentFragment();
	for (let i = 0; i < n; i++) {
		const s = document.createElement("div");
		s.className = "card skeleton";
		s.innerHTML = '<div class="card-icon"></div><div class="card-body"><div class="line"></div><div class="line short"></div></div>';
		frag.append(s);
	}
	return frag;
}
function emptyState(text) {
	const p = document.createElement("p");
	p.className = "empty";
	p.textContent = text;
	return p;
}

$("search-form").addEventListener("submit", (e) => {
	e.preventDefault();
	const q = $("search").value.trim();
	if (!q) return;
	notice("");
	const intent = parseLaunchInput(q);
	if (intent) openIntent(intent);
	else runSearch(q);
});

// ---- launching ---------------------------------------------------------------------------

function launch(intent, game) {
	if (intent.linkCode || intent.accessCode) {
		notice("That's a private server link. webblox can't join private servers yet.", "error");
		return;
	}
	remember(game);
	const url = playerUrl(BASE, intent);
	// The engine needs a cross-origin isolated top-level page, so it gets its own tab.
	if (!window.open(url, "_blank")) location.href = url;
}

async function openIntent(intent) {
	try {
		if (intent.share) {
			const net = await getNet();
			intent = await resolveShareLink(net, intent.share.code, intent.share.type);
		}
		if (intent.followUserId || intent.gameId) launch(intent);
		else if (intent.linkCode) launch(intent);
		else openDetails({ placeId: intent.placeId });
	} catch (err) {
		notice(err.status ? err.message : connectionHint(err), "error");
	}
}

// ---- details -----------------------------------------------------------------------------

let current = null;
async function openDetails(game) {
	current = { ...game };
	const dlg = $("details");
	$("details-name").textContent = game.name || "Loading…";
	$("details-creator").textContent = "";
	$("details-stats").textContent = "";
	$("details-description").textContent = "";
	$("details-servers").hidden = true;
	$("servers-list").replaceChildren();
	const icon = $("details-icon");
	icon.removeAttribute("src");
	if (game.icon) setImage(icon, game.icon);
	if (!dlg.open) dlg.showModal();
	try {
		const net = await getNet();
		const universeId = game.universeId || (await placeToUniverse(net, game.placeId));
		const d = await gameDetails(net, universeId);
		if (current?.placeId !== game.placeId) return;
		Object.assign(current, { universeId, name: d.name, placeId: d.placeId || game.placeId });
		$("details-name").textContent = d.name;
		$("details-creator").textContent = d.creator ? `By ${d.creator}${d.creatorVerified ? " ✓" : ""}` : "";
		$("details-stats").textContent = `${compact.format(d.playing)} playing · ${compact.format(d.visits)} visits · up to ${d.maxPlayers} per server`;
		$("details-description").textContent = d.description;
		if (!game.icon) {
			const icons = await gameIcons(net, [universeId]);
			current.icon = icons.get(universeId) || null;
			setImage(icon, current.icon);
		}
	} catch (err) {
		$("details-name").textContent = game.name || `Place ${game.placeId}`;
		$("details-description").textContent = err.status ? err.message : connectionHint(err);
	}
}

$("details-play").onclick = () => current && launch({ placeId: current.placeId }, current);

let serverCursor = null;
async function loadServers(more = false) {
	if (!current) return;
	const list = $("servers-list");
	$("details-servers").hidden = false;
	if (!more) {
		serverCursor = null;
		list.replaceChildren(emptyState("Loading servers…"));
	}
	try {
		const net = await getNet();
		const { servers, nextCursor } = await publicServers(net, current.placeId, serverCursor);
		serverCursor = nextCursor;
		const items = servers.map((s) => {
			const li = document.createElement("li");
			const info = document.createElement("span");
			info.textContent = `${s.playing}/${s.maxPlayers} players${s.ping ? ` · ${s.ping} ms` : ""}`;
			const join = document.createElement("button");
			join.type = "button";
			join.className = "btn small";
			join.textContent = "Join";
			join.onclick = () => launch({ placeId: current.placeId, gameId: s.id }, current);
			li.append(info, join);
			return li;
		});
		if (more) list.append(...items);
		else list.replaceChildren(...(items.length ? items : [emptyState("No public servers with free slots right now.")]));
		$("servers-more").hidden = !nextCursor;
	} catch (err) {
		list.replaceChildren(emptyState(err.status ? err.message : connectionHint(err)));
	}
}
$("details-servers-btn").onclick = () => loadServers(false);
$("servers-more").onclick = () => loadServers(true);

// ---- account -----------------------------------------------------------------------------

let user = null;
async function refreshAccount() {
	const box = $("account");
	try {
		const net = await getNet();
		user = await authenticatedUser(net);
	} catch (err) {
		user = null;
		notice(connectionHint(err), "error");
	}
	$("signout").hidden = !user;
	$("settings-account").textContent = user ? `Signed in as ${user.displayName} (@${user.name}).` : "Not signed in. Sign in on roblox.com in the sign-in browser to join games.";
	if (!user) {
		const a = document.createElement("a");
		a.className = "btn primary small";
		a.href = "browser.html";
		a.textContent = "Sign in";
		box.replaceChildren(a);
		return;
	}
	const chip = document.createElement("span");
	chip.className = "user-chip";
	const img = document.createElement("img");
	img.alt = "";
	const name = document.createElement("span");
	name.textContent = user.displayName;
	chip.append(img, name);
	box.replaceChildren(chip);
	getNet()
		.then((net) => userHeadshot(net, user.id))
		.then((url) => setImage(img, url))
		.catch(() => {});
}

$("signout").onclick = async () => {
	if (!confirm("Sign out of Roblox in webblox?")) return;
	try {
		const net = await getNet();
		await net.api("https://auth.roblox.com/v2/logout", { method: "POST", body: {} }).catch(() => {});
		net.jar.removeWhere((c) => isRobloxCookieDomain(c.domain));
		await net.jar.saveNow();
	} catch {
		// fall through to clearing the browser's jar
	}
	await clearScramjetRobloxCookies().catch(() => {});
	refreshAccount();
};

// ---- settings ----------------------------------------------------------------------------

let engineInfo = null;
fetch("player/engine.json", { cache: "no-cache" })
	.then((r) => (r.ok ? r.json() : null))
	.then((e) => {
		engineInfo = e;
		const where = e?.mode === "cdn" ? "streamed from Roblox's CDN" : "served from this site";
		$("engine-line").textContent = e ? `Roblox WebClientApp ${e.version || e.clientVersionUpload}` : "Engine not installed";
		$("settings-engine").textContent = e
			? `WebClientApp ${e.version || "?"} (${e.clientVersionUpload}), ${where}. Its flags are pinned to that build.`
			: "This build has no engine (player/engine.json is missing).";
	})
	.catch(() => ($("engine-line").textContent = "Engine info unavailable"));

$("open-settings").onclick = () => {
	$("wisp-url").value = settings.wispUrl;
	$("renderer").value = settings.renderer;
	$("wisp-result").textContent = "";
	$("settings").showModal();
};

$("wisp-test").onclick = async () => {
	const url = normalizeWispUrl($("wisp-url").value);
	const out = $("wisp-result");
	if (!url) {
		out.textContent = "Enter a ws:// or wss:// address.";
		return;
	}
	out.textContent = "Testing…";
	const t0 = performance.now();
	try {
		const net = new RobloxNet({ client: await createEpoxyClient(url), jar: new CookieJar() });
		await net.api("https://apis.roblox.com/universes/v1/places/1818/universe");
		out.textContent = `Reached Roblox in ${Math.round(performance.now() - t0)} ms.`;
	} catch (err) {
		out.textContent = `Failed: ${err.message}`;
	}
};

$("settings-form").addEventListener("submit", (e) => {
	e.preventDefault();
	const wispUrl = normalizeWispUrl($("wisp-url").value);
	if (!wispUrl) {
		$("wisp-result").textContent = "Enter a ws:// or wss:// address.";
		return;
	}
	const changed = wispUrl !== settings.wispUrl;
	settings = saveSettings({ wispUrl, renderer: $("renderer").value });
	$("settings").close();
	if (changed) {
		netPromise = null;
		notice("");
		refreshAccount();
	}
});

// The sign-in browser may change the session in another tab.
new BroadcastChannel("__scramjet_controller_channel").onmessage = () => {
	netPromise = null;
	refreshAccount();
};

renderRecent();
refreshAccount();
const q = new URLSearchParams(location.search).get("q");
if (q) {
	$("search").value = q;
	$("search-form").requestSubmit();
}
