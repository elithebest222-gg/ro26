// Scramjet frame plugin: when roblox.com (inside the sign-in browser) tries to launch the
// desktop app, open the webblox player instead. roblox.com launches by
//   - roblox-player: / roblox:// URIs set as a hidden iframe's src (property or setAttribute),
//     passed to window.open, or used as a link
//   - /games/start?placeId=… by link, window.open or top-level navigation
// The DOM routes are patched in every proxied window; /games/start navigations are answered
// by the fetch "intercept" hook before they reach the network.

import { parseLaunchAttempt } from "./links.js";

const LAUNCH_PAGE = `<!doctype html><meta charset="utf-8"><title>Opening in webblox</title>
<style>body{margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui,sans-serif;background:#0b0d12;color:#e8ebf1}
div{text-align:center;padding:24px}button{margin-top:14px;padding:8px 16px;border:0;border-radius:9px;background:#4f8cff;color:#fff;font:inherit;font-weight:600;cursor:pointer}</style>
<div><p><strong>Opening the game in the webblox player…</strong></p><p>It starts in its own tab.</p><button onclick="history.back()">Back</button></div>`;

function isLaunchNavigation(parsed) {
	const dest = parsed?.destination;
	return dest === "document" || dest === "iframe" || dest === "frame";
}

export function createLaunchPlugin(ManagedPlugin, ScramjetHeaders, onLaunch) {
	let last = { key: "", at: 0 };
	// The same launch often arrives twice (link click, then the page's own script); fire once.
	const fire = (intent) => {
		const key = JSON.stringify(intent);
		if (key === last.key && Date.now() - last.at < 4000) return;
		last = { key, at: Date.now() };
		onLaunch(intent);
	};
	const check = (value) => {
		if (value === undefined || value === null) return false;
		const intent = parseLaunchAttempt(String(value));
		if (!intent) return false;
		fire(intent);
		return true;
	};

	function patchWindow(win, client) {
		const unrewrite = (u) => {
			try {
				return client.unrewriteUrl(u);
			} catch {
				return u;
			}
		};

		// iframe.src = "roblox-player:…"
		try {
			const proto = win.HTMLIFrameElement.prototype;
			const desc = Object.getOwnPropertyDescriptor(proto, "src");
			if (desc?.set && desc.configurable) {
				Object.defineProperty(proto, "src", {
					...desc,
					set(value) {
						if (check(value)) return;
						desc.set.call(this, value);
					},
				});
			}
		} catch (err) {
			console.warn("[webblox] could not hook iframe.src", err);
		}

		// iframe.setAttribute("src", "roblox-player:…")
		try {
			const setAttribute = win.Element.prototype.setAttribute;
			win.Element.prototype.setAttribute = function (name, value) {
				if (this instanceof win.HTMLIFrameElement && String(name).toLowerCase() === "src" && check(value)) return;
				return setAttribute.call(this, name, value);
			};
		} catch (err) {
			console.warn("[webblox] could not hook setAttribute", err);
		}

		// window.open("roblox://…") / window.open("/games/start?placeId=…")
		try {
			const open = win.open;
			win.open = function (url, ...rest) {
				if (url !== undefined && url !== null) {
					let abs = String(url);
					try {
						abs = new URL(abs, client.url.href).href;
					} catch {
						// keep as is (custom schemes)
					}
					if (check(abs)) return null;
				}
				return open.call(this, url, ...rest);
			};
		} catch (err) {
			console.warn("[webblox] could not hook window.open", err);
		}

		// <a href="roblox://…"> and <a href="/games/start?…">
		win.addEventListener(
			"click",
			(e) => {
				const a = e.target?.closest?.("a[href]");
				if (!a) return;
				const href = a.href || unrewrite(a.getAttribute("href"));
				if (check(href) || check(unrewrite(href))) {
					e.preventDefault();
					e.stopImmediatePropagation();
				}
			},
			true,
		);

		// Frames inserted as markup never go through the setters above.
		try {
			new win.MutationObserver((records) => {
				for (const r of records) {
					const nodes = r.type === "attributes" ? [r.target] : [...r.addedNodes];
					for (const n of nodes) {
						if (n instanceof win.HTMLIFrameElement) {
							const src = n.getAttribute("src");
							if (src && /^roblox(-player)?:/i.test(src) && check(src)) n.remove();
						}
					}
				}
			}).observe(win.document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
		} catch {
			// document not ready; the setters above still apply
		}
	}

	class LaunchPlugin extends ManagedPlugin {
		constructor() {
			super("webblox-launch", []);
		}

		install(frame) {
			super.install(frame);
			this.tap(frame.hooks.init.post, ({ window: win, client }) => {
				patchWindow(win, client);
				// location = "roblox://…" cannot be cancelled here, but still open the player.
				this.tap(client.hooks.lifecycle.navigate, (_ctx, props) => {
					if (/^roblox(-player)?:/i.test(props?.url || "")) check(props.url);
				});
			});
			this.tap(frame.hooks.fetch.intercept, ({ parsed }, props) => {
				if (!isLaunchNavigation(parsed)) return;
				if (!check(parsed.url?.href)) return;
				props.response = {
					status: 200,
					statusText: "OK",
					headers: ScramjetHeaders.fromRawHeaders([["content-type", "text/html; charset=utf-8"]]),
					body: LAUNCH_PAGE,
				};
			});
		}
	}

	return new LaunchPlugin();
}
