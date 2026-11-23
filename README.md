# webblox

Roblox in the browser, as a static GitHub Pages site. webblox hosts Roblox's own browser
client: the `WebClientApp` binary type, an Emscripten build that Roblox ships to its CDN. It adds
the pieces Roblox's site normally provides: a host page, cross-origin isolation, networking
over Wisp, a sign-in browser and a game launcher.

Nothing runs on a server you operate. The site is plain static files. Roblox traffic is
tunnelled through a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) server, with TLS
terminated in your browser by [epoxy](https://github.com/MercuryWorkshop/epoxy-tls).

## Deploying to GitHub Pages

1. In the repository settings, open **Pages** and set **Source** to **GitHub Actions**.
2. Push to `main` (or run the **Deploy to GitHub Pages** workflow by hand).

The workflow runs the tests, downloads the pinned engine from Roblox's CDN into the Pages
artifact, and deploys. Every day it also checks for a newer `WebClientApp` build. When there is
one, it pins it, commits the new pin and flags to `engine/`, and redeploys.

| Setting | Where | Default |
| --- | --- | --- |
| Engine source: `local` copies the engine (≈230 MB) into the site; `cdn` streams it from Roblox's CDN at play time | repository variable `WEBBLOX_ENGINE`, or the workflow's `engine` input | `local` |
| Wisp server | in the app: Settings | `wss://wisp.mercurywork.shop/` |
| Game connection: direct, through the Wisp server, or automatic (direct, falling back to Wisp) | in the app: Settings | automatic |
| Renderer (WebGPU / WebGL 2) | in the app: Settings | automatic |

## Using it

1. **Sign in.** Joining a game needs a Roblox session; without one, Roblox answers with error 524
   "Not authorized". *Sign in* offers three ways in:
   - **Quick sign-in** (recommended): Roblox's own Quick Log In. webblox shows a code (and QR
     code); approve it at roblox.com/crossdevicelogin/confirmcode, or in the Roblox app under
     Settings → Quick Log In, on a device where you're signed in. No password or CAPTCHA.
   - **Cookie**: paste a `.ROBLOSECURITY` value. webblox checks it with Roblox before saving it,
     keeps it in this browser, and only ever sends it to roblox.com. Signing out of webblox
     forgets it but leaves the browser you copied it from signed in.
   - **roblox.com**: the normal login page inside a Scramjet 2 browser. Its verification steps can
     be slow or loop behind the proxy, which is why the other two exist.
2. **Find a game.** Search, or paste a game link, a `roblox://` or `roblox-player:` link, a share
   link, or a place id. The details sheet lists public servers if you want a specific one.
3. **Play.** The player opens in its own tab. It has to be a top-level page, because the engine
   needs cross-origin isolation.

Pressing Play (or Join on a friend) on roblox.com inside the sign-in browser also works. The
launch is caught and opened in the player instead of the desktop app.

Requirements: a current Chrome or Edge (other browsers are untested). The browser needs
WebAssembly threads, WebTransport, and WebGPU with BC/ETC2 texture compression or WebGL 2. Only
one game tab can run at a time. Private servers are not supported yet.

### On networks that block Roblox

Everything except the game itself (sign-in, search, joining, assets) always goes through the Wisp
server. The game connection is WebTransport (QUIC over UDP) to `*.qdmux.roblox.com`. Settings →
*Game connection* decides how it travels:

- **Automatic** (default): straight to Roblox. If that fails, or hasn't connected after 3 seconds,
  it goes through the Wisp server instead, and later connections in that tab go through Wisp
  straight away.
- **Direct to Roblox**: never through Wisp, as before.
- **Always through the Wisp server**: for networks where the direct connection never works.

Through Wisp, the browser runs its own QUIC client and sends the game's UDP packets over a Wisp
UDP stream. That needs a Wisp server that allows UDP. Many public servers turn it off, so run your
own (for example `pip install wisp-python`, then `python3 -m wisp.server`) somewhere that can
reach Roblox, and enter its address in Settings. The Wisp server only relays encrypted packets:
TLS runs in your browser, and the game server's certificate is checked the way the browser would
check it. The game is only as fast as the route through the Wisp server, and packets ride a
WebSocket (TCP), so a lossy link adds more lag than a direct connection would. The diagnostics
under a failed join show which route each connection took.

## How it works

```
launcher (index.html) ─search/details─▶ Wisp ─TLS (epoxy)─▶ *.roblox.com
      │ opens tab
      ▼
player/ (index.html + boot.js)            player/sw.js (scope player/)
  WasmPlayer.js ─▶ WebClient.js/.wasm ──▶   • adds COOP/COEP to every response → crossOriginIsolated
  engine pthreads (em-pthread workers)      • engine/<version>/* from the site (or Roblox's CDN), cached per version
        │ fetch/XHR to *.roblox.com ──────▶ • Roblox requests → MessagePort → net.worker.js
        │                                                                       │
        │                                                        cookie jar, CSRF, request fixes
        │                                                        └─▶ Wisp ─TLS (epoxy)─▶ *.roblox.com
        │ WebTransport (game): wt-shim.js decides the route
        ├─ direct ─▶ browser WebTransport ─▶ *.qdmux.roblox.com
        └─ Wisp ─▶ BroadcastChannel ─▶ tunnel.worker.js: QUIC + TLS 1.3 + HTTP/3 in JS
                                         └─▶ Wisp UDP stream (own WebSocket) ─▶ *.qdmux.roblox.com
```

- **Engine.** `scripts/vendor-engine.mjs pin` reads the current version from
  `clientsettings.roblox.com/v2/client-version/WebClientApp`. It snapshots the flag sets
  (`WebClientApp` plus the platform variants `WasmPlayer.js` asks for) into
  `engine/<version>/flags/`. Pinned flags are served to the engine instead of live ones, so a flag
  push cannot break an older engine. `fetch` downloads the core files and every file listed in
  `WebClient.fsindex.txt` (Roblox's prefix-compressed asset index, which replaced
  `WebClient.metadata.json`) from `setup.rbxcdn.com/webclient/<version>-RobloxWebClient/`.
  Roblox's files are never committed. `WebClient.wasm` is deployed in 32 MiB parts, which the
  service worker joins back together.
- **Host page.** `player/index.html` provides the element ids `WasmPlayer.js` looks up (canvas,
  text inputs, loading screen). `boot.js` replaces Roblox's `WasmLoader.js`/`stub.js`: it sets
  `window.__wasmLoaderContext = { engineBase, channel: null, server: "prod" }` and loads
  `WasmPlayer.js` from the same origin, so no worker stub is needed. Leaving a game returns to the
  launcher instead of closing the tab.
- **Networking.** The service worker catches the engine's requests to `*.roblox.com` and
  `*.rbxcdn.com`, from the page and from its workers, and hands them to `net.worker.js`. That
  worker sends them over Wisp, so a busy main thread never stalls network I/O. Synthetic responses
  carry CORP `cross-origin` and CORS headers that list every response header, so the engine can
  read `x-csrf-token`.
- **Join fixes** (`src/js/lib/robloxnet.js`):
  - Game joins go out first with the engine's own web-client identity (`Roblox/Web …`), so Roblox can
    fill in `joinScript.gameFqdn` itself. If Roblox refuses that, or the result has no usable
    address, the join is repeated as the macOS client (`rbx-user-agent: Roblox/Darwin`), and whichever
    worked is kept for the session. Other `Roblox/Web …` user agents become `Roblox/WinInet`.
  - A missing `joinScript.gameFqdn` is rebuilt as
    `<netstack token>-<MachineAddress>-<NetStackPort>.<UdmuxEndpoints[0] address, last octet +1>.qdmux.roblox.com`.
    Each part is the lowercase hex of its raw bytes, the way the engine's own generator writes it:
    32 digits for the 16-byte token, 8 for each IPv4 address (so `10.37.2.74` is `0a25024a`), and 4
    for the port.
  - To join a specific server, `/v1/join-game` becomes `/v1/join-game-instance` with `gameId`.
- **Session.** Scramjet 2's controller keeps its cookie jar in IndexedDB (`__scramjet_controller`,
  store `state`, key `cookies`). The player copies the roblox.com cookies, including
  `.ROBLOSECURITY`, into webblox's own jar whenever that jar is newer. webblox's jar lives in
  IndexedDB rather than localStorage, because the network worker can't use localStorage.
- **Game connection** (`src/js/lib/wt-shim.js`, `src/player/tunnel.worker.js`, `src/js/lib/quic/`).
  The service worker puts a WebTransport stand-in in front of `WebClient.js` in every engine
  thread, and `boot.js` installs it in the page. It routes each connection by the setting. The
  direct route hands over the browser's own WebTransport untouched. The Wisp route runs in the
  tunnel worker:
  - a QUIC v1 client (RFC 9000/9001/9002, with loss recovery, flow and congestion control, Retry
    and key updates);
  - TLS 1.3 on Web Crypto (X25519 or P-256, AES-128-GCM);
  - HTTP/3 with the WebTransport extended CONNECT.

  The packets travel over a Wisp UDP stream (Wisp v1 or v2) on a WebSocket of its own, so they
  never queue behind asset downloads. The server certificate is checked like Chromium checks it.
  When the engine passes `serverCertificateHashes`, the certificate must match one of the hashes.
  Otherwise the chain must verify for the host name against Mozilla's root store, which the build
  copies from Node's bundled roots. Either way the server has to prove it holds the key. The
  engine sees the standard WebTransport API either way.
- **Launch catching** (`src/js/lib/launch-plugin.js`). A Scramjet frame plugin catches four kinds of
  launch: `roblox-player:`/`roblox://` set as an iframe `src` (property or `setAttribute`),
  passed to `window.open`, or used as a link; and `/games/start?placeId=` reached by link,
  `window.open` or navigation. Follow-user launches carry a user id, which the player resolves
  through `presence.roblox.com`.

## Development

```bash
npm ci
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run serve -- --base /ro26/
```

`npm run build` downloads the pinned engine into `.cache/` on first use. Pass `-- --engine cdn` to
skip that, or `-- --engine none` for UI-only work. To pin the newest Roblox build, run
`npm run engine:pin`. Browsers allow service workers on `http://localhost`, so the served site
works locally as long as the Wisp server in Settings is reachable.

## Notes

- Roblox's client, assets and services belong to Roblox Corporation. This project is not
  affiliated with Roblox. Use of Roblox services is subject to Roblox's Terms of Use.
- The bundled Scramjet and epoxy are licensed AGPL-3.0.
