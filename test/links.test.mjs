import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLaunchAttempt, parseLaunchInput, playerUrl } from "../src/js/lib/links.js";

const launcher = (q) =>
	`roblox-player:1+launchmode:play+gameinfo:TICKET+launchtime:1700000000000+placelauncherurl:${encodeURIComponent(`https://www.roblox.com/Game/PlaceLauncher.ashx?${q}`)}+browsertrackerid:123+robloxLocale:en_us+gameLocale:en_us+channel:+LaunchExp:InApp`;
const GUID = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

test("roblox-player: RequestGame / RequestGameJob / RequestFollowUser", () => {
	assert.deepEqual(parseLaunchAttempt(launcher("request=RequestGame&placeId=1818&isPlayTogetherGame=false")), { placeId: "1818" });
	assert.deepEqual(parseLaunchAttempt(launcher(`request=RequestGameJob&placeId=1818&gameId=${GUID}`)), { placeId: "1818", gameId: GUID });
	assert.deepEqual(parseLaunchAttempt(launcher("request=RequestFollowUser&userId=156")), { followUserId: "156" });
});

test("roblox:// deep links", () => {
	assert.deepEqual(parseLaunchAttempt(`roblox://placeId=1818&gameInstanceId=${GUID}`), { placeId: "1818", gameId: GUID });
	assert.deepEqual(parseLaunchAttempt("roblox://experiences/start?placeId=920587237"), { placeId: "920587237" });
	assert.equal(parseLaunchAttempt("roblox://navigation/home"), null);
});

test("/games/start counts as a launch, a game page does not", () => {
	assert.deepEqual(parseLaunchAttempt("https://www.roblox.com/games/start?placeId=1818&launchData=x"), { placeId: "1818" });
	assert.equal(parseLaunchAttempt("https://www.roblox.com/games/1818/Classic-Crossroads"), null);
});

test("pasted input", () => {
	assert.deepEqual(parseLaunchInput("1818"), { placeId: "1818" });
	assert.deepEqual(parseLaunchInput("https://www.roblox.com/games/1818/Classic-Crossroads"), { placeId: "1818" });
	assert.deepEqual(parseLaunchInput("roblox.com/de/games/1818"), { placeId: "1818" });
	assert.deepEqual(parseLaunchInput("https://www.roblox.com/games/1818?privateServerLinkCode=abc"), { placeId: "1818", linkCode: "abc" });
	assert.deepEqual(parseLaunchInput("https://www.roblox.com/share?code=abc123&type=Server"), { share: { code: "abc123", type: "Server" } });
	assert.equal(parseLaunchInput("obby"), null);
	assert.equal(parseLaunchInput("https://example.com/games/1818"), null);
});

test("player URL keeps only join parameters", () => {
	assert.equal(playerUrl("https://x.github.io/ro26/", { placeId: "1", gameId: GUID, junk: "y" }), `https://x.github.io/ro26/player/?placeId=1&gameId=${GUID}`);
});
