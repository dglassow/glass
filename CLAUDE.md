# Glass

A unified client for running terminal sessions across the owner's Macs, with a chat surface for mobile. One codebase, three roles: **Hub** (registry, auth, vault, relay), **Agent** (hosts sessions), **Viewer** (native Mac app, or chat-only PWA elsewhere).

Solo project, personal infrastructure. Ground-up rebuild — replaces Prism, supersedes Forge.

## Read first

- `docs/plan.md` — settled architecture and build phases. Authoritative.
- `docs/open-questions.md` — what's genuinely undecided. Everything not listed there is decided; don't reopen it without saying so explicitly.

## Current state

**Phase 0 complete. Phase 1 milestones 1–3 done (backend + viewer verified; native shell scaffolded).**

Done:
- Monorepo (pnpm workspaces), `@glass/protocol` with zod schemas, version negotiation, NDJSON framing, CI
- Process topology (`supervisor`, `sessiond`, `agent`, `hub`) with boundaries enforced by TS project references (only `protocol` is shared; `supervisor` deliberately can't import it)
- Phase 1 M1 local loop: `sessiond` owns PTYs over a Unix socket; `agent` relays over protocol envelopes; throwaway CLI client. `tests/m1-acceptance.mjs`: SIGKILL+restart of the worker leaves the shell alive with scrollback intact.
- Phase 1 M2 Hub loop: `hub` is a WebSocket registry+relay (verbatim router; binds `from` to the handshaked identity; explicit `device_unknown`/`device_unreachable`/`unauthorized` errors; evicts a stale registration on agent restart). `agent` gains `--hub` mode: the sole address-translation boundary, with two *soft* tables (pending request→viewer, attached sessionId→Set<viewer>), always `from=agentId` toward sessiond so its `conn.peer` can't flap; multi-viewer fan-out lives here. `tests/m2-acceptance.mjs` (18 checks): a viewer runs a shell on a named agent through the hub, survives an agent SIGKILL+restart with scrollback across the outage, plus cross-viewer isolation, from-spoof rejection, and no-false-`session.exited`. Only `supervisor` is still a skeleton.

- Phase 1 M3 Viewer: `@glass/viewer` is the shared web frontend. Its `hub-client.ts` is a DOM-free protocol client (connect, device.list, session create/attach/stream, and viewer-driven auto-reattach on the hub's `device.state` broadcast). The GUI is xterm.js terminal panes + a device/session sidebar (`main.ts`, `terminal-pane.ts`), a Vite app. `tests/m3-viewer.mjs` (11 checks) drives the *actual* built client against the real stack and proves auto-recovery: kill+restart the agent and the client re-attaches on its own with scrollback across the outage. `@glass/desktop` is a Tauri v2 scaffold wrapping the Viewer bundle — excluded from the pnpm workspace; needs Rust + a Mac to build (see its README).

Verification honesty: the backend (hub/agent/sessiond) and the Viewer's data layer are proven by `tests/` (38 checks, in CI). The xterm.js GUI compiles and bundles but is not interactively verified headlessly; the Tauri shell is a scaffold, not built here.

Protocol note: M2 added `roles` + `deviceName` to `Hello` (additive; v1 is unreleased so no N-1 concern) — the registry can't populate `DeviceRecord` without them. Self-asserted while auth is stubbed; Phase 2 enrollment makes them authoritative.

Scope: M1–M3 prove the load-bearing decision (PTYs survive a worker swap) end-to-end, through the hub, and into the viewer client. NOT yet covered: the Phase 4 blue/green `sessiond`→`sessiond` fd handoff (SCM_RIGHTS), the hub's own blue/green restart recovery, and running the GUI on real hardware ("from Studio, run a shell on Pro" — the last step is a human running the Tauri app on a Mac).

Next: close out Phase 1 by running the desktop app on a Mac, then Phase 2 (enrollment, keypairs, passkey login, relay).

Apple code signing is complete (`Developer ID Application: Daniel Glassow (Z6ATGC7GNB)`); the notarization API key is pending but blocks nothing until Phase 4.

## Hard constraints

Violating these breaks the architecture rather than just the code. If something seems to require it, stop and ask.

**Sessions never live in the worker.** PTY file descriptors belong to `sessiond`, which survives updates. The worker gets swapped blue/green constantly. This is the single load-bearing decision in the design — the entire no-interruption update story depends on it.

**`protocol/` is the only shared dependency.** `hub`, `agent`, and `viewer` must never import from each other. If they need to share something, it goes in `protocol/` or it doesn't exist.

**Protocol version rides on every envelope**, not just the handshake. A Hub mid-rollout holds connections from peers on two versions at once. The Hub speaks N-1; two versions behind is refused.

**This repository is public.** No secrets, no instance config, ever — no relay hostnames, tunnel keys, certificates, or device names. All of it lives in the encrypted backup bundle. If a value differs per install, it is configuration, not code.

**Browsers are not sessions.** They run locally and are optionally proxied over SOCKS. There is no browser session kind and no pixel streaming. Session kinds are `pty` and `chat`, full stop.

**The PWA is chat-only.** No terminal panes, no browser features. Terminal UI is macOS-native only. The web frontend is one shared codebase with different capability tiers, not two apps.

**Etch is detected, never managed.** It's a separate CLI the owner installs by hand. Report presence and version; never write install, update, or bundling logic for it.

**Tauri is desktop-only.** Mobile is PWA. Do not add Tauri mobile targets — app-store distribution is explicitly out of scope.

## Working agreements

- Small, focused commits. `pnpm typecheck` must pass before each one.
- Prefer boring and explicit over clever. This is infrastructure the owner will debug at 2am.
- Don't invent scope. If the plan doesn't call for it, ask before building it.
- When a decision changes, update `docs/plan.md` in the same commit — the docs are the source of truth, not tribal memory.
- Release tags are signed (`git tag -s`). Regular commits don't need signing.
- Ask rather than assume when the plan is silent. The owner has strong opinions and prefers a question over a rewrite.

## Stack

TypeScript throughout (Node 20+, pnpm, strict mode, ESM). Tauri for the macOS shell. SQLite on the Hub. `node-pty` for terminals. Small Swift helper only if Secure Enclave needs more than Tauri's plugins expose.
