# @glass/desktop — Tauri shell (scaffold)

The native macOS shell around the shared Viewer frontend (`@glass/viewer`). It
gives the web UI the things a browser can't do: spawning local Chromium with
proxy flags, launchd management, and Keychain access (plan §2, §5). The UI
inside it is the *same* `@glass/viewer` bundle the PWA will serve.

## Status: scaffold, not built here

This directory is **excluded from the pnpm workspace** on purpose — building it
needs a Rust toolchain and the Tauri CLI, and running it needs a display,
neither of which exists in the headless environment where the rest of Glass was
built and tested. The backend (`hub`/`agent`/`sessiond`) and the Viewer's data
layer *are* verified (see `tests/`); this shell is wiring that a developer
completes and runs on a Mac.

## Running it on a Mac

```bash
# one-time: Rust + the Tauri CLI
curl https://sh.rustup.rs -sSf | sh
cd packages/desktop && pnpm install       # pulls @tauri-apps/cli

# dev: launches the Vite dev server and the native window
pnpm tauri dev

# release build (needs app icons added under src-tauri/icons/ first)
pnpm tauri build
```

`tauri.conf.json` points `frontendDist` at `../../viewer/dist-web` (the Vite
output) and `devUrl` at the Vite dev server. The Viewer reads its hub URL from
`?hub=` / localStorage today; Phase 2 enrollment replaces that with real
per-device config that never lives in this public repo.

## Left to do before this runs

- Add app icons under `src-tauri/icons/` (Tauri needs them to bundle).
- Confirm the identifier (`com.glassow.glass`) and signing settings against the
  Developer ID cert in `docs/plan.md` §15.
- Native bridge commands (local browser launch, Keychain) — later phases.
