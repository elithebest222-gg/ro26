import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFsIndex, safeRelPath } from "../scripts/vendor-engine.mjs";

test("parses prefix-compressed rbxfsindex", () => {
	const buf = Buffer.from("rbxfsindex 1\n0\t/content/a.png\t10\n9\tb.png\t20\n1\tshaders/x.pack\t30\n");
	assert.deepEqual(parseFsIndex(buf), [
		{ path: "/content/a.png", size: 10 },
		{ path: "/content/b.png", size: 20 },
		{ path: "/shaders/x.pack", size: 30 },
	]);
	assert.throws(() => parseFsIndex(Buffer.from("nope\n")), /header/);
});

test("rejects paths that escape the output directory", () => {
	assert.equal(safeRelPath("/content/ok file.png"), "content/ok file.png");
	for (const bad of ["content/x", "/../etc/passwd", "/a//b", "/a/./b", "/a\\b"]) assert.equal(safeRelPath(bad), null);
});
