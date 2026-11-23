// The avatar editor's side of Roblox: what is worn now, the items you own by category, outfits,
// and saving changes (items, R6/R15, skin tone), then the freshly rendered picture.

const AVATAR = "https://avatar.roblox.com";
const THUMBS = "https://thumbnails.roblox.com/v1";
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

// What the editor offers, as Roblox asset type ids.
export const CATEGORIES = [
	{ id: "hats", label: "Hats", types: [8] },
	{ id: "hair", label: "Hair", types: [41] },
	{ id: "head", label: "Heads & faces", types: [79, 17, 18, 76, 77, 88, 89, 90] },
	{ id: "accessories", label: "Accessories", types: [42, 43, 44, 45, 46, 47] },
	{ id: "clothing", label: "Clothing", types: [11, 12, 2] },
	{ id: "layered", label: "Layered clothing", types: [67, 68, 65, 64, 66, 69, 72, 70, 71] },
	{ id: "body", label: "Body parts", types: [27, 28, 29, 30, 31] },
	{ id: "animations", label: "Animations", types: [51, 55, 53, 52, 50, 48, 54, 78] },
];

const ACCESSORY_TYPES = new Set([8, 41, 42, 43, 44, 45, 46, 47]);
const MAX_ACCESSORIES = 10;
// Layered clothing stacks by order, inside to outside.
const LAYER_ORDER = { 70: 1, 71: 1, 66: 3, 69: 4, 64: 6, 65: 7, 72: 8, 68: 9, 67: 10 };

function chunks(list, size) {
	const out = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

const avatarType = (t) => (t === 1 || t === "R6" ? "R6" : "R15");

/** Limits and palettes: { maxByType: Map, skinTones: [{ name, hex }] }. */
export async function avatarRules(net) {
	const data = await net.api(`${AVATAR}/v1/avatar-rules`);
	const maxByType = new Map((data?.wearableAssetTypes || []).map((t) => [Number(t.id), Number(t.maxNumber)]));
	const palette = data?.basicBodyColorsPalette?.length ? data.basicBodyColorsPalette : data?.bodyColorsPalette || [];
	return { maxByType, skinTones: palette.map((c) => ({ name: c.name, hex: String(c.hexColor || "").replace(/^#/, "").toUpperCase() })) };
}

const asset = (a) => ({ id: String(a.id), name: a.name || "", typeId: Number(a.assetType?.id ?? a.typeId), typeName: a.assetType?.name || "", ...(a.meta ? { meta: a.meta } : {}) });

/** What the signed-in user wears: { type, assets, bodyColors, colorsHaveHash }. */
export async function currentAvatar(net) {
	const data = await net.api(`${AVATAR}/v2/avatar/avatar`);
	const colors = data?.bodyColor3s || {};
	return {
		type: avatarType(data?.playerAvatarType),
		assets: (data?.assets || []).map(asset),
		bodyColors: Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, String(v).replace(/^#/, "").toUpperCase()])),
		// Sent back in the form Roblox gave them.
		colorsHaveHash: Object.values(colors).some((v) => String(v).startsWith("#")),
	};
}

/**
 * Puts an item on. Keeps Roblox's limits: per type (one shirt, up to three hats…) and ten
 * accessories in all; the oldest of the kind comes off to make room.
 */
export function wear(assets, item, maxByType = new Map()) {
	if (assets.some((a) => a.id === item.id)) return assets;
	const added = { ...item };
	if (LAYER_ORDER[item.typeId] && !added.meta) added.meta = { order: LAYER_ORDER[item.typeId], version: 1 };
	let next = [...assets, added];
	const max = maxByType.get(item.typeId) ?? 1;
	const sameType = next.filter((a) => a.typeId === item.typeId);
	if (max > 0 && sameType.length > max) next = next.filter((a) => a !== sameType[0]);
	if (ACCESSORY_TYPES.has(item.typeId)) {
		const accessories = next.filter((a) => ACCESSORY_TYPES.has(a.typeId));
		if (accessories.length > MAX_ACCESSORIES) next = next.filter((a) => a !== accessories[0]);
	}
	return next;
}

export const takeOff = (assets, id) => assets.filter((a) => a.id !== String(id));

/** Items the user owns in these asset types: { items: [{ id, name, typeId }], cursors }. */
export async function ownedItems(net, userId, typeIds, cursors = {}) {
	const items = [];
	const next = {};
	for (const typeId of typeIds) {
		if (cursors[typeId] === null) continue; // that type is exhausted
		const data = await net.api(`https://inventory.roblox.com/v2/users/${encodeURIComponent(userId)}/inventory/${typeId}?${qs({ limit: 100, sortOrder: "Desc", cursor: cursors[typeId] })}`);
		for (const it of data?.data || []) if (it?.assetId) items.push({ id: String(it.assetId), name: it.assetName || "", typeId });
		next[typeId] = data?.nextPageCursor || null;
	}
	const seen = new Set();
	return { items: items.filter((it) => !seen.has(it.id) && seen.add(it.id)), cursors: next };
}

async function thumbs(net, path, params, ids) {
	const out = new Map();
	for (const part of chunks([...new Set(ids.map(String))], 100)) {
		const data = await net.api(`${THUMBS}/${path}?${qs({ ...params(part), format: "Png", isCircular: "false" })}`);
		for (const t of data?.data || []) if (t.state === "Completed" && t.imageUrl) out.set(String(t.targetId), t.imageUrl);
	}
	return out;
}

export const itemThumbnails = (net, ids, size = "150x150") => thumbs(net, "assets", (part) => ({ assetIds: part.join(","), size, returnPolicy: "PlaceHolder" }), ids);
export const outfitThumbnails = (net, ids) => thumbs(net, "users/outfits", (part) => ({ userOutfitIds: part.join(","), size: "150x150" }), ids);

/** The full-body picture, waiting while Roblox renders a new one. Resolves a URL or null. */
export async function avatarPicture(net, userId, { size = "420x420", attempts = 10, wait = 1500 } = {}) {
	for (let i = 0; i < attempts; i++) {
		const data = await net.api(`${THUMBS}/users/avatar?${qs({ userIds: userId, size, format: "Png", isCircular: "false" })}`);
		const t = data?.data?.[0];
		if (t?.state === "Completed" && t.imageUrl) return t.imageUrl;
		if (t && t.state !== "Pending") return null;
		await new Promise((r) => setTimeout(r, wait));
	}
	return null;
}

/** Saved outfits: [{ id, name }]. */
export async function listOutfits(net, userId) {
	const data = await net.api(`${AVATAR}/v2/avatar/users/${encodeURIComponent(userId)}/outfits?${qs({ page: 1, itemsPerPage: 50, isEditable: "true" })}`);
	return (data?.data || []).filter((o) => o?.id).map((o) => ({ id: String(o.id), name: o.name || "Outfit" }));
}

/** An outfit as an avatar to put on: { type, assets, bodyColors }. */
export async function outfitAvatar(net, outfitId) {
	const data = await net.api(`${AVATAR}/v3/outfits/${encodeURIComponent(outfitId)}/details`);
	const colors = data?.bodyColor3s || {};
	return {
		type: avatarType(data?.playerAvatarType),
		assets: (data?.assets || []).map(asset),
		bodyColors: Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, String(v).replace(/^#/, "").toUpperCase()])),
	};
}

const sameAssets = (a, b) => a.length === b.length && a.every((x) => b.some((y) => y.id === x.id));
const sameColors = (a, b) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);

/**
 * Saves what changed between `before` and `after` (both shaped like currentAvatar's answer), then
 * asks Roblox to redraw the picture. Resolves { invalid: [asset ids Roblox refused] }.
 */
export async function saveAvatar(net, before, after) {
	let invalid = [];
	if (!sameAssets(before.assets, after.assets)) {
		const r = await net.api(`${AVATAR}/v2/avatar/set-wearing-assets`, {
			method: "POST",
			body: { assets: after.assets.map((a) => (a.meta ? { id: Number(a.id), meta: a.meta } : { id: Number(a.id) })) },
		});
		invalid = (r?.invalidAssetIds || []).map(String);
	}
	if (before.type !== after.type) {
		await net.api(`${AVATAR}/v1/avatar/set-player-avatar-type`, { method: "POST", body: { playerAvatarType: after.type } });
	}
	if (!sameColors(before.bodyColors, after.bodyColors) && Object.keys(after.bodyColors).length) {
		const hash = before.colorsHaveHash ? "#" : "";
		await net.api(`${AVATAR}/v2/avatar/set-body-colors`, {
			method: "POST",
			body: Object.fromEntries(Object.entries(after.bodyColors).map(([k, v]) => [k, `${hash}${v}`])),
		});
	}
	await net.api(`${AVATAR}/v1/avatar/redraw-thumbnail`, { method: "POST", body: {} }).catch(() => {});
	return { invalid };
}

/** Every body part in one colour. */
export const skinTone = (hex) => Object.fromEntries(["headColor3", "torsoColor3", "rightArmColor3", "leftArmColor3", "rightLegColor3", "leftLegColor3"].map((k) => [k, hex]));
