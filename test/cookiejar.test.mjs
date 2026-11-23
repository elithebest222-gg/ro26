import assert from "node:assert/strict";
import { test } from "node:test";
import { CookieJar, parseSetCookie } from "../src/js/lib/cookiejar.js";

const u = (s) => new URL(s);

test("domain cookies reach subdomains, host-only cookies do not", () => {
	const jar = new CookieJar();
	jar.setCookies([".ROBLOSECURITY=abc; domain=.roblox.com; path=/; secure; HttpOnly", "hostonly=1; path=/"], u("https://www.roblox.com/login"));
	assert.equal(jar.cookieHeader(u("https://gamejoin.roblox.com/v1/join-game")), ".ROBLOSECURITY=abc");
	assert.match(jar.cookieHeader(u("https://www.roblox.com/home")), /hostonly=1/);
});

test("max-age<=0 deletes, expires in the past deletes", () => {
	const jar = new CookieJar();
	const url = u("https://www.roblox.com/");
	jar.setCookies(["a=1; domain=roblox.com; path=/", "b=2; path=/"], url);
	assert.equal(jar.setCookies(["a=; domain=roblox.com; path=/; max-age=0", "b=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"], url), true);
	assert.equal(jar.cookieHeader(url), "");
});

test("refuses cookies for other domains or bare TLDs", () => {
	assert.equal(parseSetCookie("x=1; domain=example.com", u("https://www.roblox.com/")), null);
	assert.equal(parseSetCookie("x=1; domain=com", u("https://www.roblox.com/")), null);
});

test("path matching and ordering (longest path first)", () => {
	const jar = new CookieJar();
	const url = u("https://apis.roblox.com/a/b/c");
	jar.setCookies(["root=1; path=/", "deep=2; path=/a/b"], url);
	assert.equal(jar.cookieHeader(u("https://apis.roblox.com/a/b/c")), "deep=2; root=1");
	assert.equal(jar.cookieHeader(u("https://apis.roblox.com/a/bc")), "root=1");
});

test("round-trips through JSON", () => {
	const jar = new CookieJar();
	jar.setCookies([".ROBLOSECURITY=abc; domain=.roblox.com; path=/; max-age=3600"], u("https://www.roblox.com/"));
	const again = new CookieJar(JSON.parse(JSON.stringify(jar.toJSON())));
	assert.equal(again.cookieHeader(u("https://users.roblox.com/")), ".ROBLOSECURITY=abc");
});
