// Records what happens to WebTransport connections (the engine's game traffic) so a failed join
// can be diagnosed. Installed in the player page by boot.js and, by the player's service worker,
// at the top of WebClient.js for the engine's worker threads. Reports go out on the
// "webblox:diag" BroadcastChannel; nothing leaves the browser.
//
// This function is stringified and injected into workers, so it must not refer to anything
// outside its own body.
export function installWebTransportDiag(scope) {
	if (typeof scope.WebTransport !== "function" || scope.WebTransport.__webbloxDiag) return;
	const Native = scope.WebTransport;
	const channel = new scope.BroadcastChannel("webblox:diag");
	const where = typeof scope.document === "undefined" ? scope.name || "worker" : "page";
	const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
	// The first DNS label carries a per-join token; keep only its first characters.
	const mask = (u) => {
		try {
			const url = new URL(u);
			const labels = url.hostname.split(".");
			labels[0] = labels[0].replace(/^([0-9a-z]{4})[0-9a-z]*/i, "$1…");
			return `${url.protocol}//${labels.join(".")}${url.port ? `:${url.port}` : ""} (path ${url.pathname.length} chars)`;
		} catch {
			return String(u).slice(0, 12) + "…";
		}
	};
	const describe = (e) => (e ? `${e.name || "Error"}: ${e.message || e}${e.source ? ` [source ${e.source}]` : ""}${Number.isInteger(e.streamErrorCode) ? ` [stream error ${e.streamErrorCode}]` : ""}` : "unknown");
	const report = (kind, data) => {
		try {
			channel.postMessage({ kind, where, at: Date.now(), ...data });
		} catch {
			// diagnostics must never break the engine
		}
	};
	class DiagWebTransport extends Native {
		constructor(url, options) {
			const t0 = now();
			const info = { url: mask(url), certHashes: options?.serverCertificateHashes?.length || 0 };
			report("wt-open", info);
			super(url, options);
			this.ready.then(
				() => report("wt-ready", { ...info, ms: Math.round(now() - t0) }),
				(e) => report("wt-fail", { ...info, ms: Math.round(now() - t0), error: describe(e) }),
			);
			this.closed.then(
				(c) => report("wt-closed", { ...info, ms: Math.round(now() - t0), closeCode: c?.closeCode ?? null, reason: c?.reason || "" }),
				(e) => report("wt-closed", { ...info, ms: Math.round(now() - t0), error: describe(e) }),
			);
		}
	}
	DiagWebTransport.__webbloxDiag = true;
	scope.WebTransport = DiagWebTransport;
}
