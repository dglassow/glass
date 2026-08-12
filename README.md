# Glass

A unified client for running terminal sessions across your own machines, with a
chat surface for mobile.

One app, three roles. Any Mac can be a **Hub** (registry, auth, vault, relay),
every Mac is an **Agent** (hosts sessions), and every device is a **Viewer** —
a native app on macOS, a chat-only PWA everywhere else.

Glass replaces Prism and supersedes Forge. Etch is a separate CLI that Glass
detects but does not manage.

## Status

Phase 0 complete; Phase 1 milestones 1–3 done. `sessiond` owns PTYs over a Unix
socket, `agent` relays them, `hub` is a WebSocket registry+relay, and `viewer`
is the shared web frontend (xterm.js panes over the hub). The load-bearing
property is proven end-to-end — locally (`tests/m1-acceptance.mjs`), through the
hub (`tests/m2-acceptance.mjs`), and in the real viewer client
(`tests/m3-viewer.mjs`): kill and restart the worker and the shell survives with
scrollback intact, even output produced while no worker existed; the viewer
re-attaches on its own. Phase 2 milestone 1 adds real **device-key auth**: peers
prove key possession with an Ed25519 challenge/response and the hub admits only
enrolled devices, with number-matching enrollment (`tests/p2m1-auth.mjs`) and a
WebAuthn **passkey** bootstrap for the first device (`tests/p2m2-passkey.mjs`).
Phase 3 milestone 1 adds an encrypted **vault**: envelope encryption over
`node:sqlite`, per-device secret scoping, `glass run` secret injection, and an
encrypted **backup bundle** that survives the wipe-and-restore recovery drill
(`tests/p3m1-vault.mjs`, `tests/p3m2-backup.mjs`). 102 checks across seven suites,
all in CI. The xterm GUI bundles; the Tauri desktop
shell (`packages/desktop`) is scaffolded for a Mac build. `supervisor` is the
only remaining skeleton.

## Layout

```
packages/
  protocol/     the wire contract — everything depends on this, and on nothing else shared
  supervisor/   lifecycle tier, rarely updated                     (skeleton)
  sessiond/     owns PTYs, survives updates                        (M1: PTY over socket)
  hub/          registry, auth, vault, relay, update distribution  (M2: WS registry + relay)
  agent/        worker: session routing and providers              (M1 relay + M2 hub bridge)
  viewer/       shared web frontend — webview on desktop, PWA on mobile (M3: xterm panes over the hub)
  desktop/      Tauri shell                                        (M3 scaffold — build on a Mac)
  cli/          secret injection, enrollment                       (P3: glass run)
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
| `handshake` | `hello` / `hello.ack`, version negotiation, Etch detection |
| `device` | enrollment with verification codes, revocation, registry state |
| `session` | create, list, attach, input, output, resize, close, exit |
| `system` | heartbeat, structured errors |

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
```

## Security

This repository is public and contains **no instance configuration**. Relay
hostnames, tunnel keys, TLS certificates, device names, and secrets live only in
the encrypted backup bundle.

Release tags are signed and verified by the updater before anything is applied.
The updater runs code unattended on machines with full shell access, so an
unsigned tag is not installed.
