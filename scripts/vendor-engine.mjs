#!/usr/bin/env node
// Pulls Roblox's official browser client (binary type "WebClientApp") from Roblox's
// own endpoints and pins it.
//
//   node scripts/vendor-engine.mjs latest            print the version Roblox currently ships
//   node scripts/vendor-engine.mjs pin [--version version-xxxxxxxx] [--if-newer]
//        resolve a version, snapshot its flags next to it (engine/<version>/flags/),
//        record core file sizes + hashes in engine/pin.json
//   node scripts/vendor-engine.mjs fetch [--dest <dir>]
//        download every file of the pinned version (core files + everything listed in
//        WebClient.fsindex.txt) into .cache/engine/<version>/, then copy it to <dest>
//
// Nothing downloaded here is committed: only engine/pin.json and the pinned flags are.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// Node's fetch only honours HTTPS_PROXY when NODE_USE_ENV_PROXY is set at startup.
if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
	const r = spawnSync(process.execPath, process.argv.slice(1), {
		stdio: "inherit",
		env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" },
	});
	process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = path.join(ROOT, "engine");
const PIN_FILE = path.join(ENGINE_DIR, "pin.json");
const CACHE_DIR = path.join(ROOT, ".cache", "engine");

const BINARY_TYPE = "WebClientApp";
// WasmPlayer.js asks for a platform-specific flag set when it recognises the host OS.
const FLAG_APPS = ["WebClientApp", "WindowsWebClientApp", "MacWebClientApp", "AndroidWebClientApp", "iOSWebClientApp"];
const CORE_FILES = ["WasmPlayer.js", "WebClient.js", "WebClient.wasm", "WebClient.fsindex.txt", "audio-processor-fast.js"];

const VERSION_URL = `https://clientsettings.roblox.com/v2/client-version/${BINARY_TYPE}`;
const FLAGS_URL = (app) => `https://clientsettingscdn.roblox.com/v2/settings/application/${app}`;
export const cdnBase = (clientVersionUpload) =>
	`https://setup.rbxcdn.com/webclient/${clientVersionUpload}-RobloxWebClient/`;

const UA = "webblox-vendor/1.0";

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				out[key] = next;
				i++;
			} else out[key] = true;
		} else out._.push(a);
	}
	return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, { attempts = 4, ...init } = {}) {
	let lastErr;
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers || {}) } });
			// 4xx other than 408/429 will not get better by retrying.
			if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)) return res;
			lastErr = new Error(`HTTP ${res.status} for ${url}`);
			await res.body?.cancel();
		} catch (err) {
			lastErr = err;
		}
		await sleep(500 * 2 ** i);
	}
	throw lastErr;
}

async function fetchJson(url) {
	const res = await fetchWithRetry(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.json();
}

async function fetchBytes(url) {
	const res = await fetchWithRetry(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return Buffer.from(await res.arrayBuffer());
}

export async function latestVersion() {
	const j = await fetchJson(VERSION_URL);
	if (!/^version-[0-9a-f]{16}$/.test(j.clientVersionUpload || "")) {
		throw new Error(`Unexpected client-version response: ${JSON.stringify(j)}`);
	}
	return { version: j.version || null, clientVersionUpload: j.clientVersionUpload };
}

// "rbxfsindex 1\n" followed by "<shared prefix length>\t<suffix>\t<size>\n" per file,
// where each path reuses the first <shared prefix length> bytes of the previous one.
export function parseFsIndex(buf) {
	const HEADER = Buffer.from("rbxfsindex 1\n");
	if (!buf.subarray(0, HEADER.length).equals(HEADER)) throw new Error("WebClient.fsindex.txt: unsupported header");
	const files = [];
	let pos = HEADER.length;
	let prev = Buffer.alloc(0);
	const readUntil = (byte) => {
		const end = buf.indexOf(byte, pos);
		if (end < 0) throw new Error("WebClient.fsindex.txt: truncated");
		const slice = buf.subarray(pos, end);
		pos = end + 1;
		return slice;
	};
	const num = (b) => {
		const s = b.toString("latin1");
		if (!/^[0-9]+$/.test(s)) throw new Error("WebClient.fsindex.txt: malformed number");
		return Number(s);
	};
	while (pos < buf.length) {
		const shared = num(readUntil(9));
		const suffix = readUntil(9);
		const size = num(readUntil(10));
		if (shared > prev.length) throw new Error("WebClient.fsindex.txt: bad prefix length");
		const full = Buffer.concat([prev.subarray(0, shared), suffix]);
		files.push({ path: full.toString("utf8"), size });
		prev = full;
	}
	return files;
}

// The index comes from the network, so refuse anything that could escape the output dir.
export function safeRelPath(p) {
	if (typeof p !== "string" || !p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
	const segs = p.slice(1).split("/");
	if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
	return segs.join("/");
}

const encodePath = (rel) =>
	rel
		.split("/")
		.map((s) => encodeURIComponent(s).replace(/%40/g, "@"))
		.join("/");

async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function readPin() {
	try {
		return JSON.parse(await readFile(PIN_FILE, "utf8"));
	} catch {
		return null;
	}
}

// Streams url -> file, returning { size, sha256 }.
async function download(url, file) {
	await mkdir(path.dirname(file), { recursive: true });
	const res = await fetchWithRetry(url);
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
	const hash = createHash("sha256");
	let size = 0;
	const tmp = `${file}.part`;
	await pipeline(
		Readable.fromWeb(res.body),
		new Transform({
			transform(chunk, _enc, cb) {
				hash.update(chunk);
				size += chunk.length;
				cb(null, chunk);
			},
		}),
		createWriteStream(tmp),
	);
	await rename(tmp, file);
	return { size, sha256: hash.digest("hex") };
}

async function sha256File(file) {
	return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function cmdLatest() {
	const v = await latestVersion();
	const pin = await readPin();
	console.log(JSON.stringify({ ...v, pinned: pin?.clientVersionUpload ?? null }, null, 2));
}

async function cmdPin(args) {
	const current = await readPin();
	const latest = await latestVersion();
	let target = latest;
	if (typeof args.version === "string") {
		if (!/^version-[0-9a-f]{16}$/.test(args.version)) throw new Error(`Bad --version ${args.version}`);
		target = { version: args.version === latest.clientVersionUpload ? latest.version : null, clientVersionUpload: args.version };
	}
	const setOutput = async (changed) => {
		if (process.env.GITHUB_OUTPUT) {
			await writeFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nversion=${target.clientVersionUpload}\n`, { flag: "a" });
		}
	};
	if (args["if-newer"] && current?.clientVersionUpload === target.clientVersionUpload) {
		console.log(`Already pinned to ${target.clientVersionUpload}; nothing to do.`);
		await setOutput(false);
		return;
	}

	const base = cdnBase(target.clientVersionUpload);
	const cache = path.join(CACHE_DIR, target.clientVersionUpload);
	console.log(`Pinning ${target.clientVersionUpload} (${target.version ?? "version unknown"}) from ${base}`);

	// Core files: download once, record size + hash so later fetches can be verified and the
	// service worker can report real download progress for WebClient.wasm.
	const core = {};
	for (const name of CORE_FILES) {
		const info = await download(base + name, path.join(cache, name));
		core[name] = info;
		console.log(`  ${name.padEnd(26)} ${(info.size / 1048576).toFixed(2).padStart(8)} MB`);
	}
	const index = parseFsIndex(await readFile(path.join(cache, "WebClient.fsindex.txt")));
	const bad = index.filter((f) => safeRelPath(f.path) === null);
	if (bad.length) throw new Error(`fsindex has ${bad.length} unsafe paths, e.g. ${JSON.stringify(bad[0].path)}`);
	const contentBytes = index.reduce((n, f) => n + f.size, 0);
	console.log(`  content: ${index.length} files, ${(contentBytes / 1048576).toFixed(1)} MB`);

	// Flags: snapshot them now, so a later flag push cannot break this engine build.
	const versionDir = path.join(ENGINE_DIR, target.clientVersionUpload);
	await rm(versionDir, { recursive: true, force: true });
	await mkdir(path.join(versionDir, "flags"), { recursive: true });
	const flags = {};
	const byHash = new Map();
	for (const app of FLAG_APPS) {
		const body = await fetchBytes(FLAGS_URL(app));
		const parsed = JSON.parse(body.toString("utf8"));
		if (!parsed || typeof parsed.applicationSettings !== "object") throw new Error(`No applicationSettings for ${app}`);
		const hash = createHash("sha256").update(body).digest("hex");
		let file = byHash.get(hash);
		if (!file) {
			file = `${app}.json`;
			byHash.set(hash, file);
			// Re-serialise with sorted keys so diffs between pins stay readable.
			const sorted = Object.fromEntries(Object.entries(parsed.applicationSettings).sort(([a], [b]) => (a < b ? -1 : 1)));
			await writeFile(path.join(versionDir, "flags", file), `${JSON.stringify({ applicationSettings: sorted }, null, "\t")}\n`);
		}
		flags[app] = `flags/${file}`;
		console.log(`  flags ${app.padEnd(20)} -> ${file} (${Object.keys(parsed.applicationSettings).length} flags)`);
	}

	const pin = {
		binaryType: BINARY_TYPE,
		version: target.version,
		clientVersionUpload: target.clientVersionUpload,
		cdnBase: base,
		pinnedAt: new Date().toISOString(),
		core,
		content: { files: index.length, bytes: contentBytes },
		flags,
	};
	await writeFile(PIN_FILE, `${JSON.stringify(pin, null, "\t")}\n`);

	// Only one engine version is kept in the repo.
	for (const entry of await readdir(ENGINE_DIR, { withFileTypes: true })) {
		if (entry.isDirectory() && /^version-[0-9a-f]{16}$/.test(entry.name) && entry.name !== target.clientVersionUpload) {
			await rm(path.join(ENGINE_DIR, entry.name), { recursive: true, force: true });
			console.log(`  removed old pin ${entry.name}`);
		}
	}
	console.log(`Wrote ${path.relative(ROOT, PIN_FILE)}`);
	await setOutput(current?.clientVersionUpload !== target.clientVersionUpload);
}

async function placeFile(src, dst) {
	await mkdir(path.dirname(dst), { recursive: true });
	await rm(dst, { force: true });
	try {
		await link(src, dst);
	} catch {
		await copyFile(src, dst);
	}
}

async function runPool(items, limit, worker) {
	let next = 0;
	const errors = [];
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++];
			try {
				await worker(item);
			} catch (err) {
				errors.push([item, err]);
			}
		}
	});
	await Promise.all(runners);
	return errors;
}

async function cmdFetch(args) {
	const pin = await readPin();
	if (!pin) throw new Error("engine/pin.json is missing; run `npm run engine:pin` first.");
	const base = pin.cdnBase || cdnBase(pin.clientVersionUpload);
	const cache = path.join(CACHE_DIR, pin.clientVersionUpload);
	const concurrency = Number(args.concurrency) || 16;

	// Core files, verified against the pin.
	for (const name of CORE_FILES) {
		const file = path.join(cache, name);
		const want = pin.core?.[name];
		if (want && (await exists(file)) && (await stat(file)).size === want.size && (await sha256File(file)) === want.sha256) continue;
		const got = await download(base + name, file);
		if (want && (got.size !== want.size || got.sha256 !== want.sha256)) {
			throw new Error(`${name} does not match the pin (size ${got.size} vs ${want.size}); the CDN copy changed.`);
		}
	}

	const index = parseFsIndex(await readFile(path.join(cache, "WebClient.fsindex.txt")));
	let done = 0;
	let bytes = 0;
	const todo = [];
	for (const f of index) {
		const rel = safeRelPath(f.path);
		if (!rel) throw new Error(`Unsafe path in fsindex: ${JSON.stringify(f.path)}`);
		const file = path.join(cache, rel);
		if ((await exists(file)) && (await stat(file)).size === f.size) continue;
		todo.push({ ...f, rel, file });
	}
	console.log(`${pin.clientVersionUpload}: ${index.length - todo.length}/${index.length} content files cached, fetching ${todo.length}`);
	const errors = await runPool(todo, concurrency, async (f) => {
		const got = await download(base + encodePath(f.rel), f.file);
		if (got.size !== f.size) throw new Error(`size mismatch for ${f.path}: ${got.size} != ${f.size}`);
		done++;
		bytes += got.size;
		if (done % 250 === 0 || done === todo.length) {
			console.log(`  ${done}/${todo.length} (${(bytes / 1048576).toFixed(1)} MB)`);
		}
	});
	if (errors.length) {
		for (const [f, err] of errors.slice(0, 10)) console.error(`  failed ${f.path}: ${err.message}`);
		throw new Error(`${errors.length} content files failed to download`);
	}

	if (typeof args.dest === "string") {
		const dest = path.resolve(args.dest);
		console.log(`Copying engine into ${path.relative(ROOT, dest) || dest}`);
		for (const name of CORE_FILES) await placeFile(path.join(cache, name), path.join(dest, name));
		await runPool(index, 32, async (f) => {
			const rel = safeRelPath(f.path);
			await placeFile(path.join(cache, rel), path.join(dest, rel));
		});
	}
	console.log("Engine ready.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0] || "latest";
	const run = { latest: cmdLatest, pin: cmdPin, fetch: cmdFetch }[cmd];
	if (!run) {
		console.error(`Unknown command "${cmd}". Use latest | pin | fetch.`);
		process.exit(2);
	}
	run(args).catch((err) => {
		console.error(err?.stack || err);
		process.exit(1);
	});
}
