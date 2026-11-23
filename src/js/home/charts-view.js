// Charts on the home page: Roblox's lists (Top Trending, Most Popular…) as chips above a grid of
// experiences. Public data, so it shows when signed out too.

import { allCharts } from "../lib/charts.js";
import { gameIcons, newSearchSession } from "../lib/roblox-api.js";

const PAGE = 24;

export function initCharts(ui) {
	const { $, getNet, card, setImage, skeletons, emptyState, connectionHint } = ui;
	const state = { charts: [], current: null, shown: 0, icons: new Map(), loaded: false };

	function renderChips() {
		$("chart-chips").replaceChildren(
			...state.charts.map((c) => {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "chip";
				b.setAttribute("role", "tab");
				b.setAttribute("aria-selected", String(c.id === state.current?.id));
				b.textContent = c.name;
				b.onclick = () => select(c.id);
				return b;
			}),
		);
	}

	function select(id) {
		state.current = state.charts.find((c) => c.id === id) || state.charts[0] || null;
		state.shown = 0;
		$("charts").replaceChildren();
		renderChips();
		showMore();
	}

	async function showMore() {
		const chart = state.current;
		if (!chart) return;
		const games = chart.games.slice(state.shown, state.shown + PAGE);
		state.shown += games.length;
		const cards = games.map((g) => card(g));
		$("charts").append(...cards);
		$("charts-more").hidden = state.shown >= chart.games.length;
		// Icons are decoration: the list stands without them.
		const missing = games.map((g) => g.universeId).filter((id) => !state.icons.has(id));
		if (missing.length) {
			try {
				const icons = await gameIcons(await getNet(), missing);
				for (const id of missing) state.icons.set(id, icons.get(id) || null);
			} catch (err) {
				console.warn("[webblox] chart icons unavailable:", err);
			}
		}
		games.forEach((g, i) => {
			g.icon = state.icons.get(g.universeId) || null;
			if (g.icon) setImage(cards[i]._img, g.icon);
		});
	}
	$("charts-more").onclick = showMore;

	async function load() {
		if (state.loaded) return;
		state.loaded = true;
		$("charts-section").hidden = false;
		$("charts").replaceChildren(skeletons(12));
		try {
			const net = await getNet();
			await allCharts(net, {
				sessionId: newSearchSession(),
				onPage: (charts) => {
					const first = !state.charts.length;
					state.charts = charts;
					if (first) select(charts[0]?.id);
					else renderChips();
				},
			});
			if (!state.charts.length) $("charts").replaceChildren(emptyState("No charts right now."));
		} catch (err) {
			state.loaded = false;
			if (!state.charts.length) $("charts").replaceChildren(emptyState(`Charts didn't load. ${err.status ? err.message : connectionHint(err)}`));
		}
	}

	return { load };
}
