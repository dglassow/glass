# Deploy

Three scripts, three jobs. All key material they generate lands in gitignored
`config/local/`; nothing secret is committed. The relay's public address is
instance config — it appears here as `<relay>`; the deployed value lives in the
scripts' `RELAY_IP` constant and the hub's instance config.

## `glass-backend.mjs` — the per-role backend the app runs

The desktop app spawns this with `--role standalone|hub|spoke`; it brings up
and supervises the right processes, prints one `GLASS_BACKEND_READY <json>`
line, then stays up (reaping children on SIGTERM):

- **standalone** — local OPEN ws hub + sessiond + agent, all loopback, no
  auth/TLS (so the webview connects over `ws://` with no cert problem).
- **hub** — local TRUST ws hub (auto-trusts the app's own viewer device) +
  sessiond + agent; prints the hub identity key for spokes to pin. With TLS
  config present it also listens for remote spokes over the relay (Phase 8
  multi-listener).
- **spoke** — sessiond + agent joining a remote hub (`HUB_URL`/`HUB_PIN`).

It resolves service entry points from the dev repo when run there, or from the
bundled layout inside Glass.app, and writes state to `~/.glass` (never inside
the read-only .app).

## `relay-smoke.mjs` — prove the live relay end-to-end

Stands up the hub + reverse tunnel on this machine and connects a spoke
**through the public relay**, then drives an actual shell on the spoke from a
viewer — validating the whole path over the real internet:

```
viewer / spoke  --wss:443-->  relay sshd  --reverse tunnel-->  hub (TLS terminates here)
                              (only ciphertext)                 hub-key mutual auth + channel binding
```

```bash
node deploy/relay-smoke.mjs          # brings it all up, runs a shell, tears down
node deploy/relay-smoke.mjs --keep   # leave hub + tunnel + spoke running
```

Requires the relay running (see `infra/lightsail/`) and
`config/local/tunnel_ed25519` present; an AWS session is only needed to
(re)create the relay itself.

## `hub-live.mjs` — persistent hub behind the relay

Brings up a hub with a stable identity + trust store, the reverse tunnel, and
an agent, and trusts a viewer device passed via `VIEWER_ID`/`VIEWER_PUB` — so
Glass.app can enter the printed url+pin and get a real shell through the live
relay. Stays running; kill to stop. Keys live in gitignored
`config/local/live/`.

## Real multi-machine deployment

The smoke bundles every role on one machine for the proof. In real use they
split across your devices:

1. **Hub Mac** — runs the hub + the reverse tunnel, persistently:
   - `hub --listen 127.0.0.1:<port> --trust-store <path> --hub-key <path> --tls-cert <crt> --tls-key <key>`
     (add `--vault`, `--git-root`, `--cred-store`, `--web-root` as needed). It
     prints its **identity key** — pin that on every spoke.
   - keep the tunnel up: `hub tunnel -- ssh -NT -o ExitOnForwardFailure=yes
     -o ServerAliveInterval=15 -i config/local/tunnel_ed25519
     -R 0.0.0.0:443:127.0.0.1:<port> tunnel@<relay>`
   - Persist both with launchd so they survive reboots. (Or run the app in the
     Hub role, which supervises all of it.)
2. **Spoke Macs** — install Glass.app, pick Spoke, enter the hub url + pin, and
   enroll via number matching — or headless:
   `agent --hub wss://<relay>:443 --hub-key <pinned> …` after `hub trust add`.
3. **Mobile / other browsers (PWA)** — a self-signed hub cert is fine for the
   native spoke (it pins the hub key), but a browser/PWA needs a **real cert**:
   point a DNS `A` record at the relay, issue a Let's Encrypt cert via
   **DNS-01** (the relay never touches issuance), add CAA records, run the hub
   with that cert and `--web-root` pointing at the viewer's web build, then on
   the phone: Safari → the hub URL → Add to Home Screen. Keep the hostname in
   the hub's instance config + the backup bundle, not in this repo.

`FileTrustStore` reads its file once at startup, so add devices **before**
starting the hub (or restart it after enrolling).
