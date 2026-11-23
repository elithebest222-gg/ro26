// Friends: the list, what each friend is doing (presence), friend requests, and looking people up.
// All through the signed-in session, like roblox.com's friends page.

import { withChallenges } from "./session.js";

const FRIENDS = "https://friends.roblox.com/v1";
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

function chunks(list, size) {
	const out = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

// Roblox serializes enums as names in some services and numbers in others.
const PRESENCE = ["offline", "online", "game", "studio", "invisible"];
const PRESENCE_NAMES = { Offline: "offline", Online: "online", InGame: "game", InStudio: "studio", Invisible: "invisible" };
const presenceKind = (t) => (typeof t === "number" ? PRESENCE[t] : PRESENCE_NAMES[t]) || "offline";

/** Names for user ids: Map id -> { id, name, displayName, verified }. */
export async function usersById(net, ids) {
	const out = new Map();
	for (const part of chunks([...new Set(ids.map(String))], 100)) {
		const data = await net.api("https://users.roblox.com/v1/users", { method: "POST", body: { userIds: part.map(Number), excludeBannedUsers: false } });
		for (const u of data?.data || []) out.set(String(u.id), { id: String(u.id), name: u.name, displayName: u.displayName || u.name, verified: !!u.hasVerifiedBadge });
	}
	return out;
}

/** The user with this username, or null. */
export async function userByName(net, username) {
	const name = String(username || "").trim().replace(/^@/, "");
	if (!name) return null;
	const data = await net.api("https://users.roblox.com/v1/usernames/users", { method: "POST", body: { usernames: [name], excludeBannedUsers: true } });
	const u = data?.data?.[0];
	return u ? { id: String(u.id), name: u.name, displayName: u.displayName || u.name, verified: !!u.hasVerifiedBadge } : null;
}

// Fills in names Roblox left out of a list (it sometimes sends only ids).
async function withNames(net, people) {
	const missing = people.filter((p) => !p.name).map((p) => p.id);
	if (missing.length) {
		const names = await usersById(net, missing).catch(() => new Map());
		for (const p of people) Object.assign(p, names.get(p.id) || {});
	}
	for (const p of people) {
		p.name ||= `user ${p.id}`;
		p.displayName ||= p.name;
	}
	return people;
}

/** The user's friends: [{ id, name, displayName, verified }]. */
export async function friendsList(net, userId) {
	const data = await net.api(`${FRIENDS}/users/${encodeURIComponent(userId)}/friends?${qs({ userSort: "StatusFrequents" })}`);
	const people = (data?.data || [])
		.filter((f) => f?.id && !f.isDeleted)
		.map((f) => ({ id: String(f.id), name: f.name || "", displayName: f.displayName || "", verified: !!f.hasVerifiedBadge }));
	return withNames(net, people);
}

/**
 * What users are doing: Map id -> { kind: "offline" | "online" | "game" | "studio" | "invisible",
 * place, placeId, gameId, universeId, joinable }. `joinable` means webblox can follow them in.
 */
export async function presences(net, ids) {
	const out = new Map();
	for (const part of chunks([...new Set(ids.map(String))], 50)) {
		const data = await net.api("https://presence.roblox.com/v1/presence/users", { method: "POST", body: { userIds: part.map(Number) } });
		for (const p of data?.userPresences || []) {
			const kind = presenceKind(p.userPresenceType);
			const placeId = p.placeId || p.rootPlaceId || null;
			out.set(String(p.userId), {
				kind,
				place: p.lastLocation || "",
				placeId: placeId ? String(placeId) : null,
				gameId: p.gameId ? String(p.gameId) : null,
				universeId: p.universeId ? String(p.universeId) : null,
				joinable: kind === "game" && !!placeId && !!p.gameId,
			});
		}
	}
	return out;
}

/** Round avatar pictures: Map id -> image URL. */
export async function headshots(net, ids, size = "150x150") {
	const out = new Map();
	for (const part of chunks([...new Set(ids.map(String))], 100)) {
		const data = await net.api(`https://thumbnails.roblox.com/v1/users/avatar-headshot?${qs({ userIds: part.join(","), size, format: "Png", isCircular: "true" })}`);
		for (const t of data?.data || []) if (t.state === "Completed" && t.imageUrl) out.set(String(t.targetId), t.imageUrl);
	}
	return out;
}

/** Friend requests waiting for an answer: { requests: [{ id, name, displayName, sentAt }], nextCursor }. */
export async function friendRequests(net, cursor = null) {
	const data = await net.api(`${FRIENDS}/my/friends/requests?${qs({ limit: 50, cursor })}`);
	const requests = (data?.data || [])
		.filter((r) => r?.id)
		.map((r) => ({ id: String(r.id), name: r.name || "", displayName: r.displayName || "", verified: !!r.hasVerifiedBadge, sentAt: r.friendRequest?.sentAt || null }));
	return { requests: await withNames(net, requests), nextCursor: data?.nextPageCursor || null };
}

export async function friendRequestCount(net) {
	const data = await net.api(`${FRIENDS}/user/friend-requests/count`);
	return Number(data?.count) || 0;
}

export function acceptFriendRequest(net, userId) {
	return net.api(`${FRIENDS}/users/${encodeURIComponent(userId)}/accept-friend-request`, { method: "POST", body: {} });
}

export function declineFriendRequest(net, userId) {
	return net.api(`${FRIENDS}/users/${encodeURIComponent(userId)}/decline-friend-request`, { method: "POST", body: {} });
}

/**
 * Sends a friend request. Roblox can put a check in front of it: a proof-of-work puzzle is solved
 * here; a CAPTCHA comes back as an error with `captcha` set.
 */
export function sendFriendRequest(net, userId, ask = {}) {
	return withChallenges(
		net,
		(headers) => net.api(`${FRIENDS}/users/${encodeURIComponent(userId)}/request-friendship`, { method: "POST", body: { friendshipOriginSourceType: "UserProfile" }, headers }),
		ask,
	);
}
