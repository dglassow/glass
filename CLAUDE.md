# Glass

A unified client for running terminal sessions across the owner's Macs, with a chat surface for mobile. One codebase, three roles: **Hub** (registry, auth, vault, relay), **Agent** (hosts sessions), **Viewer** (native Mac app, or chat-only PWA elsewhere).

Solo project, personal infrastructure. Ground-up rebuild — replaces Prism, supersedes Forge.

## Read first

- `docs/plan.md` — settled architecture and build phases. Authoritative.
- `docs/open-questions.md` — what's genuinely undecided. Everything not listed there is decided; don't reopen it without saying so explicitly.

## Current state

**Phase 0 complete. Phase 1 done. Phase 2 M1–2 (auth + enrollment + passkey) done. Phase 3 M1 (vault) done.**

Done:
- Monorepo (pnpm workspaces), `@glass/protocol` with zod schemas, version negotiation, NDJSON framing, CI
- Process topology (`supervisor`, `sessiond`, `agent`, `hub`) with boundaries enforced by TS project references (only `protocol` is shared; `supervisor` deliberately can't import it)
- Phase 1 M1 local loop: `sessiond` owns PTYs over a Unix socket; `agent` relays over protocol envelopes; throwaway CLI client. `tests/m1-acceptance.mjs`: SIGKILL+restart of the worker leaves the shell alive with scrollback intact.
- Phase 1 M2 Hub loop: `hub` is a WebSocket registry+relay (verbatim router; binds `from` to the handshaked identity; explicit `device_unknown`/`device_unreachable`/`unauthorized` errors; evicts a stale registration on agent restart). `agent` gains `--hub` mode: the sole address-translation boundary, with two *soft* tables (pending request→viewer, attached sessionId→Set<viewer>), always `from=agentId` toward sessiond so its `conn.peer` can't flap; multi-viewer fan-out lives here. `tests/m2-acceptance.mjs` (18 checks): a viewer runs a shell on a named agent through the hub, survives an agent SIGKILL+restart with scrollback across the outage, plus cross-viewer isolation, from-spoof rejection, and no-false-`session.exited`. Only `supervisor` is still a skeleton.

- Phase 1 M3 Viewer: `@glass/viewer` is the shared web frontend. Its `hub-client.ts` is a DOM-free protocol client (connect, device.list, session create/attach/stream, and viewer-driven auto-reattach on the hub's `device.state` broadcast). The GUI is xterm.js terminal panes + a device/session sidebar (`main.ts`, `terminal-pane.ts`), a Vite app. `tests/m3-viewer.mjs` (11 checks) drives the *actual* built client against the real stack and proves auto-recovery: kill+restart the agent and the client re-attaches on its own with scrollback across the outage. `@glass/desktop` is a Tauri v2 scaffold wrapping the Viewer bundle — excluded from the pnpm workspace; needs Rust + a Mac to build (see its README).

Verification honesty: the backend (hub/agent/sessiond) and the Viewer's data layer are proven by `tests/` (38 checks, in CI). The xterm.js GUI compiles and bundles but is not interactively verified headlessly; the Tauri shell is a scaffold, not built here.

- Phase 2 M1 auth: the hub's `authorize()` stub is gone. Peers now prove key possession with an **Ed25519 challenge/response** (`hello` → `hello.challenge{nonce}` → `hello.proof{signature}` → `hello.ack`; shared isomorphic WebCrypto helpers in `protocol/src/auth.ts`), and the hub admits only deviceIds in its trust store (`hub/src/trust-store.ts`, a 0600 JSON file; SQLite in Phase 3). Stale-socket eviction happens only *after* the proof verifies, so an impostor can't DoS-evict a live device. **Enrollment with number matching** (plan §8) rides a frame-locked pre-auth lane over the existing `device.enroll.*` messages; the approver echoes the code (enforced on the wire), fail-closed on wrong code/expiry, and already-trusted ids can't be re-enrolled. Bootstrap for the first device is the marked CLI `node hub/dist/main.js trust add|list|remove` — the Q2-blocked passkey/TOTP path plugs into the same `TrustStore.add()` seam. The hub is **fail-closed**: it refuses to start without `--trust-store` or `--open`. `--open` preserves Phase 1 behavior; the M2/M3 harnesses pass `--open`. Agent gains `--key <path>` (`agent/src/keystore.ts`); the viewer's `HubClient` takes an injected `Signer`. `tests/p2m1-auth.mjs` (20 checks) proves admission, refusal of unknown/bad-sig/replayed peers (and that they can't evict a live connection), the full enroll→authenticate loop, and trust surviving a hub restart.

- Phase 2 M2 passkey bootstrap (plan §8.4): the hub can register owner passkeys (`@simplewebauthn/server`, `hub/src/passkey.ts` + `credential-store.ts`, 0600 JSON). Registration is gated by a startup `--register-token`; a passkey-authenticated WS connection gains **approver capability** — it receives enrollment broadcasts and can approve them (`approvedBy: "hub-credential"`), so the very first device can be enrolled with no prior device approver. `tests/p2m2-passkey.mjs` (10 checks, software WebAuthn authenticator) proves token-gating, the first-device bootstrap, passkey auth, and refusal of replayed / forged / counter-regressed assertions. **Open-question Q2 is resolved: `@simplewebauthn/server` fits** (verified against a full headless ceremony).

- Phase 3 M1 vault (plan §9): envelope encryption in `hub/src/vault/` over `node:sqlite` (verified flag-free on Node 25; zero native deps). A random master key wrapped in two independent scrypt keyslots (passphrase + user-supplied recovery key — LUKS-style, so recovery-only unlock works); per-secret AES-256-GCM data keys; AAD binds `vaultId+secretId+version+class` (defeats byte-flip, row-transplant, class-flip). Per-device allow-list enforced against the handshake identity (deny-by-default, before decrypt); tags are taxonomy only; two classes (workflow machine-readable, personal refused to machines with `biometric_required` — the deferred Touch ID seam). Hash-chained audit log; recovery-key entropy gate (≥90 bits). `hub vault` CLI (init/add/update/remove/reveal/list/allow/deny/tag/untag/check-recovery/audit; passphrases + values on stdin, never argv). Machine retrieval over the hub via `vault.get`→`vault.secret`, gated to authenticated (non-`--open`) mode. New `@glass/cli` package: `glass run` injects secrets into a child's env only (never argv/disk), with a structural `RedactingLogger`. `tests/p3m1-vault.mjs` (25 checks). Backup bundle (§10) is the next vault milestone.

Protocol note: M2 added `roles` + `deviceName` to `Hello`. P2-M1 added `hello.challenge`/`hello.proof`, enrollment fields, and `protocol/src/auth.ts`. P2-M2 added the `credential.*` family. P3-M1 added the `vault.*` family, four secret error codes, and `protocol/src/redact.ts`. All additive; `PROTOCOL_VERSION` stays 1 (unreleased). Deferred (needs your infra/decision): mutual auth / TLS + hub-key pinning (M1 auth proves the peer holds its key, not that the channel is unhijacked — fine on loopback/tailnet), the Lightsail relay (needs a VPS), and Keychain/Secure-Enclave key storage (behind the `Signer` seam, needs a Mac).

Scope: M1–M3 prove the load-bearing decision (PTYs survive a worker swap) end-to-end, through the hub, and into the viewer client. NOT yet covered: the Phase 4 blue/green `sessiond`→`sessiond` fd handoff (SCM_RIGHTS), the hub's own blue/green restart recovery, and running the GUI on real hardware ("from Studio, run a shell on Pro" — the last step is a human running the Tauri app on a Mac).

Next: Phase 2 remainder — passkey / password+TOTP bootstrap (blocked on open-question Q2, the `@simplewebauthn` spike), then the Lightsail relay + TLS with hub-key pinning / mutual auth. Also still open: run the desktop GUI on real Macs to close Phase 1's "shell on Pro".

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
