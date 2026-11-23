// The webblox cookie jar, persisted in IndexedDB so the launcher (a page) and the player's
// network bridge (a worker, which has no localStorage) share one session.

import { CookieJar } from "./cookiejar.js";
import { KV } from "./idb.js";

const kv = new KV();
const STATE_KEY = "cookies";
const CHANNEL = "webblox:cookies";

export async function readJarState() {
	try {
		const state = await kv.get(STATE_KEY);
		if (state && Array.isArray(state.cookies)) return { cookies: state.cookies, meta: state.meta || {}, savedAt: state.savedAt || 0 };
	} catch (err) {
		console.warn("[webblox] could not read the cookie jar:", err);
	}
	return { cookies: [], meta: {}, savedAt: 0 };
}

export class PersistentJar extends CookieJar {
	static async open() {
		const state = await readJarState();
		const jar = new PersistentJar(state.cookies);
		jar.meta = state.meta;
		jar.savedAt = state.savedAt;
		jar.listen();
		return jar;
	}

	listen() {
		this.channel = new BroadcastChannel(CHANNEL);
		this.channel.onmessage = async (e) => {
			if (!e.data || e.data.savedAt <= this.savedAt) return;
			const state = await readJarState();
			if (state.savedAt <= this.savedAt) return;
			this.cookies.clear();
			for (const c of state.cookies) this.set(c);
			this.meta = state.meta;
			this.savedAt = state.savedAt;
			this.onchange?.();
		};
	}

	// Writes are coalesced: a burst of responses with Set-Cookie becomes one write.
	save() {
		clearTimeout(this.saveTimer);
		return new Promise((resolve) => {
			this.saveTimer = setTimeout(() => this.saveNow().then(resolve, resolve), 100);
		});
	}

	async saveNow() {
		clearTimeout(this.saveTimer);
		const savedAt = Math.max(Date.now(), (this.savedAt || 0) + 1);
		try {
			await kv.set(STATE_KEY, { cookies: this.toJSON(), meta: this.meta || {}, savedAt });
			this.savedAt = savedAt;
			this.channel?.postMessage({ savedAt });
		} catch (err) {
			console.warn("[webblox] could not save the cookie jar:", err);
		}
	}
}
