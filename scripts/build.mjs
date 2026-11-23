#!/usr/bin/env node
// Builds the static site into _site/.
//
//   node scripts/build.mjs [--engine local|cdn|none] [--out _site]
//
// --engine local (default)  copy the pinned engine into the site, so the player loads it from
//                           the page's own origin (downloads it into .cache/ first if needed)
// --engine cdn              ship only the pinned flags; the player's service worker streams
//                           the engine from Roblox's CDN
// --engine none             no engine at all (UI work only)
// WEBBLOX_ENGINE=... does the same as --engine.

import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, arg("out", "_site"));
const ENGINE_MODE = arg("engine", process.env.WEBBLOX_ENGINE || "local");
if (!["local", "cdn", "none"].includes(ENGINE_MODE)) {
	console.error(`--engine must be local, cdn or none (got ${ENGINE_MODE})`);
	process.exit(2);
}

const nm = (...p) => path.join(ROOT, "node_modules", ...p);

async function copyStatic(dir = SRC) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const from = path.join(dir, entry.name);
		const rel = path.relative(SRC, from);
		if (entry.isDirectory()) {
			if (rel === "js") continue; // bundled below
			await copyStatic(from);
		} else if (!entry.name.endsWith(".js")) {
			await mkdir(path.dirname(path.join(OUT, rel)), { recursive: true });
			await cp(from, path.join(OUT, rel));
		}
	}
}

async function bundle() {
	const common = {
		bundle: true,
		minify: true,
		sourcemap: "linked",
		target: ["chrome110", "firefox115", "safari16.4"],
		legalComments: "linked",
		logLevel: "warning",
	};
	// Pages: ES modules with shared chunks.
	await esbuild.build({
		...common,
		entryPoints: [path.join(SRC, "js/launcher.js"), path.join(SRC, "js/browser.js")],
		outdir: path.join(OUT, "js"),
		format: "esm",
		splitting: true,
		chunkNames: "chunks/[name]-[hash]",
	});
	// The player and its worker are self-contained, so everything they load stays inside the
	// player service worker's scope.
	for (const entry of ["player/boot.js", "player/net.worker.js", "player/tunnel.worker.js"]) {
		await esbuild.build({ ...common, entryPoints: [path.join(SRC, entry)], outfile: path.join(OUT, entry), format: "esm" });
	}
	// Service workers, and the WebTransport stand-in the engine's (classic) workers import, are
	// classic scripts.
	for (const [entry, out] of [
		["sw.js", "sw.js"],
		["player/sw.js", "player/sw.js"],
		["player/wt-shim.entry.js", "player/wt-shim.js"],
	]) {
		await esbuild.build({ ...common, entryPoints: [path.join(SRC, entry)], outfile: path.join(OUT, out), format: "iife" });
	}
}

// Trusted roots for game connections through the Wisp tunnel whose certificate is not pinned:
// Mozilla's root store as bundled with Node, the same set browsers use.
async function writeRoots() {
	const roots = rootCertificates.map((pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, ""));
	const file = { source: `Mozilla root store from Node ${process.version}`, roots };
	await writeFile(path.join(OUT, "player/roots.json"), JSON.stringify(file));
}

async function copyScramjet() {
	await mkdir(path.join(OUT, "scramjet"), { recursive: true });
	await mkdir(path.join(OUT, "controller"), { recursive: true });
	for (const f of ["scramjet.js", "scramjet.wasm"]) await cp(nm("@mercuryworkshop/scramjet/dist", f), path.join(OUT, "scramjet", f));
	for (const f of ["controller.api.js", "controller.inject.js", "controller.sw.js"]) {
		await cp(nm("@mercuryworkshop/scramjet-controller/dist", f), path.join(OUT, "controller", f));
	}
}

// WebClient.wasm is ~100 MB, right at the size where static hosts start refusing single
// files. Ship it in parts; the player's service worker streams them back together.
const WASM_PART_SIZE = 32 * 1024 * 1024;
async function splitFile(file, partSize) {
	const data = await readFile(file);
	const parts = [];
	for (let i = 0, off = 0; off < data.length; i++, off += partSize) {
		const name = `${path.basename(file)}.${i}`;
		const chunk = data.subarray(off, off + partSize);
		await writeFile(path.join(path.dirname(file), name), chunk);
		parts.push({ name, size: chunk.length });
	}
	await rm(file);
	return parts;
}

async function installEngine() {
	if (ENGINE_MODE === "none") return null;
	const pin = JSON.parse(await readFile(path.join(ROOT, "engine/pin.json"), "utf8"));
	const v = pin.clientVersionUpload;
	const dest = path.join(OUT, "player/engine", v);
	let wasmParts = null;
	if (ENGINE_MODE === "local") {
		const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/vendor-engine.mjs"), "fetch", "--dest", dest], { stdio: "inherit" });
		if (r.status !== 0) throw new Error("Fetching the engine failed; build with --engine cdn to skip it.");
		wasmParts = await splitFile(path.join(dest, "WebClient.wasm"), WASM_PART_SIZE);
	}
	await cp(path.join(ROOT, "engine", v, "flags"), path.join(dest, "flags"), { recursive: true });
	const config = {
		binaryType: pin.binaryType,
		version: pin.version,
		clientVersionUpload: v,
		mode: ENGINE_MODE,
		cdnBase: pin.cdnBase,
		wasmSize: pin.core?.["WebClient.wasm"]?.size ?? null,
		wasmParts,
		flags: pin.flags,
		builtAt: new Date().toISOString(),
	};
	await writeFile(path.join(OUT, "player/engine.json"), `${JSON.stringify(config, null, "\t")}\n`);
	return config;
}

async function dirSize(dir) {
	let n = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		n += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size;
	}
	return n;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await copyStatic();
await bundle();
await writeRoots();
await copyScramjet();
const engine = await installEngine();
await writeFile(path.join(OUT, ".nojekyll"), "");

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`Built ${path.relative(ROOT, OUT)}/ (${mb(await dirSize(OUT))})`);
if (engine) console.log(`  engine ${engine.clientVersionUpload} (${engine.version ?? "?"}), mode ${engine.mode}`);
else console.log("  no engine (--engine none)");
