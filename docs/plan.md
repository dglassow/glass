# Glass — architecture & execution plan

Companion to `open-questions.md` (the running tracker). This is the settled shape and the build order.

---

## 0. What Glass replaces

Glass is a **ground-up rebuild**, not an evolution of existing projects. It consolidates:

| Existing | Fate |
|---|---|
| Prism (terminal broker) | **Replaced.** No architecture carried forward. Still useful as reference — it proved the PTY-over-WebSocket pattern works. |
| Forge (git + secrets) | **Deprecated eventually, not migrated.** Glass starts clean — no importer. The two coexist; you re-add repos and secrets to Glass as you need them, and retire Forge once what's left on it stops mattering. Migration tooling stays possible later if the manual path proves annoying. |
| Etch (terminal app) | **Stays separate, and manually managed.** A CLI you install and update yourself on each Agent — Glass does not distribute it. Two invocation modes: interactive inside a PTY (zero integration), and programmatic as a subprocess for AI-enabled actions. |

Phase 1 is therefore greenfield. More work up front than refactoring Prism would have been, but it avoids inheriting single-Mac assumptions.

---

## 1. The core abstraction: sessions

A **session** is anything long-lived running on an Agent, streamed to a Viewer. Shared lifecycle — `create`, `attach`, `stream`, `detach`, `kill` — one routing path, one auth model.

| Provider | Backed by | Notes |
|---|---|---|
| Terminal | `node-pty` | Same lib as VS Code's terminal. Built fresh — see §0. Running Etch inside one requires no special handling; it's a program like any other. |
| Chat | Etch, invoked as a subprocess | Glass runs Etch non-interactively per message and renders the result conversationally. No service, no API, no callback. |

New capability = new provider. Nothing around it changes.

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

The PWA is strictly a chat interface — claude.ai-shaped. It runs terminal commands *through* the chat provider, which interprets and returns results as conversation. It is not a terminal emulator.

**WebKit is a first-class target, not a fallback.** Every browser on iOS uses WebKit, including installed PWAs — so iPhone support means Safari-engine support. Audio capture, Web Push, and storage behavior must all work there from the start.

---

## 3. Process topology

**Decided in Phase 0. Retrofitting this later is a rewrite.**

| Tier | Contains | Update cadence |
|---|---|---|
| Supervisor | Lifecycle only | Almost never |
| Worker | Protocol, routing, UI serving, vault | Frequently, blue/green |
| Session daemon | Live PTY file descriptors | Rarely |

Sessions do not live in the tier that gets updated. Most updates swap the worker while shells run untouched. When the daemon itself must change, live fds pass between processes over a Unix socket (`SCM_RIGHTS`) — the nginx graceful-reload technique. Non-fd state (scrollback, in-flight agent tasks) serializes to disk and rehydrates.

---

## 4. Updates

- Self-updating, in place, no user interruption. Background by default.
- Blue/green worker swap; old worker drains, new worker accepts.
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
- **Glass detects Etch rather than managing it.** Each Agent reports whether Etch is present and at what version, surfaced in the device list. Removes the silent-failure mode without Glass taking ownership of a dependency it doesn't control.
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

---

## 7. Browser

**No pixel streaming.** Each device uses its real local browser.

Optional: **traffic proxying**. A device runs a SOCKS5 endpoint over the existing tunnel; the app launches a browser profile with `--proxy-server` pointed at it. You render and interact locally, but egress happens from the chosen device. Proxied profiles stay fully separate from normal browsing — distinct profile, distinct cookie jar, distinct window.

Built in Phase 6: the SOCKS5 exit + `proxy.*` tunneling live in `agent/src/proxy/`, and the desktop shell launches the isolated proxied profile.

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

## 12. Chat agent authority

Updates split by what they own: **Tauri's built-in updater** handles the desktop UI shell (a restart is free — sessions live in the daemon and you reattach), while the **supervisor** handles background services with the blue/green handoff.

**Two layers of chat authority, both tunable by the Hub owner.**

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
Blue/green worker swap, fd handoff, Hub→spoke distribution, N-1 compatibility, local git update source, skew banners at both ends.
→ **Done when:** an update lands mid-session and you don't notice.

### Phase 5 — Chat & voice
Chat provider over PTY, PWA chat surface, STT/TTS, push-to-talk, Web Push.
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

**Build status lives in `CLAUDE.md` (“Current state”), which is updated as milestones land. As of Aug 2026: Phases 0–4, 6–8 complete; Phase 5 has the chat provider but not voice or the PWA chat surface.**

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
