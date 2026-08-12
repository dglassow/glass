# Glass

A unified client for running terminal sessions across the owner's Macs, with a chat surface for mobile. One codebase, three roles: **Hub** (registry, auth, vault, relay), **Agent** (hosts sessions), **Viewer** (native Mac app, or chat-only PWA elsewhere).

Solo project, personal infrastructure. Ground-up rebuild — replaces Prism, supersedes Forge.

## Read first

- `docs/plan.md` — settled architecture and build phases. Authoritative.
- `docs/open-questions.md` — what's genuinely undecided. Everything not listed there is decided; don't reopen it without saying so explicitly.

## Current state

**Phase 0, partially complete.**

Done:
- Monorepo (pnpm workspaces), `@glass/protocol` with zod schemas, version negotiation, CI
- Process topology tiers scaffolded as skeletons (`supervisor`, `sessiond`, `agent`, `hub`), boundaries enforced by TS project references (only `protocol` is shared; `supervisor` deliberately can't import it)

Not started:
- Everything in Phase 1 onward (the topology skeletons carry no behavior yet)

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
