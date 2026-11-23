// Turns the ways Roblox expresses "launch this" into a join intent:
//   { placeId, gameId?, followUserId?, linkCode?, accessCode?, share? }
// Handles roblox-player: URIs, roblox:// deep links, /games/start?placeId=, game page
// links, share links and bare place ids.

const POSITIVE_INT = /^[1-9]\d{0,18}$/;
const id = (v) => (v !== null && v !== undefined && POSITIVE_INT.test(String(v).trim()) ? String(v).trim() : undefined);
const guid = (v) => (typeof v === "string" && /^[0-9a-f-]{32,36}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined);

function compact(o) {
	const out = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
	return out;
}

// PlaceLauncher.ashx?request=RequestGame|RequestGameJob|RequestFollowUser|RequestPrivateGame…
export function intentFromPlaceLauncher(href) {
	let url;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	const p = url.searchParams;
	const request = (p.get("request") || "").toLowerCase();
	const intent = compact({
		placeId: id(p.get("placeId")),
		gameId: guid(p.get("gameId")),
		followUserId: request === "requestfollowuser" ? id(p.get("userId")) : undefined,
		accessCode: p.get("accessCode") || undefined,
		linkCode: p.get("linkCode") || undefined,
	});
	return intent.placeId || intent.followUserId ? intent : null;
}

// roblox-player:1+launchmode:play+gameinfo:…+placelauncherurl:<encoded>+…
export function parseRobloxPlayerUri(uri) {
	if (!/^roblox-player:/i.test(uri)) return null;
	const fields = {};
	for (const part of uri.replace(/^roblox-player:/i, "").split("+")) {
		const i = part.indexOf(":");
		if (i > 0) fields[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
	}
	if (fields.placelauncherurl) {
		let decoded = fields.placelauncherurl;
		try {
			decoded = decodeURIComponent(decoded);
		} catch {
			// keep it as is
		}
		const intent = intentFromPlaceLauncher(decoded);
		if (intent) return intent;
	}
	return null;
}

// roblox://placeId=1&gameInstanceId=…  and  roblox://experiences/start?placeId=1&…
export function parseRobloxDeepLink(uri) {
	const m = /^roblox(?:-player)?:\/\/(.*)$/i.exec(uri);
	if (!m) return null;
	let rest = m[1];
	let path = "";
	const q = rest.indexOf("?");
	if (q >= 0) {
		path = rest.slice(0, q).replace(/\/+$/, "").toLowerCase();
		rest = rest.slice(q + 1);
	} else if (!rest.includes("=")) {
		return null;
	}
	if (path && !/^(experiences\/start|games\/start|placeid|navigation\/game_details)$/.test(path)) return null;
	const p = new URLSearchParams(rest.replace(/^\/+/, ""));
	const get = (name) => {
		for (const [k, v] of p) if (k.toLowerCase() === name) return v;
		return null;
	};
	const intent = compact({
		placeId: id(get("placeid") ?? (path === "navigation/game_details" ? get("gameid") : null)),
		gameId: guid(get("gameinstanceid") ?? get("gameid")),
		followUserId: id(get("userid")),
		accessCode: get("accesscode") || undefined,
		linkCode: get("linkcode") || undefined,
	});
	return intent.placeId || intent.followUserId ? intent : null;
}

function isRobloxWebsite(url) {
	return /^(www\.|web\.|m\.)?roblox\.com$/i.test(url.hostname);
}

export function parseWebsiteUrl(href) {
	let url;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (!isRobloxWebsite(url)) return null;
	const path = url.pathname.replace(/^\/[a-z]{2}(-[a-z]{2})?(?=\/games\/)/i, "");
	const p = url.searchParams;
	if (/^\/games\/start\/?$/i.test(path)) {
		const intent = compact({
			placeId: id(p.get("placeId") || p.get("placeid")),
			gameId: guid(p.get("gameInstanceId") || p.get("gameinstanceid")),
			followUserId: id(p.get("userId")),
		});
		return intent.placeId || intent.followUserId ? intent : null;
	}
	if (/^\/game\/placelauncher\.ashx$/i.test(path)) return intentFromPlaceLauncher(url.href);
	const game = /^\/games\/(\d+)(\/|$)/i.exec(path);
	if (game) {
		return compact({
			placeId: id(game[1]),
			gameId: guid(p.get("gameInstanceId")),
			linkCode: p.get("privateServerLinkCode") || undefined,
		});
	}
	if (/^\/share\/?$/i.test(path) && p.get("code")) {
		return { share: { code: p.get("code"), type: p.get("type") || "ExperienceDetails" } };
	}
	return null;
}

// Anything the user might paste into the launcher.
export function parseLaunchInput(input) {
	const text = String(input || "").trim();
	if (!text) return null;
	if (id(text)) return { placeId: id(text) };
	if (/^roblox-player:/i.test(text)) return parseRobloxPlayerUri(text) || parseRobloxDeepLink(text);
	if (/^roblox:/i.test(text)) return parseRobloxDeepLink(text);
	const href = /^[a-z]+:\/\//i.test(text) ? text : /^(www\.)?roblox\.com\//i.test(text) ? `https://${text}` : null;
	return href ? parseWebsiteUrl(href) : null;
}

// Any launch attempt a page inside the Scramjet browser makes.
export function parseLaunchAttempt(value) {
	const text = String(value || "").trim();
	if (/^roblox-player:/i.test(text)) return parseRobloxPlayerUri(text) || parseRobloxDeepLink(text);
	if (/^roblox:/i.test(text)) return parseRobloxDeepLink(text);
	const intent = parseWebsiteUrl(text);
	// Only /games/start (and PlaceLauncher) are launches; a game page link is just navigation.
	if (intent && /\/(games\/start|game\/placelauncher\.ashx)/i.test(text)) return intent;
	return null;
}

export function playerUrl(base, intent) {
	const url = new URL("player/", base);
	for (const key of ["placeId", "gameId", "followUserId"]) if (intent[key]) url.searchParams.set(key, intent[key]);
	return url.href;
}
