// A small RFC 6265 cookie jar. The player talks to *.roblox.com through Wisp, so the
// browser never sees those cookies; this jar stands in for the browser's.

const now = () => Date.now();

function parseExpires(value) {
	const t = Date.parse(value);
	return Number.isFinite(t) ? t : null;
}

function defaultPath(url) {
	const p = url.pathname || "/";
	if (!p.startsWith("/")) return "/";
	const i = p.lastIndexOf("/");
	return i <= 0 ? "/" : p.slice(0, i);
}

export function domainMatches(host, domain) {
	return host === domain || (host.endsWith(`.${domain}`) && !/^\d+\.\d+\.\d+\.\d+$/.test(host));
}

export function pathMatches(reqPath, cookiePath) {
	if (reqPath === cookiePath) return true;
	if (!reqPath.startsWith(cookiePath)) return false;
	return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

// Parses one Set-Cookie header value. Returns null for values a browser would ignore.
export function parseSetCookie(header, url) {
	const parts = String(header).split(";");
	const pair = parts.shift();
	const eq = pair.indexOf("=");
	if (eq < 0) return null;
	const name = pair.slice(0, eq).trim();
	const value = pair.slice(eq + 1).trim();
	if (!name) return null;

	const host = url.hostname.toLowerCase();
	const cookie = {
		name,
		value,
		domain: host,
		hostOnly: true,
		path: defaultPath(url),
		expires: null,
		secure: false,
		httpOnly: false,
		sameSite: "lax",
		created: now(),
	};
	let maxAge = null;
	for (const raw of parts) {
		const i = raw.indexOf("=");
		const key = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
		const val = i < 0 ? "" : raw.slice(i + 1).trim();
		switch (key) {
			case "expires": {
				const t = parseExpires(val);
				if (t !== null) cookie.expires = t;
				break;
			}
			case "max-age":
				if (/^-?\d+$/.test(val)) maxAge = Number(val);
				break;
			case "domain": {
				const d = val.replace(/^\./, "").toLowerCase();
				if (!d) break;
				// A cookie may only be set for the request host or one of its parents,
				// and never for a bare TLD.
				if (!domainMatches(host, d) || !d.includes(".")) return null;
				cookie.domain = d;
				cookie.hostOnly = false;
				break;
			}
			case "path":
				if (val.startsWith("/")) cookie.path = val;
				break;
			case "secure":
				cookie.secure = true;
				break;
			case "httponly":
				cookie.httpOnly = true;
				break;
			case "samesite":
				cookie.sameSite = val.toLowerCase() || "lax";
				break;
		}
	}
	if (maxAge !== null) cookie.expires = maxAge <= 0 ? 0 : now() + maxAge * 1000;
	return cookie;
}

const keyOf = (c) => `${c.domain}|${c.path}|${c.name}`;
const isExpired = (c, t = now()) => c.expires !== null && c.expires !== undefined && c.expires <= t;

export class CookieJar {
	constructor(cookies = []) {
		this.cookies = new Map();
		for (const c of cookies) if (c && c.name && c.domain && !isExpired(c)) this.cookies.set(keyOf(c), { ...c });
	}

	// Stores every Set-Cookie value from a response. Returns true when the jar changed.
	setCookies(headers, url) {
		let changed = false;
		for (const h of headers) {
			const c = parseSetCookie(h, url);
			if (!c) continue;
			const key = keyOf(c);
			const old = this.cookies.get(key);
			if (isExpired(c)) {
				if (old) {
					this.cookies.delete(key);
					changed = true;
				}
				continue;
			}
			if (old) c.created = old.created;
			if (!old || old.value !== c.value || old.expires !== c.expires) changed = true;
			this.cookies.set(key, c);
		}
		return changed;
	}

	set(cookie) {
		this.cookies.set(keyOf(cookie), { created: now(), hostOnly: false, path: "/", expires: null, secure: true, httpOnly: true, sameSite: "lax", ...cookie });
	}

	matching(url) {
		const host = url.hostname.toLowerCase();
		const path = url.pathname || "/";
		const secure = url.protocol === "https:" || url.protocol === "wss:";
		const t = now();
		const out = [];
		for (const [key, c] of this.cookies) {
			if (isExpired(c, t)) {
				this.cookies.delete(key);
				continue;
			}
			if (c.hostOnly ? host !== c.domain : !domainMatches(host, c.domain)) continue;
			if (!pathMatches(path, c.path)) continue;
			if (c.secure && !secure) continue;
			out.push(c);
		}
		// Longer paths first, then older cookies first (RFC 6265 section 5.4).
		out.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
		return out;
	}

	cookieHeader(url) {
		return this.matching(url)
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");
	}

	get(name, url) {
		return this.matching(url).find((c) => c.name === name) || null;
	}

	removeWhere(pred) {
		let changed = false;
		for (const [key, c] of this.cookies) {
			if (pred(c)) {
				this.cookies.delete(key);
				changed = true;
			}
		}
		return changed;
	}

	replaceWhere(pred, cookies) {
		this.removeWhere(pred);
		for (const c of cookies) if (!isExpired(c)) this.cookies.set(keyOf(c), { created: now(), ...c });
	}

	toJSON() {
		const t = now();
		return [...this.cookies.values()].filter((c) => !isExpired(c, t));
	}
}

export const isRobloxCookieDomain = (domain) => /(^|\.)roblox\.com$/i.test(String(domain).replace(/^\./, ""));
