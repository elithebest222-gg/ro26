// Roblox's Charts (roblox.com/charts): named lists of experiences such as Top Trending or Most
// Popular, from the explore API. Public: no session needed.

const SORTS = "https://apis.roblox.com/explore-api/v1/get-sorts";

const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

/**
 * One page of chart lists. Resolves { charts: [{ id, name, games }], nextPageToken }, keeping only
 * lists of experiences; games have the fields the launcher's cards use.
 */
export async function chartPage(net, { sessionId, pageToken, device = "computer", country = "all" } = {}) {
	const data = await net.api(`${SORTS}?${qs({ sessionId, device, country, sortsPageToken: pageToken })}`);
	const charts = [];
	for (const sort of data?.sorts || []) {
		if (sort?.contentType !== "Games" || !Array.isArray(sort.games) || !sort.games.length) continue;
		charts.push({
			id: String(sort.sortId),
			name: sort.sortDisplayName || sort.sortId,
			games: sort.games
				.filter((g) => g?.universeId && g?.rootPlaceId && g.name)
				.map((g) => ({
					universeId: String(g.universeId),
					placeId: String(g.rootPlaceId),
					name: g.name,
					playerCount: Number.isFinite(g.playerCount) ? g.playerCount : null,
					upVotes: g.totalUpVotes || 0,
					downVotes: g.totalDownVotes || 0,
					sponsored: !!g.isSponsored,
				})),
		});
	}
	return { charts, nextPageToken: data?.nextSortsPageToken || null };
}

/** All chart lists, following the pages (Roblox splits them into a few). */
export async function allCharts(net, { sessionId, maxPages = 4, onPage } = {}) {
	const out = [];
	let pageToken = null;
	for (let i = 0; i < maxPages; i++) {
		const page = await chartPage(net, { sessionId, pageToken });
		for (const c of page.charts) if (!out.some((o) => o.id === c.id)) out.push(c);
		onPage?.(out.slice());
		pageToken = page.nextPageToken;
		if (!pageToken) break;
	}
	return out;
}
