# @glass/desktop — Tauri shell

The native macOS shell around the shared Viewer frontend (`@glass/viewer`). It
gives the web UI the things a browser can't do (plan §2, §5) — starting with
the one capability the desktop uniquely needs now: **launching the local
browser through a SOCKS proxy with an isolated profile** (plan §7, Phase 6 —
you render locally, egress from the chosen device). The UI inside it is the
*same* `@glass/viewer` bundle the PWA will serve.

## Status: buildable

The shell is real, not a scaffold: `src-tauri/src/main.rs` registers two
commands behind the Tauri v2 ACL (`capabilities/default.json`), and the viewer
reaches them through `packages/viewer/src/native.ts`. This directory stays
**excluded from the pnpm workspace** because building it needs a Rust
toolchain and running it needs a display; build it on a Mac as below.

### Native bridge commands

| Command | Does |
|---|---|
| `launch_proxied_browser` | Spawns the local browser (Chrome by default, or chromium/brave/edge at their macOS paths) detached, with the exact flag set from `packages/agent/src/proxy/browser-profile.ts`: `--user-data-dir=<profileDir>`, `--proxy-server=socks5://<host>:<port>`, `--no-first-run`, `--no-default-browser-check`, `--new-window`, then the optional URL. `socks5` (not `socks5h`) is deliberate — Chromium sends hostnames to the proxy, so DNS also resolves at the exit device. |
| `app_version` | Returns the shell's Cargo package version. |

The viewer calls these via `native.ts` (`isNative()`, `launchProxiedBrowser()`,
`appVersion()`), which uses the injected `window.__TAURI__` global
(`withGlobalTauri` is enabled in `tauri.conf.json`) and throws a clear
"desktop only" error when running as a plain web page.

## Building on a Mac

```bash
# one-time: Rust toolchain (pulls cargo; the Tauri CLI comes from pnpm)
curl https://sh.rustup.rs -sSf | sh

# 1. install the Tauri CLI for this package
cd packages/desktop && pnpm install

# 2. add app icons — Tauri needs them to bundle
#    (generates src-tauri/icons/ from a 1024x1024 source image)
pnpm tauri icon path/to/glass-icon.png

# 3. release build (also runs the viewer's Vite build via beforeBuildCommand)
pnpm tauri build

# dev loop instead: launches the Vite dev server and the native window
pnpm tauri dev
```

After adding icons, list them in `tauri.conf.json > bundle > icon`
(e.g. `["icons/icon.icns"]`) — `pnpm tauri icon` output matches those paths.

`tauri.conf.json` points `frontendDist` at `../../viewer/dist-web` (the Vite
output) and `devUrl` at the Vite dev server. The Viewer reads its hub URL from
`?hub=` / localStorage today; Phase 2 enrollment replaces that with real
per-device config that never lives in this public repo.

## Left to do

- Confirm the identifier (`com.glassow.glass`) and signing settings against the
  Developer ID cert in `docs/plan.md` §15.
- Later native bridge commands: launchd management, Keychain access.
