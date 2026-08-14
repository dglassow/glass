# Glass

A unified client for running terminal sessions across the owner's Macs, with a chat surface for mobile. One codebase, three roles: **Hub** (registry, auth, vault, relay), **Agent** (hosts sessions), **Viewer** (native Mac app, or chat-only PWA elsewhere).

Solo project, personal infrastructure. Ground-up rebuild — replaces Prism, supersedes Forge.

## Read first

- `docs/plan.md` — settled architecture and build phases. Authoritative.
- `docs/open-questions.md` — what's genuinely undecided. Everything not listed there is decided; don't reopen it without saying so explicitly.

## Current state

**Phases 0–4, 6, 7, and 8 done. Phase 2 fully done (auth, passkey, relay/TLS/mutual-auth, authenticated viewer). Phase 5 is half done: the chat provider exists (M1); voice and the PWA chat surface remain. Glass runs against live infrastructure: a signed+notarized desktop app, a deployed relay, and hub-served signed auto-updates.**

Verification: 19 adversarial test harnesses under `tests/`, all run by `pnpm test` and CI. Each security-sensitive milestone (updater, git hosting, reachable hub, enrollment, update banner) was additionally red-teamed via multi-agent workflows, with every confirmed bypass fixed and regression-tested. Still not machine-verified: interactive GUI behavior (the xterm UI compiles and bundles headlessly; a human runs the real app), and the Tauri shell build itself (needs Rust on a Mac).

### Phase 0–1 — topology and the terminal loop

- Monorepo (pnpm workspaces), `@glass/protocol` with zod schemas, version negotiation, NDJSON framing, CI.
- Process topology (`supervisor`, `sessiond`, `agent`, `hub`) with boundaries enforced by TS project references (only `protocol` is shared; `supervisor` deliberately can't import it).
- M1 local loop: `sessiond` owns PTYs over a Unix socket; `agent` relays over protocol envelopes. `tests/m1-acceptance.mjs`: SIGKILL+restart of the worker leaves the shell alive with scrollback intact.
- M2 hub loop: `hub` is a WebSocket registry+relay (verbatim router; binds `from` to the handshaked identity; explicit `device_unknown`/`device_unreachable`/`unauthorized` errors; evicts a stale registration on agent restart). `agent --hub` is the sole address-translation boundary, with two *soft* tables (pending request→viewer, attached sessionId→Set<viewer>), always `from=agentId` toward sessiond so its `conn.peer` can't flap; multi-viewer fan-out lives here. `tests/m2-acceptance.mjs`: shell through the hub survives agent SIGKILL+restart with scrollback across the outage; cross-viewer isolation, from-spoof rejection, no false `session.exited`.
- M3 viewer: `@glass/viewer` is the shared web frontend. `hub-client.ts` is a DOM-free protocol client (connect, device.list, session create/attach/stream, viewer-driven auto-reattach on `device.state`). GUI is xterm.js panes + a device/session sidebar, a Vite app. `tests/m3-viewer.mjs` drives the *built* client against the real stack and proves auto-recovery across an agent restart.

### Phase 2 — identity and reach (complete)

- M1 device-key auth: peers prove key possession with an **Ed25519 challenge/response** (`hello` → `hello.challenge{nonce}` → `hello.proof{signature}` → `hello.ack`; isomorphic WebCrypto helpers in `protocol/src/auth.ts`); the hub admits only deviceIds in its trust store (`hub/src/trust-store.ts`, 0600 JSON). Stale-socket eviction only *after* the proof verifies (no DoS-evict). **Enrollment with number matching** (plan §8) rides a frame-locked pre-auth lane; approver echoes the code (enforced on the wire); fail-closed on wrong code/expiry; already-trusted ids can't re-enroll. The hub is **fail-closed**: refuses to start without `--trust-store` or `--open`. `tests/p2m1-auth.mjs`.
- M2 passkey bootstrap (plan §8.4): owner passkeys via `@simplewebauthn/server` (`hub/src/passkey.ts` + `credential-store.ts`), registration gated by `--register-token`; a passkey-authenticated connection gains **approver capability**, so the very first device enrolls with no prior device approver. `tests/p2m2-passkey.mjs` (software WebAuthn authenticator). Q2 resolved.
- M3 relay + TLS + mutual auth: **reverse tunnel** (hub dials out via `ssh -R`; the VPS runs stock sshd and only sees ciphertext) — not a Glass-aware relay. TLS terminates in the hub (`--tls-cert/--tls-key`); `--hub-key` is its Ed25519 identity. **Mutual auth:** spoke sends `clientNonce`; `hello.challenge` carries a `hub{key,signature}` proof over `buildHubAuthPayload(deviceId, clientNonce, hubNonce, channelBinding)`; the spoke verifies against its pinned key. **Channel binding** = the TLS exporter (`exportKeyingMaterial(32,"glass/cb/v1")`), so a TLS-terminating MITM relay is refused even with the correct pin (`tests/p2m3-relay.mjs` includes a real MITM relay). `hub tunnel -- <cmd>` keeps the tunnel alive. `infra/lightsail/` provisions the relay (Terraform, S3 backend, SSO wrapper `tf.sh`; `user-data.sh.tftpl` is plain shell because Lightsail prepends `#!/bin/sh`; `ip_unprivileged_port_start=443` lets the non-root tunnel user bind :443). Browser/PWA spokes verify the pinned key over the nonces + WebPKI+CAA (no exporter API in browsers); full browser MITM-immunity (X25519 AKE / E2E) is a later milestone.
- M4 authenticated viewer: the viewer is a real trust-mode client — WebCrypto Ed25519 device identity persisted locally (`viewer/src/auth.ts`), full pin-verified handshake (`cb=""` for browsers), wrong pin refuses permanently. `tests/p2m4-viewer-auth.mjs` drives the built client against a trust-mode hub.

### Phase 3 — vault and backup (complete)

- M1 vault (plan §9): envelope encryption in `hub/src/vault/` over `node:sqlite` (zero native deps). Random master key wrapped in two independent scrypt keyslots (passphrase + user-supplied recovery key, LUKS-style); per-secret AES-256-GCM data keys; AAD binds `vaultId+secretId+version+class`. Per-device allow-list enforced against the handshake identity (deny-by-default, before decrypt); two classes (workflow machine-readable; personal refused to machines with `biometric_required` — the deferred Touch ID seam). Hash-chained audit log; recovery-key entropy gate (≥90 bits). `hub vault` CLI (secrets on stdin, never argv). Machine retrieval via `vault.get`→`vault.secret`, authenticated mode only. `@glass/cli`: `glass run` injects secrets into a child's env only, with a structural `RedactingLogger`. `tests/p3m1-vault.mjs`.
- M2 backup bundle (plan §10): `hub backup create|restore` (`hub/src/vault/backup.ts`). One encrypted file — vault DB via `VACUUM INTO`, trust + credential stores, and (Phase 7) every hosted git repo as a ref-complete git bundle + ACLs — under a scrypt key from the vault passphrase (separate salt, own AAD). Not in the bundle: enclave device keys, Etch. `tests/p3m2-backup.mjs` runs the §16 drill: wipe, restore on "clean hardware", secrets + trust + repos + tokens come back, recovery key still unlocks; wrong-passphrase and tampered bundles refuse.

### Phase 4 — self-update (complete)

- M1 blue/green worker swap (plan §3/§4/§12): the `supervisor` is real (protocol-free, `supervisor/src/{proc,supervisor,control}.ts`). Control socket `swap <entry>`: `standby` blue, spawn green, health-check green (must reach sessiond AND complete the authenticated hub handshake before writing `READY` on fd 3), retire blue only after `READY`; failed green → blue resumes (instant rollback). Agent gains `--supervised` (fd-3 status, stdin `standby`/`resume`/`drain`). Sessions untouched — PTY fds live in sessiond. Hardened since: outside a swap, an unexpected worker exit restarts the worker against the surviving sessiond; a sessiond exit replaces both; recovery/swap mutual exclusion. `tests/p4m1-swap.mjs`. Fd-handoff research (red-teamed): sessiond self-update is feasible in pure Node via fd-inheritance-at-spawn (`node-pty` exposes `.fd`; no native SCM_RIGHTS needed) — still a later milestone.
- M2 signed-release update gate (`hub/src/updater/`): a release tag is trusted iff `git verify-tag` passes against an allowed-signers file pinned OUTSIDE the repo being verified (in-repo pin refused; missing/empty pins fail closed). `GitUpdateSource` resolves the tag to an immutable OID once and uses it for BOTH verify and export (TOCTOU-proof); export is direct `ls-tree`+`cat-file` extraction that refuses symlinks/submodules (no `git archive`, so `.gitattributes` can't alter staged bytes). `HARDENED_GIT_CONFIG` pins `gpg.ssh.program`, `core.sshCommand`, `credential.helper`, `core.fsmonitor`, `hooksPath`, `protocol.ext` on EVERY git call (an untrusted repo's config is attacker input — this killed a real fetch-time RCE). Newest *verified* release wins; no downgrade; bounded protocol advance (local ≤ target ≤ local+1) so the hub always still speaks N-1. `hub update check|stage|apply` drives the supervisor's swap. Two red-team rounds, 7+2 exploit regressions. `tests/p4m2-update.mjs` (real SSH-signed tags in throwaway repos).

### Phase 5 — chat (M1 done; voice + PWA chat surface remain)

- M1 chat provider (plan §1/§5): `sessiond` has a provider-agnostic `Session` interface; `PtySession` and `ChatSession` both implement it, so the socket server, scrollback, and fan-out are provider-blind. `ChatSession` runs `etch -z "<message>"` per message and renders the reply into the same output stream — a chat rides the identical session protocol and survives a worker restart like a PTY. Etch is detected and reported in the device record (never managed); binary overridable via `GLASS_ETCH_BIN`. `tests/p5m1-chat.mjs` (stub etch). Q3 resolved: `-z` oneshot text is adequate now; `tui_gateway` JSON-RPC / ACP is a later enhancement.

### Phase 6 — browser proxy (complete)

- M1: `agent/src/proxy/socks5.ts` is a minimal SOCKS5 CONNECT server (IPv4/domain/IPv6, remote DNS), pluggable dial + allow-gate + audit hook. `browser-profile.ts` builds an isolated browser launch (`--user-data-dir` per profile, `--proxy-server=socks5://…`, loopback bypass so local traffic can't recurse). `proxy.{open,opened,data,close}` protocol family.
- M2: `ProxyForwarder` (local SOCKS listener → multiplexes each TCP connection into `proxy.*` frames) + `ProxyExit` (dials the real destination on the egress device). Transport is injected, so the same halves work over hub routing, a direct tunnel, or in-process. Plan §7's "done when" (browse locally with another device's egress) proven in `tests/p6m1-proxy.mjs` with real curl through the tunnel.
- End-to-end wiring (post-Phase 8): `proxy.forward.{open,opened,close}` control messages; every agent serves as an exit for trusted peers (exits are per requesting peer so channels can't cross devices; each egress destination logged to stderr), and hosts loopback-only forwarders keyed by exit device (idempotent open). Viewer sidebar 🌐 per connected agent (desktop only) → `openProxyForward` on THIS Mac's agent (`extras.localAgentId`, reported by glass-backend for all roles) → `launch_proxied_browser` with a per-egress-device profile (`profileName` → `~/.glass/desktop/browser-profiles/`, sanitized in the shell). Forwarders are worker soft state — a swap drops proxied connections, never sessions. `tests/p6m2-proxy-e2e.mjs` (real curl through A's forwarder, egress audited on B, hostile-frame no-op, unknown-exit fail-closed).

### Phase 7 — git hosting (complete)

- The hub serves bare repos over **smart-HTTP** on its own authenticated TLS listener under `/git/` (reusing the relay tunnel — no separate SSH service). `git-store.ts`: per-repo read/write ACL (write implies read), per-device bearer tokens stored only as salted-SHA-256 hashes (256-bit random tokens, constant-time check), strict repo-name validation. `git-http.ts`: Basic auth (deviceId:token) → repo exists → ACL, only the 4 smart endpoints (no dumb protocol), explicit CGI env, streamed responses; the service query param is rebuilt from the *classified+authorized* service (kills a param-desync write bypass). CLI: `hub git init|allow|revoke|list|token`, `--git-root`. Repos ride the backup bundle. `tests/p7m1-git.mjs` (real clone/push, isolation, traversal, dumb-path 404s).

### Desktop app, PWA, and live deployment

- `@glass/desktop` is a real, signed macOS app, not a scaffold (still workspace-excluded; needs Rust on a Mac). `pnpm tauri build` produces Glass.app / Glass.dmg with the backend **bundled**: `@glass/backend-bundle` pnpm-deploys hub/sessiond/agent (+ node-pty darwin-arm64 prebuild) into a flat tree, plus a portable official node binary, into app Resources — the .dmg runs on a Mac with no node and no repo. `deploy/glass-backend.mjs` is the per-role launcher the app spawns (`--role standalone|hub|spoke`, one `GLASS_BACKEND_READY` line, state in `~/.glass`); the app prefers the dev repo when present, else the bundled backend. First-run role picker (Standalone/Hub/Spoke) in `viewer/src/onboarding.ts`; native menus (Edit for clipboard, Reconfigure, Terminal Settings ⌘,); tiling session workspace (`workspace.ts`: binary layout tree, drag-to-split, hide≠kill); customizable terminal appearance over a transparent window (`macos-private-api`). Signing: `sign-and-notarize.sh` deep-signs inside-out (native addons → bundled node with JIT entitlements → app), notarizes app+dmg via the `glass-notary` notarytool Keychain profile, staples both. Mac App Store is a non-starter (App Sandbox forbids spawning node/shells) — Developer ID direct distribution, deliberately.
- The viewer doubles as an **installable PWA served by the hub** (`--web-root`, TLS required): manifest, icons, service worker (registered only when `!isNative()`), responsive drawer layout under 720px, auto-connects to the serving origin. `hub/src/web-static.ts` is the traversal-safe static handler (immutable `/assets/*`, no-cache index/sw, SPA fallback).
- `deploy/relay-smoke.mjs` proved the whole path over the real internet against the deployed Lightsail relay: viewer/spoke → relay :443 (ciphertext only) → reverse tunnel → hub (TLS terminates, mutual auth + channel binding) → spoke PTY. `deploy/hub-live.mjs` keeps a persistent hub+tunnel+agent up for real clients. All instance key material lives in gitignored `config/local/`.

### Phase 8 — reachable fleet hub, session sync, enrollment, signed auto-update (complete)

- **Reachable hub**: multi-listener hub — loopback ws for the local viewer + TLS wss over the relay for spokes — sharing one registry/trust/auth. A spoke fails closed without a hub-key pin.
- **Fleet session sync**: viewers enumerate every agent's sessions on connect and receive live `session.created`/`session.exited` broadcasts, so shells show on all devices.
- **Self-serve enrollment from the app**: number-match join — the hub mints the 6-digit code and shows it only to the joiner; the approver types it. Roles clamped (no self-granted hub), companions capped, rate-limited.
- **Signed auto-update**: Tauri v2 updater served from the hub (`hub/src/updates-http.ts`, `/updates`), minisign + Developer-ID-notarized artifacts, with a device-side anti-rollback floor + poison + give-up guard (`viewer/src/update-policy.ts` — the Tauri plugin does not verify the manifest version itself). `release.sh` syncs versions (a stale Cargo version once poisoned the anti-rollback reconcile).
- **Hub→spoke update banner**: the hub watches `latest.json` and pushes `update.available`; the spoke nags only when the offered version is strictly newer (no hub-forced downgrade); the button applies the signed update; the banner clears once current.
- `tests/p8m1..p8m5` (reachable hub incl. hardened recovery interplay, session sync, enrollment, update policy, update banner). The app's updater endpoint (a public hostname) is deliberately baked into `tauri.conf.json` — a documented, owner-accepted exception to the no-instance-config rule, since the updater must work with zero config.

### Protocol notes

`PROTOCOL_VERSION` stays 1 (unreleased); every change so far is additive. Families: `handshake` (hello/challenge/proof/ack, clientNonce + channelBinding + hub proof block, Etch detection), `device` (registry/state, `device.enroll.*` with number matching, Phase 8 enrollment fields, `device.rename` — owner names persist in the trust store, which registration prefers over the hello's self-reported name), `session` (create/attach/stream/resize/close/exit, `session.created`/`exited`/`renamed` broadcasts; `session.rename` stores the title in sessiond's record), `credential.*` (passkeys), `vault.*`, `proxy.*`, `system` (heartbeat, structured errors, `update.available`). `protocol/src/auth.ts` holds the isomorphic signing/verification helpers; `protocol/src/redact.ts` the secret-redaction structure. Keychain/Secure-Enclave key storage stays deferred behind the `Signer` seam.

### Not yet done

- **Phase 5 remainder**: PWA chat surface, STT/TTS, push-to-talk, Web Push (Q4/Q5 in open-questions).
- **sessiond→sessiond fd handoff** (the researched fd-inheritance design) — the only update path that still interrupts nothing but hasn't been built.
- **The §16 production gate**: the full failure-mode drill (hub death → clean-hardware restore, relay outage, cert expiry, …) before Glass is used for any work beyond developing Glass. Individual pieces are tested; the end-to-end drill is not.
- Real-device passes a human must do: browser `navigator.credentials` passkey wiring on actual hardware; the multi-Mac "from Studio, run a shell on Pro" ritual with the released app.

## Hard constraints

Violating these breaks the architecture rather than just the code. If something seems to require it, stop and ask.

**Sessions never live in the worker.** PTY file descriptors belong to `sessiond`, which survives updates. The worker gets swapped blue/green constantly. This is the single load-bearing decision in the design — the entire no-interruption update story depends on it.

**`protocol/` is the only shared dependency.** `hub`, `agent`, and `viewer` must never import from each other. If they need to share something, it goes in `protocol/` or it doesn't exist.

**Protocol version rides on every envelope**, not just the handshake. A Hub mid-rollout holds connections from peers on two versions at once. The Hub speaks N-1; two versions behind is refused.

**This repository is public.** No secrets, no instance config, ever — no relay hostnames, tunnel keys, certificates, or device names. All of it lives in the encrypted backup bundle. If a value differs per install, it is configuration, not code. (Two owner-accepted exceptions exist: the updater endpoint baked into `tauri.conf.json`, and the relay IP in `deploy/*.mjs` — public endpoints that only ever carry ciphertext. Don't add more without asking.)

**Browsers are not sessions.** They run locally and are optionally proxied over SOCKS. There is no browser session kind and no pixel streaming. Session kinds are `pty` and `chat`, full stop.

**The PWA is chat-only.** No terminal panes, no browser features. Terminal UI is macOS-native only. The web frontend is one shared codebase with different capability tiers, not two apps.

**Etch is detected, never managed.** It's a separate CLI the owner installs by hand. Report presence and version; never write install, update, or bundling logic for it.

**Tauri is desktop-only.** Mobile is PWA. Do not add Tauri mobile targets — app-store distribution is explicitly out of scope.

**The updater is the highest-value target.** It runs code unattended on every host with full shell and vault reach. Anything touching `hub/src/updater/`, `updates-http.ts`, or `update-policy.ts` is built verify-first, treats the fetched repo/manifest as attacker input, and gets adversarial tests — not just happy-path ones.

## Working agreements

- Small, focused commits. `pnpm typecheck` must pass before each one.
- Prefer boring and explicit over clever. This is infrastructure the owner will debug at 2am.
- Don't invent scope. If the plan doesn't call for it, ask before building it.
- When a decision changes, update `docs/plan.md` in the same commit — the docs are the source of truth, not tribal memory.
- Release tags are signed (`git tag -s`). Regular commits don't need signing.
- Ask rather than assume when the plan is silent. The owner has strong opinions and prefers a question over a rewrite.

## Stack

TypeScript throughout (Node 20+, pnpm, strict mode, ESM). Tauri v2 for the macOS shell (Rust; workspace-excluded, built on a Mac). SQLite on the Hub. `node-pty` for terminals. Terraform for the relay VPS. Small Swift helper only if Secure Enclave needs more than Tauri's plugins expose.
