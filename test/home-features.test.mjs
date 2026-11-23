import assert from "node:assert/strict";
import { test } from "node:test";
import { avatarPicture, avatarRules, currentAvatar, outfitAvatar, ownedItems, saveAvatar, skinTone, takeOff, wear } from "../src/js/lib/avatar.js";
import { allCharts, chartPage } from "../src/js/lib/charts.js";
import { CookieJar } from "../src/js/lib/cookiejar.js";
import { RobloxNet } from "../src/js/lib/robloxnet.js";
import { acceptFriendRequest, friendRequests, friendsList, headshots, presences, sendFriendRequest, userByName } from "../src/js/lib/social.js";

// A fake EpoxyClient playing Roblox: routes keyed "METHOD host/path".
function fakeRoblox(routes) {
	const calls = [];
	return {
		calls,
		async fetch(url, init) {
			const u = new URL(url);
			const key = `${(init.method || "GET").toUpperCase()} ${u.host}${u.pathname}`;
			const call = { key, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
			calls.push(call);
			const route = routes[key];
			const out = route ? await route(call) : { status: 404, body: { errors: [{ code: 0, message: `no route ${key}` }] } };
			const res = new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
			res.rawHeaders = out.headers || {};
			return res;
		},
		async replace_stream_provider() {},
	};
}
const netFor = (routes) => {
	const client = fakeRoblox(routes);
	return { client, net: new RobloxNet({ client, jar: new CookieJar() }) };
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

test("charts: keeps lists of experiences, follows pages, maps the fields cards use", async () => {
	const game = (id, extra = {}) => ({ universeId: id, rootPlaceId: id * 10, name: `Game ${id}`, playerCount: 1000 + id, totalUpVotes: 90, totalDownVotes: 10, ...extra });
	const { net, client } = netFor({
		"GET apis.roblox.com/explore-api/v1/get-sorts": (c) =>
			c.query.sortsPageToken
				? { body: { sorts: [{ sortId: "most-popular", sortDisplayName: "Most Popular", contentType: "Games", games: [game(3)] }, { sortId: "music", contentType: "Songs", games: [] }] } }
				: {
						body: {
							sorts: [
								{ sortId: "filters_v5", contentType: "Filters", games: [] },
								{ sortId: "top-trending", sortDisplayName: "Top Trending", contentType: "Games", games: [game(1), game(2, { isSponsored: true }), { universeId: 9 }] },
							],
							nextSortsPageToken: "P2",
						},
					},
	});
	const first = await chartPage(net, { sessionId: "S" });
	assert.equal(first.nextPageToken, "P2");
	assert.deepEqual(first.charts.map((c) => c.id), ["top-trending"]);
	assert.deepEqual(first.charts[0].games[0], { universeId: "1", placeId: "10", name: "Game 1", playerCount: 1001, upVotes: 90, downVotes: 10, sponsored: false });
	assert.equal(first.charts[0].games[1].sponsored, true);
	assert.equal(first.charts[0].games.length, 2, "incomplete entries are dropped");
	const pages = [];
	const all = await allCharts(net, { sessionId: "S", onPage: (c) => pages.push(c.length) });
	assert.deepEqual(all.map((c) => c.name), ["Top Trending", "Most Popular"]);
	assert.deepEqual(pages, [1, 2]);
	assert.equal(client.calls.at(-1).query.sessionId, "S");
	assert.equal(client.calls.at(-1).query.device, "computer");
});

test("friends: list with names filled in, presence kinds, headshots", async () => {
	const { net, client } = netFor({
		"GET friends.roblox.com/v1/users/42/friends": () => ({ body: { data: [{ id: 7, name: "", displayName: "" }, { id: 8, name: "bob", displayName: "Bobby" }, { id: 9, isDeleted: true }] } }),
		"POST users.roblox.com/v1/users": (c) => {
			assert.deepEqual(c.body, { userIds: [7], excludeBannedUsers: false });
			return { body: { data: [{ id: 7, name: "alice", displayName: "Alice", hasVerifiedBadge: true }] } };
		},
		"POST presence.roblox.com/v1/presence/users": () => ({
			body: {
				userPresences: [
					{ userId: 7, userPresenceType: 2, lastLocation: "Obby", placeId: 111, rootPlaceId: 111, gameId: "g-1", universeId: 5 },
					{ userId: 8, userPresenceType: "InStudio", lastLocation: "Studio" },
					{ userId: 9, userPresenceType: 2, lastLocation: "Hidden game" },
				],
			},
		}),
		"GET thumbnails.roblox.com/v1/users/avatar-headshot": (c) => {
			assert.equal(c.query.userIds, "7,8");
			return { body: { data: [{ targetId: 7, state: "Completed", imageUrl: "https://tr.rbxcdn.com/a.png" }, { targetId: 8, state: "Pending" }] } };
		},
	});
	const friends = await friendsList(net, "42");
	assert.deepEqual(friends, [
		{ id: "7", name: "alice", displayName: "Alice", verified: true },
		{ id: "8", name: "bob", displayName: "Bobby", verified: false },
	]);
	const pres = await presences(net, ["7", "8", "9"]);
	assert.deepEqual(pres.get("7"), { kind: "game", place: "Obby", placeId: "111", gameId: "g-1", universeId: "5", joinable: true });
	assert.equal(pres.get("8").kind, "studio");
	assert.equal(pres.get("9").joinable, false, "a game with no server id can't be followed");
	const pics = await headshots(net, ["7", "8"]);
	assert.deepEqual([...pics], [["7", "https://tr.rbxcdn.com/a.png"]]);
	assert.ok(client.calls.some((c) => c.key === "GET friends.roblox.com/v1/users/42/friends" && c.query.userSort === "StatusFrequents"));
});

test("friend requests: list, accept, look up a username", async () => {
	const { net, client } = netFor({
		"GET friends.roblox.com/v1/my/friends/requests": () => ({ body: { data: [{ id: 5, name: "carol", displayName: "Carol", friendRequest: { sentAt: "2026-11-01T00:00:00Z" } }], nextPageCursor: "N" } }),
		"POST friends.roblox.com/v1/users/5/accept-friend-request": () => ({ body: {} }),
		"POST users.roblox.com/v1/usernames/users": (c) => ({ body: { data: c.body.usernames[0] === "carol" ? [{ id: 5, name: "carol", displayName: "Carol", requestedUsername: "carol" }] : [] } }),
	});
	const { requests, nextCursor } = await friendRequests(net);
	assert.equal(nextCursor, "N");
	assert.deepEqual(requests[0], { id: "5", name: "carol", displayName: "Carol", verified: false, sentAt: "2026-11-01T00:00:00Z" });
	await acceptFriendRequest(net, "5");
	assert.ok(client.calls.some((c) => c.key === "POST friends.roblox.com/v1/users/5/accept-friend-request"));
	assert.equal((await userByName(net, " @carol ")).id, "5");
	assert.equal(await userByName(net, "nobody"), null);
});

test("sending a friend request answers a proof-of-work check, and reports a CAPTCHA", async () => {
	let tries = 0;
	const { net } = netFor({
		"POST friends.roblox.com/v1/users/6/request-friendship": (c) => {
			tries++;
			assert.deepEqual(c.body, { friendshipOriginSourceType: "UserProfile" });
			if (!c.headers["rblx-challenge-id"]) return { status: 403, headers: { "rblx-challenge-id": "C", "rblx-challenge-type": "proofofwork", "rblx-challenge-metadata": b64({ sessionId: "S" }) }, body: {} };
			return { body: { success: true } };
		},
		"GET apis.roblox.com/proof-of-work-service/v1/pow-puzzle": () => ({ body: { puzzleType: "1", artifacts: JSON.stringify({ N: "3233", A: 5, T: 3 }) } }),
		"POST apis.roblox.com/proof-of-work-service/v1/pow-puzzle": () => ({ body: { answerCorrect: true, redemptionToken: "RT" } }),
		"POST apis.roblox.com/challenge/v1/continue": () => ({ body: {} }),
	});
	assert.deepEqual(await sendFriendRequest(net, "6"), { success: true });
	assert.equal(tries, 2);
	const captcha = netFor({
		"POST friends.roblox.com/v1/users/6/request-friendship": () => ({ status: 403, headers: { "rblx-challenge-id": "C", "rblx-challenge-type": "captcha", "rblx-challenge-metadata": b64({}) }, body: {} }),
	});
	await assert.rejects(sendFriendRequest(captcha.net, "6"), (e) => e.captcha === true);
});

test("wearing respects Roblox's limits per type and for accessories", () => {
	const maxByType = new Map([
		[8, 3],
		[11, 1],
		[41, 2],
		[42, 1],
		[43, 1],
		[44, 1],
		[45, 1],
		[46, 1],
		[47, 1],
		[67, 1],
	]);
	const item = (id, typeId) => ({ id: String(id), name: `Item ${id}`, typeId });
	let worn = [item(1, 11)];
	worn = wear(worn, item(2, 11), maxByType);
	assert.deepEqual(worn.map((a) => a.id), ["2"], "a second shirt replaces the first");
	for (const id of [10, 11, 12, 13]) worn = wear(worn, item(id, 8), maxByType);
	assert.deepEqual(worn.filter((a) => a.typeId === 8).map((a) => a.id), ["11", "12", "13"], "three hats at most, oldest off first");
	worn = wear(worn, item(13, 8), maxByType);
	assert.equal(worn.filter((a) => a.typeId === 8).length, 3, "wearing what's on changes nothing");
	const accessoryCount = () => worn.filter((a) => [8, 41, 42, 43, 44, 45, 46, 47].includes(a.typeId)).length;
	for (const [id, t] of [[20, 41], [21, 42], [22, 43], [23, 44], [24, 45], [25, 46], [26, 47]]) worn = wear(worn, item(id, t), maxByType);
	assert.equal(accessoryCount(), 10, "ten accessories are fine");
	assert.ok(worn.some((a) => a.id === "11"));
	worn = wear(worn, item(27, 41), maxByType); // a second hair item: the eleventh accessory
	assert.equal(accessoryCount(), 10, "never more than ten");
	assert.ok(!worn.some((a) => a.id === "11"), "the oldest accessory made room");
	assert.ok(worn.some((a) => a.id === "27"));
	const jacket = wear([], item(30, 67), maxByType)[0];
	assert.deepEqual(jacket.meta, { order: 10, version: 1 }, "layered clothing gets a layer order");
	assert.deepEqual(takeOff(worn, 2).map((a) => a.id).includes("2"), false);
});

test("avatar: reads what's worn, saves only what changed, waits for the new picture", async () => {
	const posted = [];
	let renders = 0;
	const { net } = netFor({
		"GET avatar.roblox.com/v1/avatar-rules": () => ({ body: { wearableAssetTypes: [{ id: 8, name: "Hat", maxNumber: 3 }], basicBodyColorsPalette: [{ name: "Nougat", hexColor: "#CC8E69" }] } }),
		"GET avatar.roblox.com/v2/avatar/avatar": () => ({
			body: {
				playerAvatarType: "R15",
				bodyColor3s: { headColor3: "#EAB892", torsoColor3: "#EAB892", rightArmColor3: "#EAB892", leftArmColor3: "#EAB892", rightLegColor3: "#EAB892", leftLegColor3: "#EAB892" },
				assets: [{ id: 101, name: "Cap", assetType: { id: 8, name: "Hat" } }, { id: 202, name: "Jacket", assetType: { id: 67, name: "JacketAccessory" }, meta: { order: 10, version: 1 } }],
			},
		}),
		"POST avatar.roblox.com/v2/avatar/set-wearing-assets": (c) => (posted.push(["assets", c.body]), { body: { invalidAssetIds: [303], success: true } }),
		"POST avatar.roblox.com/v1/avatar/set-player-avatar-type": (c) => (posted.push(["type", c.body]), { body: { success: true } }),
		"POST avatar.roblox.com/v2/avatar/set-body-colors": (c) => (posted.push(["colors", c.body]), { body: { success: true } }),
		"POST avatar.roblox.com/v1/avatar/redraw-thumbnail": () => (posted.push(["redraw"]), { body: {} }),
		"GET thumbnails.roblox.com/v1/users/avatar": () => ({ body: { data: [renders++ < 2 ? { targetId: 42, state: "Pending" } : { targetId: 42, state: "Completed", imageUrl: "https://tr.rbxcdn.com/new.png" }] } }),
		"GET inventory.roblox.com/v2/users/42/inventory/8": (c) => ({ body: { data: [{ assetId: 101, assetName: "Cap" }, { assetId: 303, assetName: "Crown" }], nextPageCursor: c.query.cursor ? null : "more" } }),
		"GET inventory.roblox.com/v2/users/42/inventory/41": () => ({ body: { data: [{ assetId: 404, assetName: "Hair" }], nextPageCursor: null } }),
		"GET avatar.roblox.com/v3/outfits/9/details": () => ({ body: { playerAvatarType: "R6", assets: [{ id: 101, name: "Cap", assetType: { id: 8, name: "Hat" } }], bodyColor3s: { headColor3: "F8D6BD" } } }),
	});
	const rules = await avatarRules(net);
	assert.equal(rules.maxByType.get(8), 3);
	assert.deepEqual(rules.skinTones, [{ name: "Nougat", hex: "CC8E69" }]);

	const before = await currentAvatar(net);
	assert.equal(before.type, "R15");
	assert.equal(before.colorsHaveHash, true);
	assert.equal(before.bodyColors.headColor3, "EAB892");
	assert.deepEqual(before.assets.map((a) => [a.id, a.typeId]), [["101", 8], ["202", 67]]);

	const { items, cursors } = await ownedItems(net, "42", [8, 41]);
	assert.deepEqual(items.map((i) => i.id), ["101", "303", "404"]);
	assert.deepEqual(cursors, { 8: "more", 41: null });
	const more = await ownedItems(net, "42", [8, 41], cursors);
	assert.deepEqual(more.items.map((i) => i.id), ["101", "303"], "only the type with more pages is asked again");

	// Nothing changed: nothing but the redraw is sent.
	await saveAvatar(net, before, { ...before });
	assert.deepEqual(posted.map((p) => p[0]), ["redraw"]);
	posted.length = 0;

	const after = { ...before, type: "R6", assets: wear(before.assets, { id: "303", name: "Crown", typeId: 8 }, rules.maxByType), bodyColors: skinTone("CC8E69") };
	const { invalid } = await saveAvatar(net, before, after);
	assert.deepEqual(invalid, ["303"]);
	assert.deepEqual(posted[0], ["assets", { assets: [{ id: 101 }, { id: 202, meta: { order: 10, version: 1 } }, { id: 303 }] }]);
	assert.deepEqual(posted[1], ["type", { playerAvatarType: "R6" }]);
	assert.equal(posted[2][1].headColor3, "#CC8E69", "colours go back in the form Roblox sent them");
	assert.equal(posted[3][0], "redraw");

	assert.equal(await avatarPicture(net, "42", { wait: 5 }), "https://tr.rbxcdn.com/new.png");
	const outfit = await outfitAvatar(net, "9");
	assert.equal(outfit.type, "R6");
	assert.deepEqual(outfit.assets.map((a) => a.id), ["101"]);
	assert.equal(outfit.bodyColors.headColor3, "F8D6BD");
});
