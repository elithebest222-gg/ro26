// The avatar editor sheet: the rendered avatar, R6 or R15, skin tone, and your items by category
// (tap to wear or take off), plus saved outfits. Changes are saved together, then Roblox renders a
// new picture.

import { CATEGORIES, avatarPicture, avatarRules, currentAvatar, itemThumbnails, listOutfits, outfitAvatar, outfitThumbnails, ownedItems, saveAvatar, skinTone, takeOff, wear } from "../lib/avatar.js";

const TABS = [{ id: "wearing", label: "Wearing" }, { id: "outfits", label: "Outfits" }, ...CATEGORIES];
const clone = (a) => ({ ...a, assets: a.assets.map((x) => ({ ...x })), bodyColors: { ...a.bodyColors } });

export function initAvatar(ui) {
	const { $, getNet, setImage, connectionHint } = ui;
	let user = null;
	let rules = null;
	let saved = null; // the avatar as Roblox has it
	let draft = null; // the avatar being edited
	let tab = "wearing";
	let busy = false;
	let tabRun = 0;
	const owned = new Map(); // category id -> { items, cursors }
	const pictures = new Map(); // asset id -> image URL
	let outfits = null;
	const errorText = (err) => (err.userFacing || err.status ? err.message : connectionHint(err));

	const assetKey = (a) => a.assets.map((x) => x.id).sort().join(",");
	const dirty = () => !!(saved && draft) && (draft.type !== saved.type || assetKey(draft) !== assetKey(saved) || JSON.stringify(draft.bodyColors) !== JSON.stringify(saved.bodyColors));
	const worn = (id) => !!draft?.assets.some((a) => a.id === id);

	function status(text, kind = "info") {
		$("avatar-status").textContent = text;
		$("avatar-status").dataset.kind = kind;
	}

	function updateControls() {
		const changed = dirty();
		$("avatar-save").disabled = !changed || busy;
		$("avatar-reset").disabled = !changed || busy;
		$("avatar-preview-note").hidden = !changed;
		for (const b of document.querySelectorAll("#avatar-type .seg")) b.setAttribute("aria-pressed", String(draft?.type === b.dataset.type));
		const colors = Object.values(draft?.bodyColors || {});
		const tone = colors.length && colors.every((c) => c === colors[0]) ? colors[0] : null;
		for (const s of document.querySelectorAll("#skin-tones .swatch")) s.setAttribute("aria-pressed", String(s.dataset.hex === tone));
		for (const t of document.querySelectorAll("#avatar-items .item")) t.setAttribute("aria-pressed", String(worn(t.dataset.id)));
	}

	function renderSkinTones() {
		$("skin-tones").replaceChildren(
			...(rules?.skinTones || []).map((c) => {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "swatch";
				b.dataset.hex = c.hex;
				b.title = c.name;
				b.setAttribute("aria-label", c.name);
				b.style.background = `#${c.hex}`;
				b.onclick = () => {
					draft.bodyColors = skinTone(c.hex);
					updateControls();
				};
				return b;
			}),
		);
	}

	function renderTabs() {
		$("avatar-tabs").replaceChildren(
			...TABS.map((t) => {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "chip";
				b.setAttribute("role", "tab");
				b.setAttribute("aria-selected", String(t.id === tab));
				b.textContent = t.label;
				b.onclick = () => showTab(t.id);
				return b;
			}),
		);
	}

	// Thumbnails for whatever is shown, fetched in one go per screenful.
	async function fillPictures(tiles, kind = "asset") {
		const missing = tiles.map((t) => t.dataset.id).filter((id) => !pictures.has(`${kind}:${id}`));
		if (missing.length) {
			try {
				const net = await getNet();
				const found = kind === "outfit" ? await outfitThumbnails(net, missing) : await itemThumbnails(net, missing);
				for (const id of missing) pictures.set(`${kind}:${id}`, found.get(id) || null);
			} catch {
				// pictures are optional
			}
		}
		for (const t of tiles) {
			const url = pictures.get(`${kind}:${t.dataset.id}`);
			if (url && !t.querySelector("img").src) setImage(t.querySelector("img"), url);
		}
	}

	function itemTile(item, onClick) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "item";
		b.dataset.id = item.id;
		b.title = item.name;
		const img = document.createElement("img");
		img.alt = "";
		img.loading = "lazy";
		const name = document.createElement("span");
		name.textContent = item.name || `Item ${item.id}`;
		b.append(img, name);
		b.onclick = onClick;
		return b;
	}

	const toggle = (item) => () => {
		draft.assets = worn(item.id) ? takeOff(draft.assets, item.id) : wear(draft.assets, item, rules?.maxByType);
		if (tab === "wearing") showTab("wearing");
		else updateControls();
	};

	async function showTab(id) {
		tab = id;
		const mine = ++tabRun;
		renderTabs();
		const grid = $("avatar-items");
		$("avatar-more").hidden = true;
		if (!draft) return;
		if (id === "wearing") {
			const tiles = draft.assets.map((a) => itemTile(a, toggle(a)));
			grid.replaceChildren(...(tiles.length ? tiles : [ui.emptyState("Nothing on. Pick items from the other tabs.")]));
			updateControls();
			fillPictures(tiles);
			return;
		}
		if (id === "outfits") {
			grid.replaceChildren(ui.emptyState("Loading outfits…"));
			try {
				const net = await getNet();
				outfits ||= await listOutfits(net, user.id);
				if (mine !== tabRun) return;
				const tiles = outfits.map((o) =>
					itemTile(o, async () => {
						status(`Putting on ${o.name}…`);
						try {
							const outfit = await outfitAvatar(await getNet(), o.id);
							draft = { ...draft, type: outfit.type, assets: outfit.assets, bodyColors: Object.keys(outfit.bodyColors).length ? outfit.bodyColors : draft.bodyColors };
							status(`${o.name} is on. Save to keep it.`);
							updateControls();
						} catch (err) {
							status(errorText(err), "error");
						}
					}),
				);
				grid.replaceChildren(...(tiles.length ? tiles : [ui.emptyState("No saved outfits.")]));
				fillPictures(tiles, "outfit");
			} catch (err) {
				if (mine === tabRun) grid.replaceChildren(ui.emptyState(errorText(err)));
			}
			return;
		}
		const category = CATEGORIES.find((c) => c.id === id);
		if (!owned.has(id)) grid.replaceChildren(ui.emptyState("Loading your items…"));
		try {
			if (!owned.has(id)) owned.set(id, await ownedItems(await getNet(), user.id, category.types));
			if (mine !== tabRun) return;
			renderItems(id);
		} catch (err) {
			if (mine === tabRun) grid.replaceChildren(ui.emptyState(errorText(err)));
		}
	}

	function renderItems(id) {
		const { items, cursors } = owned.get(id);
		const tiles = items.map((it) => itemTile(it, toggle(it)));
		$("avatar-items").replaceChildren(...(tiles.length ? tiles : [ui.emptyState("You don't own anything here yet.")]));
		$("avatar-more").hidden = !Object.values(cursors).some(Boolean);
		updateControls();
		fillPictures(tiles);
	}

	$("avatar-more").onclick = async () => {
		const id = tab;
		const category = CATEGORIES.find((c) => c.id === id);
		const have = owned.get(id);
		if (!category || !have) return;
		$("avatar-more").disabled = true;
		try {
			const next = await ownedItems(await getNet(), user.id, category.types, have.cursors);
			const seen = new Set(have.items.map((i) => i.id));
			owned.set(id, { items: [...have.items, ...next.items.filter((i) => !seen.has(i.id))], cursors: { ...have.cursors, ...next.cursors } });
			if (tab === id) renderItems(id);
		} catch (err) {
			status(errorText(err), "error");
		} finally {
			$("avatar-more").disabled = false;
		}
	};

	for (const b of document.querySelectorAll("#avatar-type .seg")) {
		b.onclick = () => {
			if (!draft) return;
			draft.type = b.dataset.type;
			updateControls();
		};
	}

	async function refreshPicture(waitForNew) {
		const img = $("avatar-img");
		$("avatar-busy").hidden = false;
		try {
			if (waitForNew) await new Promise((r) => setTimeout(r, 1500)); // let the redraw start
			const url = await avatarPicture(await getNet(), user.id);
			if (url) setImage(img, url);
		} catch {
			// keep the old picture
		} finally {
			$("avatar-busy").hidden = true;
		}
	}

	$("avatar-reset").onclick = () => {
		if (!saved) return;
		draft = clone(saved);
		status("");
		showTab(tab);
	};

	$("avatar-save").onclick = async () => {
		if (!dirty() || busy) return;
		busy = true;
		updateControls();
		status("Saving…");
		try {
			const net = await getNet();
			const { invalid } = await saveAvatar(net, saved, draft);
			saved = await currentAvatar(net);
			draft = clone(saved);
			showTab(tab);
			status(invalid.length ? `Saved, but Roblox wouldn't put on ${invalid.length} item${invalid.length > 1 ? "s" : ""}.` : "Saved.", invalid.length ? "error" : "info");
			ui.onAvatarSaved?.();
			refreshPicture(true);
		} catch (err) {
			status(`Couldn't save: ${errorText(err)}`, "error");
		} finally {
			busy = false;
			updateControls();
		}
	};

	async function open() {
		if (!user) return;
		const dialog = $("avatar-dialog");
		if (!dialog.open) dialog.showModal();
		status("Loading your avatar…");
		try {
			const net = await getNet();
			const [r, current] = await Promise.all([rules || avatarRules(net), currentAvatar(net)]);
			rules = r;
			saved = current;
			draft = clone(saved);
			renderSkinTones();
			status("");
			showTab(tab);
			refreshPicture(false);
		} catch (err) {
			status(errorText(err), "error");
		}
	}

	$("avatar-dialog").addEventListener("cancel", (e) => {
		if (dirty() && !confirm("Leave without saving your avatar changes?")) e.preventDefault();
	});

	function setUser(u) {
		if (u?.id !== user?.id) {
			owned.clear();
			pictures.clear();
			outfits = null;
			saved = draft = null;
		}
		user = u;
	}

	return { open, setUser };
}
