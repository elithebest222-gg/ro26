#!/usr/bin/env node
// Serves _site/ like GitHub Pages does: plain static files, no special headers (the player's
// service worker adds COOP/COEP itself), optionally under a project-site base path.
//
//   node scripts/serve.mjs [--port 8080] [--base /ro26/] [--dir _site]

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(arg("port", process.env.PORT || 8080));
const BASE = `/${arg("base", "/").replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
const DIR = path.resolve(ROOT, arg("dir", "_site"));

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (!url.pathname.startsWith(BASE)) {
		res.writeHead(302, { location: BASE }).end();
		return;
	}
	let rel;
	try {
		rel = decodeURIComponent(url.pathname.slice(BASE.length));
	} catch {
		res.writeHead(400).end();
		return;
	}
	let file = path.join(DIR, rel);
	if (!file.startsWith(DIR)) {
		res.writeHead(403).end();
		return;
	}
	try {
		let s = await stat(file);
		if (s.isDirectory()) {
			if (!url.pathname.endsWith("/")) {
				res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
				return;
			}
			file = path.join(file, "index.html");
			s = await stat(file);
		}
		res.writeHead(200, {
			"content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
			"content-length": s.size,
			"cache-control": "max-age=600",
		});
		if (req.method === "HEAD") res.end();
		else createReadStream(file).pipe(res);
	} catch {
		res.writeHead(404, { "content-type": "text/plain" }).end("404");
	}
});

server.listen(PORT, () => console.log(`Serving ${path.relative(ROOT, DIR)}/ at http://localhost:${PORT}${BASE}`));
