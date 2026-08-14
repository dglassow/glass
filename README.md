# Glass

A unified client for running terminal sessions across your own machines, with a
chat surface for mobile.

One app, three roles. Any Mac can be a **Hub** (registry, auth, vault, relay,
update distribution, git hosting), every Mac is an **Agent** (hosts sessions),
and every device is a **Viewer** — a native app on macOS, a chat-only PWA
everywhere else.

Glass replaces Prism and supersedes Forge. Etch is a separate CLI that Glass
detects but does not manage.

## Status

Glass is deployed and running against real infrastructure. The load-bearing
design decision — sessions live in a daemon that survives updates, so shells
are never interrupted — is proven end-to-end, over the public internet, in a
signed desktop app.

What exists today:

- **Terminal sessions that survive everything.** `sessiond` owns the PTYs;
  the worker process above it is swapped blue/green (health-checked before the
  old one retires, instant rollback on failure) and crashes are recovered,
  all with shells running untouched and scrollback intact.
- **Real identity.** Ed25519 device keys with challenge/response admission,
  number-matching enrollment (self-serve from the app), and a WebAuthn passkey
  bootstrap for the very first device. The hub is fail-closed.
- **Reach from anywhere.** A dumb VPS relay running only stock `sshd`: the hub
  dials out and holds a reverse tunnel, TLS terminates *in the hub*, and spokes
  pin the hub's identity key with TLS-exporter channel binding — a
  TLS-terminating man-in-the-middle is refused even with a valid certificate.
  Terraform for the relay lives in `infra/lightsail/`.
- **An encrypted vault and backup.** Envelope encryption over SQLite,
  passphrase + offline recovery key (LUKS-style keyslots), per-device secret
  scoping, `glass run` env-only injection, and a single encrypted backup bundle
  that passes the wipe-and-restore drill.
- **Signed self-update, twice over.** Backend services update from SSH-signed
  git tags verified against a key pinned outside the repo (adversarially
  tested: config-injection RCE, TOCTOU tag swaps, symlink escapes and friends
  are all regression-covered). The desktop app updates via the Tauri updater
  served from the hub — minisign-signed, notarized, with a device-side
  anti-rollback floor.
- **A fleet, not a demo.** The hub listens on loopback for its local viewer and
  over the relay for spokes; every viewer sees every agent's sessions live.
  The hub pushes update-available banners to out-of-date spokes.
- **Chat sessions.** A `chat` session kind runs Etch non-interactively per
  message and rides the identical session protocol as a terminal.
- **Cross-device browsing.** A SOCKS5 exit on one device, an isolated browser
  profile on another: render locally, egress from the machine you choose. No
  pixel streaming.
- **Git hosting.** The hub serves bare repos to spokes over authenticated
  smart-HTTP on its existing TLS listener, with per-device tokens and ACLs;
  repos ride the backup bundle.
- **A real macOS app and a PWA.** `packages/desktop` builds a signed,
  notarized, self-contained Glass.dmg (bundled backend + portable node — no
  runtime dependencies) with a first-run role picker (Standalone / Hub /
  Spoke), a tiling session workspace, and customizable terminal appearance.
  The same viewer code, served by the hub over TLS, is an installable
  mobile PWA.

Verified by 19 adversarial test harnesses (`pnpm test`, all in CI), plus
red-team passes on the security-critical paths. Still ahead: the voice/chat
mobile surface (Phase 5 remainder), the sessiond-to-sessiond fd handoff, and
the full production-gate failure drill (`docs/plan.md` §16).

## Layout

```
packages/
  protocol/        the wire contract — everything depends on this, and on nothing else shared
  supervisor/      lifecycle tier: spawns/monitors sessiond + worker, blue/green swap, crash recovery
  sessiond/        owns PTYs and chat sessions; survives updates — the load-bearing tier
  hub/             registry, auth, vault, backup, relay tunnel, updater, update serving, git hosting, PWA serving
  agent/           worker: session routing, hub link, SOCKS proxy endpoint
  viewer/          shared web frontend — webview on desktop, installable PWA on mobile
  desktop/         Tauri v2 macOS shell (workspace-excluded; needs Rust on a Mac)
  backend-bundle/  meta-package that flattens hub/sessiond/agent into the .app's bundled backend
  cli/             glass run — secret injection with structural redaction
deploy/            per-role backend launcher + live-relay bring-up scripts
infra/lightsail/   Terraform for the relay VPS (stock sshd, zero Glass code)
tests/             19 acceptance/adversarial harnesses — the source of truth for what works
docs/              plan.md (architecture, authoritative) + open-questions.md
```

## Protocol

`@glass/protocol` is the contract between Hub, Agent, and Viewer. It is
deliberately the only shared dependency between them, so the three can be built
and changed independently.

Every frame is an `Envelope` — routing and version outside, meaning inside:

```ts
{ v, id, ts, from, to, replyTo?, body }
```

Message families:

| Family | Covers |
|---|---|
| `handshake` | `hello` / challenge / proof / ack — Ed25519 mutual auth, version negotiation, channel binding, Etch detection |
| `device` | number-matching enrollment, revocation, registry state |
| `session` | create, list, attach, input, output, resize, close, exit — plus fleet-wide created/exited broadcasts |
| `credential` | WebAuthn passkey registration and login |
| `vault` | authenticated machine retrieval of scoped secrets |
| `proxy` | per-connection SOCKS tunneling between devices |
| `system` | heartbeat, structured errors, update-available push |

### Versioning

`v` rides on every message, not just the handshake — a Hub mid-rollout can hold
connections from peers on two versions at once. The Hub speaks N-1 so a spoke
that was offline during a rollout can reconnect long enough to update. Two
versions behind is refused.

### Session kinds

`pty` and `chat`. Browsers are deliberately absent: they run locally and are
proxied, never streamed, so they are not sessions.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test        # all 19 harnesses; they spawn real processes and real git/tls
```

The desktop shell builds separately on a Mac (Rust required) — see
`packages/desktop/README.md`. Deployment against a real relay is documented in
`deploy/README.md`; provisioning the relay itself in `infra/lightsail/README.md`.

## Security

This repository is public and contains **no instance configuration**. Tunnel
keys, TLS certificates, device names, and secrets live only in gitignored
instance config and the encrypted backup bundle. (The one class of exception:
public relay/updater endpoints, which carry only ciphertext.)

Release tags are signed and verified by the updater before anything is applied
— against a key pinned outside the repo, treating the fetched repo itself as
attacker input. The updater runs code unattended on machines with full shell
access, so it is the most adversarially tested code in the project.
