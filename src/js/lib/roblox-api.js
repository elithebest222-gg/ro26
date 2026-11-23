// The handful of Roblox web APIs webblox itself uses. Roblox only allows its own origins via
// CORS, so all of these go through RobloxNet (Wisp + epoxy) rather than the page's fetch.

const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

export function newSearchSession() {
	return crypto.randomUUID();
}

export async function searchGames(net, query, { pageToken, sessionId } = {}) {
	const data = await net.api(
		`https://apis.roblox.com/search-api/omni-search?${qs({ searchQuery: query, pageToken, sessionId, pageType: "all" })}`,
	);
	const games = [];
	for (const group of data?.searchResults || []) {
		if (group.contentGroupType !== "Game") continue;
		for (const g of group.contents || []) {
			if (!g.universeId || !g.rootPlaceId) continue;
			games.push({
				universeId: String(g.universeId),
				placeId: String(g.rootPlaceId),
				name: g.name || "Untitled experience",
				playerCount: g.playerCount ?? null,
				upVotes: g.totalUpVotes ?? 0,
				downVotes: g.totalDownVotes ?? 0,
				sponsored: !!g.isSponsored,
			});
		}
	}
	return { games, nextPageToken: data?.nextPageToken || null };
}

export async function gameIcons(net, universeIds, size = "256x256") {
	const out = new Map();
	const ids = [...new Set(universeIds.map(String))];
	for (let i = 0; i < ids.length; i += 100) {
		const chunk = ids.slice(i, i + 100);
		const data = await net.api(
			`https://thumbnails.roblox.com/v1/games/icons?${qs({ universeIds: chunk.join(","), returnPolicy: "PlaceHolder", size, format: "Png", isCircular: "false" })}`,
		);
		for (const t of data?.data || []) if (t.state === "Completed" && t.imageUrl) out.set(String(t.targetId), t.imageUrl);
	}
	return out;
}

export async function placeToUniverse(net, placeId) {
	const data = await net.api(`https://apis.roblox.com/universes/v1/places/${encodeURIComponent(placeId)}/universe`);
	if (!data?.universeId) throw new Error("That place does not exist.");
	return String(data.universeId);
}

export async function gameDetails(net, universeId) {
	const data = await net.api(`https://games.roblox.com/v1/games?${qs({ universeIds: universeId })}`);
	const g = data?.data?.[0];
	if (!g) throw new Error("Could not load that experience.");
	return {
		universeId: String(g.id),
		placeId: String(g.rootPlaceId),
		name: g.name,
		description: g.description || "",
		creator: g.creator?.name || "",
		creatorVerified: !!g.creator?.hasVerifiedBadge,
		playing: g.playing ?? 0,
		visits: g.visits ?? 0,
		maxPlayers: g.maxPlayers ?? 0,
	};
}

export async function publicServers(net, placeId, cursor) {
	const data = await net.api(
		`https://games.roblox.com/v1/games/${encodeURIComponent(placeId)}/servers/Public?${qs({ sortOrder: "Desc", excludeFullGames: "true", limit: 25, cursor })}`,
	);
	return {
		servers: (data?.data || []).map((s) => ({ id: s.id, playing: s.playing ?? 0, maxPlayers: s.maxPlayers ?? 0, ping: s.ping ?? null, fps: s.fps ?? null })),
		nextCursor: data?.nextPageCursor || null,
	};
}

// Returns { placeId, gameId } for a user who is in a joinable game, or throws with a reason.
export async function followUser(net, userId) {
	const data = await net.api("https://presence.roblox.com/v1/presence/users", { method: "POST", body: { userIds: [Number(userId)] } });
	const p = data?.userPresences?.[0];
	if (!p) throw new Error("Could not look up that user's presence.");
	if (p.userPresenceType !== 2) throw new Error("That user is not in a game right now.");
	const placeId = p.placeId || p.rootPlaceId;
	if (!placeId || !p.gameId) throw new Error("That user's game is private to you, so it cannot be joined.");
	return { placeId: String(placeId), gameId: String(p.gameId) };
}

export async function authenticatedUser(net) {
	try {
		const u = await net.api("https://users.roblox.com/v1/users/authenticated");
		return u?.id ? { id: String(u.id), name: u.name, displayName: u.displayName || u.name } : null;
	} catch (err) {
		if (err.status === 401 || err.status === 403) return null;
		throw err;
	}
}

export async function userHeadshot(net, userId) {
	const data = await net.api(
		`https://thumbnails.roblox.com/v1/users/avatar-headshot?${qs({ userIds: userId, size: "48x48", format: "Png", isCircular: "true" })}`,
	);
	const t = data?.data?.[0];
	return t?.state === "Completed" ? t.imageUrl : null;
}

// roblox.com/share?code=…&type=… links resolve to a place (and sometimes a server).
export async function resolveShareLink(net, code, type = "ExperienceDetails") {
	const data = await net.api("https://apis.roblox.com/sharelinks/v1/resolve-link", { method: "POST", body: { linkId: code, linkType: type } });
	const exp = data?.experienceDetailsInviteData || data?.experienceInviteData;
	if (exp?.placeId) return { placeId: String(exp.placeId), gameId: exp.instanceId || undefined };
	const ps = data?.privateServerInviteData;
	if (ps?.placeId) return { placeId: String(ps.placeId), linkCode: ps.linkCode, unsupported: "private server" };
	throw new Error("That share link could not be resolved.");
}
