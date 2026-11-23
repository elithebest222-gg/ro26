// Sign-in happens on roblox.com inside the Scramjet browser. Scramjet 2's controller keeps its
// cookie jar in IndexedDB: database "__scramjet_controller", store "state", key "cookies",
// value { updatedAt, cookies } where cookies is a JSON dump keyed "domain@path@name".
// The player is on the same origin, so it can lift the Roblox session out of that jar.

import { isRobloxCookieDomain } from "./cookiejar.js";
import { openExisting, reqToPromise } from "./idb.js";

const DB = "__scramjet_controller";
const STORE = "state";
const KEY = "cookies";
const CHANNEL = "__scramjet_controller_channel";

async function readState() {
	const db = await openExisting(DB);
	if (!db) return null;
	try {
		if (!db.objectStoreNames.contains(STORE)) return null;
		const value = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(KEY));
		if (!value || typeof value.cookies !== "string" || typeof value.updatedAt !== "number") return null;
		return { db, value };
	} catch (err) {
		db.close();
		console.warn("[webblox] could not read Scramjet's cookie jar:", err);
		return null;
	}
}

function parseDump(dump) {
	try {
		const parsed = JSON.parse(dump);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

const toJarCookie = (c) => ({
	name: c.name,
	value: c.value,
	domain: String(c.domain).replace(/^\./, "").toLowerCase(),
	hostOnly: !!c.hostOnly,
	path: c.path || "/",
	expires: Number.isFinite(c.expires) ? c.expires : null,
	secure: !!c.secure,
	httpOnly: !!c.httpOnly,
	sameSite: c.sameSite || "lax",
	created: Date.now(),
});

// Returns { updatedAt, cookies } with the roblox.com cookies Scramjet holds, or null.
export async function readScramjetRobloxCookies() {
	const state = await readState();
	if (!state) return null;
	state.db.close();
	const all = parseDump(state.value.cookies);
	const t = Date.now();
	const cookies = Object.values(all)
		.filter((c) => c && typeof c.name === "string" && typeof c.value === "string" && isRobloxCookieDomain(c.domain || ""))
		.filter((c) => !(Number.isFinite(c.expires) && c.expires <= t))
		.map(toJarCookie);
	return { updatedAt: state.value.updatedAt, cookies };
}

// Mirrors Scramjet's Roblox cookies into the webblox jar whenever Scramjet's jar is newer than
// the last import. Signing in or out in the browser therefore carries over, while a cookie the
// player itself refreshed later is kept until the next sign-in.
export async function importScramjetSession(jar) {
	const snap = await readScramjetRobloxCookies();
	if (!snap) return false;
	jar.meta ||= {};
	if (snap.updatedAt <= (jar.meta.scramjetUpdatedAt || 0)) return false;
	jar.replaceWhere((c) => isRobloxCookieDomain(c.domain), snap.cookies);
	jar.meta.scramjetUpdatedAt = snap.updatedAt;
	await jar.saveNow();
	return true;
}

// Removes the Roblox cookies from Scramjet's jar (used by "Sign out"), and tells any open
// Scramjet controller to reload its jar.
export async function clearScramjetRobloxCookies() {
	const state = await readState();
	if (!state) return false;
	const { db, value } = state;
	try {
		const all = parseDump(value.cookies);
		let removed = 0;
		for (const [key, c] of Object.entries(all)) {
			if (c && isRobloxCookieDomain(c.domain || "")) {
				delete all[key];
				removed++;
			}
		}
		const updatedAt = Math.max(Date.now(), value.updatedAt + 1);
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put({ updatedAt, cookies: JSON.stringify(all) }, KEY);
		await new Promise((resolve, reject) => {
			tx.oncomplete = resolve;
			tx.onerror = tx.onabort = () => reject(tx.error);
		});
		const bc = new BroadcastChannel(CHANNEL);
		bc.postMessage({ updatedAt });
		bc.close();
		return removed > 0;
	} finally {
		db.close();
	}
}
