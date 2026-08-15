# Glass — architecture & execution plan

Companion to `open-questions.md` (the running tracker). This is the settled shape and the build order.

---

## 0. What Glass replaces

Glass is a **ground-up rebuild**, not an evolution of existing projects. It consolidates:

| Existing | Fate |
|---|---|
| Prism (terminal broker) | **Replaced.** No architecture carried forward. Still useful as reference — it proved the PTY-over-WebSocket pattern works. |
| Forge (git + secrets) | **Deprecated eventually, not migrated.** Glass starts clean — no importer. The two coexist; you re-add repos and secrets to Glass as you need them, and retire Forge once what's left on it stops mattering. Migration tooling stays possible later if the manual path proves annoying. |
| Etch (agent runtime) | **Primary agent, but still separate and manually managed.** You install and update it on each Agent; Glass never distributes it. Glass supports its full interactive CLI in a PTY, uses the versioned Etch surface protocol for structured runs, and retains `etch -z` only as a compatibility fallback. Etch remains authoritative for its runtime, context, delegation, autonomy, skills, and worktrees. |

Phase 1 is therefore greenfield. More work up front than refactoring Prism would have been, but it avoids inheriting single-Mac assumptions.

---

## 1. The core abstraction: sessions

A **session** is anything long-lived running on an Agent, streamed to a Viewer. Shared lifecycle — `create`, `attach`, `stream`, `detach`, `kill` — one routing path, one auth model.

| Provider | Backed by | Notes |
|---|---|---|
| Terminal | `node-pty` | Same lib as VS Code's terminal. Built fresh; see §0. Etch, Codex, Claude, and any other CLI run here at full terminal fidelity. |
| Chat | Provider adapter; Etch by default | A long-lived structured adapter streams turns, approvals, clarification, and lifecycle into Glass. Etch's surface protocol is the primary implementation; Codex and Claude implement the same Glass-side contract. |

New capability = new provider. Nothing around it changes.

An **agent run** is durable control-plane metadata layered over a `pty` or
`chat` session, not a third session kind. It records where and how the agent is
running, which provider session it corresponds to, its parent/children, and
whether it needs attention. Provider-owned conversation history, memory, tool
state, and policy do not move into Glass.

**Browser is not a session provider.** See §7.

---

## 2. Roles & viewer tiers

- **Hub** — registry, auth, vault, relay, update distribution, git hosting. Toggleable feature of the Mac app; one active at a time.
- **Agent** — hosts session providers. Every Mac.
- **Viewer** — two genuinely different containers around **one shared web frontend**:

| | Mac desktop app | PWA (phone, other devices) |
|---|---|---|
| Container | Native app (Tauri shell) | Installed web app |
| Terminal panes | Yes | No |
| Chat | Yes | Yes |
| Browser profiles + proxy | Yes | No |
| Local system access | Full | None |

The desktop app is a **real Mac application**, not an installed PWA — it has to spawn local Chromium with proxy flags, manage launchd, and reach Keychain, none of which a PWA can do.

The PWA is strictly a chat interface, claude.ai-shaped. It drives the selected
agent through its chat adapter (Etch by default), which interprets terminal
work and returns it as conversation. It is not a terminal emulator.

**WebKit is a first-class target, not a fallback.** Every browser on iOS uses WebKit, including installed PWAs — so iPhone support means Safari-engine support. Audio capture, Web Push, and storage behavior must all work there from the start.

---

## 3. Process topology

**Decided in Phase 0. Retrofitting this later is a rewrite.**

| Tier | Contains | Update cadence |
|---|---|---|
| Controller + supervisor | Per-user `glassd`, role/process lifecycle only | Almost never |
| Hub | Registry, auth, routing, vault, UI serving | Per release; brief reconnect |
| Worker | Agent protocol/routing and reconstructible soft state | Frequently, blue/green |
| Session daemon | Live PTY file descriptors and scrollback | Only idle/reboot today |

Sessions do not live in the tier that gets updated. A per-user LaunchAgent owns
`glassd` outside the Tauri lifecycle; Glass.app is only a Viewer/control client.
Bundled releases are copied to versioned writable runtimes before activation.
Agent swaps blue/green, Hub restarts on a stable loopback port, and the running
`sessiond` remains pinned to its old runtime while sessions exist. Today it
advances after explicit reconfiguration or reboot. Live fd inheritance between
old/new daemons remains the final no-interruption daemon-update step.
Stable controller and portable-Node changes stage beside the installed service
until the owner explicitly accepts a destructive restart. The replacement must
report the expected controller identity and configured stack or the control
client restores and restarts the previous service files.

---

## 4. Updates

- Self-updating, in place, no user interruption. Background by default.
- Blue/green worker swap; old worker drains, new worker accepts.
- App update/relaunch never owns or terminates the persistent backend.
- Runtime activation swaps Agent, restarts Hub separately, and defers sessiond.
- Anything genuinely requiring a restart first persists all in-progress work, then restores it after.
- **Hub updates first, then pushes to spokes.** All devices converge on the Hub's version.
- **The Hub must always speak protocol N-1.** This bounds compatibility work and lets a spoke that was offline during a rollout reconnect on its old version long enough to pull the update.
- **GitHub is the source of truth** for code, in a **public repo**. The Hub tracks it and self-updates by the same handoff. No credential needed to pull — recovery works from a clean machine with no access to anything.
- **Release tags are signed; the updater verifies before applying anything.** SSH signing, reusing an existing key — no GPG setup. Without this, a compromised GitHub account is arbitrary code execution on every machine, since the updater runs code unattended on hosts with full shell access and vault reach.
- **The verification public key is pinned outside the repo** — baked in at install, held in each device's Keychain, included in the backup bundle. If the Hub read the key from the repo it verifies, an attacker would simply swap both and verification would pass.
- **Key rotation is manual and per-device**, never automatic and never remotely triggerable. That's the point of it.
- **Three signing identities exist, not one** (see §15). Apple's Developer ID cert satisfies Gatekeeper; git tag signing covers services pulled from GitHub; Tauri's updater has its own bundle-signing key. Different artifacts, different formats, same protection requirements — and none of them belong in the repo.
- **No instance config in the repo, ever.** Relay hostname, tunnel key, TLS cert, and device names live only in the backup bundle. A public repo makes this load-bearing rather than merely tidy — enable GitHub push protection and a pre-commit secret scan.
- **Validation before retirement:** the new worker must pass a health check before the old one is retired — never the reverse. Threshold TBD.
- **Version skew is visible at both ends:** a spoke on N-1 shows a local banner *and* surfaces at the Hub, so drift gets addressed rather than accumulating.
- **Etch is outside the update system entirely** — installed and updated by hand per machine, versioning independently of Glass. Expect drift between Macs.
- **Glass detects Etch rather than managing it.** Each Agent reports whether Etch is present, its version, and the structured capabilities it advertises. Glass may invoke the installed binary, but never installs, updates, configures, or bundles it. Version/capability drift is visible instead of becoming a silent failure.
- **Release candidates are provenance-bound.** The backend records source commit, release version, dirty state, and runtime digest. Packaging requires a clean tag at HEAD; ARM64 macOS CI builds the real unsigned app and verifies its bundled runtime. Shipping also runs real Etch, Codex, and Claude concurrently before signing.
- **Two independent restore artifacts:** code from the public GitHub repo, state from a backup snapshot. Full recovery is an anonymous clone followed by a state restore — neither artifact depends on the Hub being alive, and neither requires credentials you might have lost with it.

---

## 5. Stack

- **TypeScript** for Hub, Agent, web frontend, CLI — the large majority.
- **Tauri** as the macOS desktop shell. Thin Rust layer; the UI inside it is the same TS frontend. Keeps a native Windows client possible later.
- **Swift**, small helper binary, only if Secure Enclave or Accessibility need more than Tauri's plugins expose.
- **PWA** for mobile only — chat surface, served by the Hub. No app stores anywhere.
- **SQLite** on the Hub: registry, credentials, vault ciphertext, audit log.

```
glass/
  packages/
    protocol/         # message schemas, version negotiation — the contract
    supervisor/       # lifecycle tier
    sessiond/         # PTY ownership, survives updates
    hub/              # registry · auth · vault · relay · update distribution
    agent/            # worker: session routing
      providers/pty/
      providers/chat/
    viewer/           # shared web frontend — webview on desktop, PWA on mobile
    desktop/          # Tauri shell: window, native bridge, local browser launch
    cli/              # secret injection, enrollment
    native/           # Swift keychain helper
  infra/lightsail/
```

---

## 6. UI shape

Session list (sidebar) + tiling pane area. Type badges, device labels, live status. Sessions detach and reattach across panes and Viewers without dying. PWA collapses to a single chat surface.

### Agent orchestration

Glass is the durable **control and attention plane** for agents; it is not a
second agent runtime. The provider boundary is deliberately narrow:

| Glass owns | The provider owns |
|---|---|
| Device and workspace placement, launch profiles, session routing, layout, normalized run state, attention/approval routing, safe notifications, and capability display | Prompts and transcripts, model/tool schemas, permissions, skills, memory/context, compaction/resume semantics, cron/autonomy, delegation, and execution policy |

The Hub persists and broadcasts run/workspace metadata; `sessiond` owns live
provider processes and handles; Agent translates and routes; Viewers are
replaceable projections. Provider-specific wire types stay inside the
sessiond adapter and are generated from each provider's public contract. Only
the normalized `run.*` messages belong in Glass `protocol/`.

After each Agent registration, sessiond sends its UUID-tagged, content-free run
inventory to the Hub. The Hub reconciles durable records for that device and
marks missing nonterminal runs interrupted. This prevents stale Active and
Needs you cards after a daemon restart without moving provider content into the
Hub. If a provider session id survived, Viewer can create a replacement run
through the provider's native resume path.

Etch is the default for **New agent** and the reference adapter. A top-level
Etch run starts in the chosen cwd/profile and is isolated from sibling runs.
`sessiond` owns the adapter process so Viewer, Hub, and Agent reconnects do not
terminate it. Glass creates the Etch session with `close_on_disconnect=false`,
persists both Etch's runtime and stored session ids as opaque references, and
uses Etch's own resume path after a provider restart. Glass never writes Etch
configuration or copies Lattice/Silica state into the Hub.

The Etch adapter targets the checked-in `etch-surface-v1` JSON-RPC contract:

- Negotiate `gateway.ready` and its contract/capabilities before enabling UI.
- Map `session.create`, `session.resume`, `session.activate`, and
  `session.close` onto the existing Glass `chat` session lifecycle.
- Stream `prompt.submit` plus `message.*`; route `approval.request` and
  `clarify.request` to the exact run that emitted them.
- Surface `session.info`, command catalog, model/provider/profile selection,
  reasoning effort, and file attachment only when advertised.
- Treat unknown optional capabilities additively and fail closed on an
  incompatible major contract.

Etch now exposes the supported `etch surface --stdio` entry point, with stdout
reserved for protocol frames and diagnostics on stderr. Glass launches one
surface process per top-level Etch run for failure isolation. The v1.2 contract
advertises optional active-session, delegation control/events, orchestration
status, usage, and worktree metadata; Glass gates each UI action on the
negotiated capability and does not bind to private gateway names. Etch performs
autonomy and worktree operations while Glass requests and reflects bounded
metadata. Canonical Etch semantics remain in the Etch
repository's `modules/etch/module.json`, `docs/etch/glass-module.md`,
`docs/etch/session-lifecycle.md`, `docs/etch/central-context-awareness.md`, and
`docs/etch/runtime-autonomy.md`; this plan defines only the Glass-side boundary.

Each durable run record contains only bounded control metadata: Glass run id,
device/session id, provider and opaque provider-session id, cwd/workspace,
optional Etch profile/model, parent run id, worktree reference, normalized
status/attention reason, capability set, aggregate usage/cost when reported,
and last activity time. It contains no prompt, response, command, tool output,
secret, or Lattice content. The workspace stores pane layout, hidden/visible
state, and focus separately, so closing a window is never equivalent to
killing a run.

Concurrent Etch coding runs default to a provider-owned isolated worktree;
shared mode is explicit. Etch creates and locks the worktree and its
capacity/policy errors pass through unchanged. Glass records only the selected
mode and returned reference and never runs competing cleanup or merge logic.
Codex, Claude, and generic runs record their selected mode but do not claim
Etch's worktree lifecycle; their provider/user remains responsible.

Provider launch is an argv operation, never a shell command string. Cwd,
profile, model, provider, status path, and attachments are validated before
crossing the sessiond boundary; a remote Viewer cannot choose the executable
path or inject arbitrary environment variables. Approval and clarification
ids are scoped to both run and provider session so one busy agent cannot
resolve another agent's pending request.

The desktop and shared Viewer add an **Agent Board** above the existing panes: grouped by
workspace/device, showing working, waiting, complete, failed, stale, and the
specific input type required. It supports launch, focus, resume, interrupt,
close, and approval/clarification from one inbox. Etch subagent events and
controls appear when delegation capability is advertised. The PWA
shows the same run/inbox model for chat sessions, without exposing a terminal.

Provider adapters have unequal capabilities and the UI says so rather than
emulating features unsafely:

| Provider | Structured path | Initial Glass target |
|---|---|---|
| **Etch (default)** | Versioned `etch surface --stdio` | Full lifecycle/stream/input plus negotiated delegation, orchestration, usage, attachment, and Etch-owned worktrees; reduced `etch -z` fallback |
| Codex | `codex app-server --stdio` | Persistent threads, streaming, approvals/input, usage, and interrupt; reduced resumable `codex exec --json` fallback |
| Claude | Resumable streaming JSON CLI | Streaming/session resume and interrupt; capability-labeled limits for interactive-only behavior |
| Generic CLI | Owner-configured argv plus content-safe terminal status | Launch, stream, status/attention, interrupt, and close only |

Etch's existing schema-v2 terminal status contract is the seed for the generic
fallback. Glass defines equivalent Glass-namespaced variables and supplies
both sets during migration so today's Prism-compatible Etch implementation
works unchanged. Status files remain per-session, owner-only, atomically
written, lease-fenced, and content-free. Structured provider events take
precedence when both exist.

Right-click a session or device row to rename it inline. Session titles live in sessiond's record (`session.rename`, broadcast fleet-wide); device names persist in the hub's trust store (`device.rename`), which registration prefers over a device's self-reported hello name — so both survive reconnects and restarts.

**Extensions** (see `docs/extensions.md`): user-authored add-ons imported as a single JSON file, VS Code-style. Install is consent — the dialog shows the declared capabilities, unknown ones refuse to import. Code runs in a dedicated Web Worker (no DOM, no page storage, no Tauri IPC); its only bridge to Glass is a capability-gated RPC (`sessions.read`, `sessions.write`, `storage`, `notify` to start — grown as needs appear). Ribbon buttons are the capability-free UI surface. Per-device (localStorage), like skills; not in the backup bundle.

**iMessage bridge** — the ribbon's first real widget. The Mac signed into iMessage serves its Messages store to the fleet through its agent: read-only `node:sqlite` over `~/Library/Messages/chat.db` (requires Full Disk Access; detected, never assumed — absent permission just means no bridge on that device), sends via AppleScript with the text and target riding `on run argv` (never interpolated into script source — injection-proof by construction; first send prompts the one-time Automation consent). NOT a session kind: a dedicated additive `imessage.*` family (conversations/messages/send, watch + `imessage.new` push), routed point-to-point so message content reaches only the viewers that asked; the hub relays verbatim, unchanged. Replying into an existing chat is reliable; new threads are best-effort (modern-macOS flakiness, surfaced honestly in the UI). The viewer's Messages dock (💬 ribbon widget, desktop layout only) lists conversations, pages threads, and replies; every chat.db string is untrusted display text, rendered via textContent only. **Several bridge Macs are first-class**: each reports its signed-in account (`chat.account_login`, additive `imessage.account` on hello / `imessageAccount` on the record), the device picker labels every entry "Name — account", and failover is account-aware (pure policy in `viewer/src/imessage-model.ts`) — same account = mirrored stores, so the panel switches Macs seamlessly and even keeps the open thread; different or unknown account = a different mailbox, never switched to silently: the panel resets to the conversation list and says whose mailbox it now shows. A reply can therefore never silently ride a different identity than the one on screen. Watchers and the 2s ROWID poller are agent-worker soft state — a blue/green swap drops them and viewers re-arm on the next device refresh. `tests/imessage.mjs` (synthetic chat.db incl. typedstream blobs + argv-recording send stub, against the real stack).

---

## 7. Browser

**No pixel streaming.** Each device uses its real local browser.

Optional: **traffic proxying**. A device runs a SOCKS5 endpoint over the existing tunnel; the app launches a browser profile with `--proxy-server` pointed at it. You render and interact locally, but egress happens from the chosen device. Proxied profiles stay fully separate from normal browsing — distinct profile, distinct cookie jar, distinct window.

Built in Phase 6: the SOCKS5 exit + `proxy.*` tunneling live in `agent/src/proxy/`, and the desktop shell launches the isolated proxied profile.

Wired end to end post-Phase 8: every agent serves as an exit for trusted peers (per-peer channel isolation, every destination logged to the agent's stderr); `proxy.forward.open` lets a viewer ask ITS OWN Mac's agent for a loopback SOCKS forwarder aimed at a chosen egress device; the sidebar's 🌐 button (desktop only) does exactly that and launches the browser with one isolated profile PER EGRESS DEVICE (`~/.glass/desktop/browser-profiles/egress-<deviceId>`), so cookie jars never cross egress identities. Forwarders are worker soft state: a blue/green swap drops live proxied connections (sessions are unaffected).

---

## 8. Enrollment

1. New Mac generates a keypair, requests enrollment.
2. Request broadcasts to **all** authorized devices — any one can approve.
3. **Number matching required**: the requesting device shows a short code; the approver confirms it matches. Without this, an attacker's request can be mistaken for your own.
4. Fallback and bootstrap: Hub credentials (passkey, or password + TOTP) authorize directly — this is the path for the very first device.
5. Requests expire; approvals are idempotent against races.

---

## 9. Vault

Envelope encryption — per-secret data keys wrapped by a master key, ciphertext in SQLite.

**Master key derives from passphrase + offline recovery key.** The Secure Enclave holds only a device-local Touch ID convenience wrapper.

> Enclave keys are non-extractable by design. A vault master key locked to one Mac's enclave would make the Hub unmovable and the backup unrestorable. Agent *device* keys can be enclave-locked — per-device and regenerable.

| | Workflow secrets | Personal secrets |
|---|---|---|
| Retrieval | Machine-readable by scoped Agents | Fresh biometric auth |
| Injection | `glass run` at runtime (modeled on `op run`) | Manual reveal only |

**Scoping:** flat secret list, each with a per-device allow-list. Tags exist for taxonomy and organization; no policy engine evaluates them yet.

**Recovery key:** you supply it, the system does not generate it. Shown once at setup, never again. A minimum entropy check is enforced — a self-chosen phrase is typically far weaker than 128 random bits, and this key protects the entire vault.

Secrets never touch dotfiles, shell history, or long-lived env vars.

---

## 10. Backup

**Time Machine does not target iCloud** — they're unrelated products. And live SQLite must never be sync-copied; it can be captured mid-write.

The Hub writes a **self-contained encrypted bundle** on a schedule:

- SQLite snapshot via `VACUUM INTO` (registry, WebAuthn credentials, vault ciphertext, audit log)
- Hub config; relay hostname; TLS cert + key; tunnel SSH key
- Enrollment records and device public keys
- Session state and scrollback
- App version + schema version, for restore compatibility

Destination configurable — an iCloud Drive folder works. The bundle is encrypted under the passphrase-derived key, so it's safe there without trusting Apple with contents. Time Machine to a local disk or NAS layers on top and picks the bundle up automatically.

**Not in the bundle:** enclave-backed device keys, which are non-extractable — a restored Hub re-enrolls its Agents. Also **not in the bundle: Etch itself or its per-machine config**, since it's a separately installed CLI you manage by hand. A restored Agent needs Etch reinstalled before chat or AI actions work — detection surfaces this rather than leaving you to discover it.

---

## 11. Logging

Two distinct streams, different retention:

| | Diagnostic | Audit |
|---|---|---|
| Content | Debug, errors, traces | Secret accessed, device enrolled, session opened |
| Storage | Local file, rotating | SQLite on the Hub |
| Retention | 1 week default | Durable, in the backup bundle |
| Shipping | Optional, to Hub (centralized features later) | Always Hub-side |

Structured JSON lines. **Explicit secret redaction is mandatory** — `glass run` must never write vault contents to disk.

---

## 12. Agent authority

Updates split by what they own: **Tauri's built-in updater** replaces the desktop UI shell and bundled runtime; the next launch stages that runtime outside the `.app`. Persistent **glassd** activates it by asking the supervisor to blue/green Agent, restarting Hub separately, and retaining sessiond. A Viewer restart is free because it reconnects and reattaches.

Provider permissions remain authoritative. Glass adds two narrower policy
layers, both tunable by the Hub owner; it never silently upgrades a provider's
permission mode.

| Layer | Applies to | Behavior |
|---|---|---|
| Action policy | All chat-driven commands | Desktop-side config of what is and isn't allowed to run |
| Voice filter | Speech-to-text flows only | Destructive actions are read back and require confirmation before executing |

Voice is held to a stricter standard than typed input on purpose — speech recognition misfires in ways typing does not, and the cost of a misheard destructive command is not recoverable.

---

## 13. Git hosting

The Hub optionally hosts git repositories centrally for all spokes. Two separable pieces:

1. **Update source (Phase 4):** the Hub tracks GitHub for its own updates. Minimal.
2. **Spoke project hosting (Phase 7):** bare repos served to spokes for your other projects — over **authenticated smart-HTTP on the Hub's existing TLS listener** (`/git/`, per-device tokens + per-repo ACLs), not SSH. Reusing the relay tunnel means no second exposed service and no sshd on the Hub.

Both are included in the backup bundle.

**Piece 2 is what eventually lets Forge be retired**, together with the vault (§9). Not a hard gate on anything — since there's no migration, Forge keeps serving its current role until you've moved what you care about by hand.

---

## 14. Build phases

### Phase 0 — Foundations
Monorepo, `protocol/` schemas, version negotiation, **process topology (§3)**, CI.
Topology is critical path — everything else can be added incrementally, this cannot.

### Phase 1 — Terminal over Hub
Hub + registry, Agent + PTY provider, desktop Viewer with panes. Tailnet only, auth stubbed.
→ **Done when:** from Studio, you run a shell on Pro.

### Phase 2 — Identity & reach
Enrollment with number matching, keypairs in Keychain, passkey login + password/TOTP fallback, Lightsail relay, TLS.
→ **Done when:** it works from the iPhone over cellular.

### Phase 3 — Vault & backup
Envelope encryption, secret CRUD, per-device allow-lists, tags, `glass run`, backup bundle.
→ **Done when:** no secrets remain in your dotfiles.

### Phase 4 — Self-update
Persistent app-independent backend, blue/green worker swap, deferred sessiond replacement, Hub→spoke distribution, N-1 compatibility, local git update source, skew banners at both ends. Live fd handoff remains a later hardening step.
→ **Done when:** an update lands mid-session and you don't notice.

### Phase 5 — Chat & voice
Baseline one-shot chat provider, then the shared PWA agent surface, STT/TTS,
push-to-talk, and Web Push. Phase 9 replaces the one-shot Etch path with its
persistent structured adapter; voice consumes the same normalized stream and
approval/clarification events.
→ **Done when:** you drive an agent by voice from your phone.

### Phase 6 — Browser proxy
SOCKS endpoint, managed profiles, per-profile isolation.
→ **Done when:** you browse from Pro with Studio's egress.

### Phase 7 — Git hosting for spokes
Bare repo serving, per-spoke access, backup integration.
→ **Done when:** a spoke clones and pushes a hosted repo with a stock git client, and the repo survives the backup drill.

### Phase 8 — Fleet reachability & distribution
Multi-listener Hub (loopback for the local viewer, TLS over the relay for spokes), fleet-wide session sync, self-serve number-match enrollment from the app, and desktop-app auto-update served by the Hub (minisign-signed, notarized, anti-rollback) with Hub→spoke skew banners.
→ **Done when:** a fresh Mac joins the fleet from the app alone, sees every device's sessions, and receives signed updates without anyone touching it.

### Phase 9: Multi-agent control plane

**M0: Etch integration contract (done).** In Etch, add a supported headless surface
launcher with a clean stdio contract and capability/version reporting. Add
Glass aliases to the content-safe terminal-status environment contract. Keep
the Etch module, session-lifecycle, and surface-contract docs/tests canonical;
do not make Glass import Etch internals.

**M1: durable runs and attention (done).** Add the provider-neutral run record,
workspace persistence, cwd-aware launch profiles, Agent Board, unified inbox,
content-safe status-file ingestion, and additive `run.*` list/control/status
messages with fleet-wide broadcasts. Prove many independent PTYs/runs across
devices survive Viewer and Agent replacement without status or layout leaking
between them.

**M2: Etch primary adapter (done).** Replace `etch -z` as the default with a
sessiond-owned Etch surface process. Negotiate the contract; implement
create/resume/activate/close, streaming, session info, model/provider/profile
selection, reasoning effort, command catalog, attachments, approvals, and
clarification. Preserve `-z` only for old Etch versions and label the reduced
capability explicitly.

**M3: Etch-native orchestration (done).** Add versioned optional Etch surface
capabilities for active sessions, subagent events/control, child-session
watching, scheduled/autonomous-run status, usage/cost, and worktree references.
Render them in Glass without copying transcripts, Lattice state, schedules, or
worktree policy. Etch remains the executor and source of truth.

**M4: Codex and Claude adapters (done).** Map Codex app-server and Claude's
structured/resumable CLI surfaces to the same run contract, with per-provider
capability negotiation and explicit reduced behavior. Run mixed-provider
concurrency, restart/reattach, approval-isolation, status-fencing, Etch
worktree-lock, privacy, and failure-injection harnesses across the two repos.

→ **Done when:** Etch is the default and exposes its native resume, input,
delegation, autonomy, and worktree capabilities through Glass; Etch, Codex, and
Claude can run concurrently across devices; every waiting agent is visible;
and a Viewer/Agent restart loses neither in-flight provider processes nor the
workspace used to supervise them.

**Shipped August 2026.** Etch M0–M3 landed in the Etch repository and the Glass
M1–M4 control plane is covered by `tests/p9m1-agent-runs.mjs` and
`tests/p9m2-mixed-providers.mjs`. The release-machine smoke in
`tests/provider-live-smoke.mjs` additionally drives installed Etch, Codex, and
Claude concurrently across an Agent replacement. Phase 5 voice and its focused
mobile chat UX remain separate work on this normalized streaming/input
contract.

**Build status lives in `CLAUDE.md` (“Current state”), which is updated as milestones land. As of Aug 2026: Phases 0–4 and 6–9 complete; Phase 5 still lacks voice and the focused PWA chat surface.**

---

## 15. Apple code signing

macOS refuses to run unsigned apps from other machines, so this is mandatory rather than optional. Two distinct steps: **signing** proves the app is yours, **notarization** is Apple scanning it and issuing a ticket Gatekeeper checks.

### Established

| | Value |
|---|---|
| Program | Apple Developer Program (paid), active |
| Signing identity | `Developer ID Application: Daniel Glassow (Z6ATGC7GNB)` |
| Team ID | `Z6ATGC7GNB` |
| Certificate type | Developer ID Application, **G2 Sub-CA** (expires 2031) |
| Intermediate | `Developer ID – G2` — installed manually; macOS only fetches these lazily via Xcode |
| Build machine | glaptop (holds the private key) |

Certificate type matters and the names are confusingly similar. **Developer ID Application** is for distribution outside the App Store — not "Apple Distribution" (App Store) and not "Apple Development" (local only). The G1 intermediate expires Feb 2027 regardless of issue date, so G2 is the only sensible choice.

### Notarization credentials

**Operational.** `packages/desktop/sign-and-notarize.sh` deep-signs the app inside-out (native addons → bundled node with JIT entitlements → app), notarizes app + dmg via the `glass-notary` notarytool Keychain profile, and staples both — no secrets appear in any command.

App Store Connect API key rather than Apple ID + app-specific password — independently revocable, scoped narrowly, and works in CI without embedding personal credentials.

| Artifact | Env var |
|---|---|
| Issuer ID | `APPLE_API_ISSUER` |
| Key ID | `APPLE_API_KEY` |
| `.p8` private key | `APPLE_API_KEY_PATH` |

Created under App Store Connect → Users and Access → Integrations, with **Developer** access. Stored at `~/.appstoreconnect/private_keys/`, which Tauri searches by default.

### Two rules

1. **The `.p8` downloads exactly once.** No recovery — a lost key is revoked and replaced.
2. **The certificate's private key cannot be re-downloaded from Apple.** It lives only in the build machine's keychain. Lose it and the certificate is dead; you generate a new CSR and start over. This is the practical argument for designating one release machine.

If releases ever move to CI, the certificate exports as a base64 `.p12` into `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` rather than repeating enrollment elsewhere.

---

## 16. The production gate

Before Glass is used for **any work beyond developing Glass**, a full step-by-step failure-mode simulation must pass. Not a Phase 3 blocker — a gate on real use.

Failure modes worth simulating:

- Hub Mac dies completely; restore to clean hardware
- Vault unlock after restore, using the supplied recovery key
- Spoke offline during a Hub move, reconnecting afterward
- Corrupted or partial backup bundle
- Update that fails validation and must roll back
- Build machine lost, taking the Developer ID private key with it
- Relay VPS unreachable
- TLS certificate expiry

An untested backup is not a backup. This gate protects everything built before it.
