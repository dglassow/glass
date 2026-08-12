# Glass

A unified client for running terminal sessions across your own machines, with a
chat surface for mobile.

One app, three roles. Any Mac can be a **Hub** (registry, auth, vault, relay),
every Mac is an **Agent** (hosts sessions), and every device is a **Viewer** —
a native app on macOS, a chat-only PWA everywhere else.

Glass replaces Prism and supersedes Forge. Etch is a separate CLI that Glass
detects but does not manage.

## Status

Phase 0. The protocol package is defined; nothing else is built yet.

## Layout

```
packages/
  protocol/     the wire contract — everything depends on this, and on nothing else shared
  supervisor/   lifecycle tier, rarely updated                     (not yet built)
  sessiond/     owns PTYs, survives updates                        (not yet built)
  hub/          registry, auth, vault, relay, update distribution  (not yet built)
  agent/        worker: session routing and providers              (not yet built)
  viewer/       shared web frontend — webview on desktop, PWA on mobile (not yet built)
  desktop/      Tauri shell                                        (not yet built)
  cli/          secret injection, enrollment                       (not yet built)
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
