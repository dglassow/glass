# @glass/desktop — the macOS app

The native macOS shell around the shared Viewer frontend (`@glass/viewer`).
The UI inside it is the *same* viewer bundle the hub serves as a PWA; the shell
adds what a browser can't do: run the backend, launch a proxied local browser,
native menus, and signed auto-update.

## Status: shipping

`pnpm tauri build` produces a self-contained **Glass.app / Glass.dmg** that
runs on a Mac with no node, no repo, and no setup: the backend (hub + sessiond
+ agent) and a portable node binary are bundled into the app's Resources.
First launch shows a role picker — **Standalone** (everything local),
**Hub** (this Mac anchors the fleet), or **Spoke** (join a hub by url + pin,
with number-match enrollment). Updates arrive via the Tauri v2 updater from
the hub's `/updates` endpoint — minisign-signed, notarized, with a device-side
anti-rollback floor (`viewer/src/update-policy.ts`).

This directory stays **excluded from the pnpm workspace** because building it
needs a Rust toolchain; build on a Mac as below.

### Native bridge commands

Registered in `src-tauri/src/main.rs` behind the Tauri v2 ACL
(`capabilities/default.json`), reached from the viewer via
`packages/viewer/src/native.ts` (which throws a clear "desktop only" error in
a plain browser):

| Command | Does |
|---|---|
| `start_backend` / `stop_backend` / `backend_status` | Spawn and supervise `deploy/glass-backend.mjs` for the chosen role (kills any stale backend first; SIGTERM teardown on window close and app exit so no orphaned node processes). Resolves the dev repo when present, else the bundled backend + its portable node. Sets a real `PATH` for the whole backend tree — GUI-launched apps inherit almost none. |
| `launch_proxied_browser` | Spawns the local browser (Chrome by default, or chromium/brave/edge) detached with the exact flag set from `agent/src/proxy/browser-profile.ts`: isolated `--user-data-dir`, `--proxy-server=socks5://<host>:<port>`, no-first-run. `socks5` (not `socks5h`) is deliberate — Chromium sends hostnames to the proxy, so DNS also resolves at the exit device. |
| `app_version` | The version from `tauri.conf.json` (`package_info()`, **not** `CARGO_PKG_VERSION` — the stale cargo value once poisoned the updater's anti-rollback reconcile). |

## Building on a Mac

```bash
# one-time: Rust toolchain (the Tauri CLI comes from pnpm)
curl https://sh.rustup.rs -sSf | sh

cd packages/desktop && pnpm install

# 1. bundle the backend (pnpm-deploys hub/sessiond/agent flat, plus a portable
#    official node binary, into src-tauri/backend/ — gitignored, regenerated):
./bundle-backend.sh

# 2. release build (also runs the viewer's Vite build via beforeBuildCommand):
pnpm tauri build          # → Glass.app + Glass_<version>_aarch64.dmg

# 3. sign + notarize + staple for distribution to other Macs:
./sign-and-notarize.sh

# dev loop instead: Vite dev server + the native window
pnpm tauri dev
```

Notes that matter:

- **`bundle-backend.sh`** uses `pnpm deploy --node-linker=hoisted` (flat real
  files — `.pnpm` symlinks break when Tauri copies resources) and prunes
  node-pty prebuilds to darwin-arm64. The bundled node links only /System and
  /usr/lib, so it runs anywhere.
- **`sign-and-notarize.sh`** deep-signs inside-out (node-pty native addon and
  spawn-helper, then the bundled node with the JIT/library entitlements from
  `entitlements.plist`, then the app), notarizes app + dmg via the
  `glass-notary` notarytool Keychain profile, and staples both. The signing
  identity is auto-detected from the Keychain (or `APPLE_SIGNING_IDENTITY`) —
  nothing account-specific is committed. Mac App Store is a non-starter (App
  Sandbox forbids spawning node/shells); this is Developer ID direct
  distribution, per `docs/plan.md` §15.
- **`GLASS_HOME`** (dev only): the app finds the repo via runtime env → value
  baked at build time (`GLASS_HOME=… pnpm tauri build`) → `~/Projects/glass`,
  each validated to contain `deploy/glass-backend.mjs`. The released app needs
  none of this — it uses the bundled backend (`GLASS_PREFER_BUNDLED=1` forces
  that path for testing).
- `tauri.conf.json` enables `macOSPrivateApi` (transparent window for the
  terminal-appearance settings) — the matching `macos-private-api` cargo
  feature must stay on or the window silently falls back to opaque.
- The updater endpoint in `tauri.conf.json` is a public hostname, baked in
  deliberately so updates work with zero config — it serves only signed
  artifacts.

## Left to do

- Later native bridge commands: launchd management, Keychain / Secure Enclave
  key storage (the `Signer` seam in the viewer is where it plugs in).
