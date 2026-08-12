# Deploy

## `relay-smoke.mjs` — prove the live relay end-to-end

Stands up the hub + reverse tunnel on this machine and connects a spoke **through
the public Lightsail relay** (`18.216.57.165:443`), then drives an actual shell
on the spoke from a viewer — validating the whole path over the real internet:

```
viewer / spoke  --wss:443-->  relay sshd  --reverse tunnel-->  hub (TLS terminates here)
                              (only ciphertext)                 hub-key mutual auth + channel binding
```

```bash
node deploy/relay-smoke.mjs          # brings it all up, runs a shell, tears down
node deploy/relay-smoke.mjs --keep   # leave hub + tunnel + spoke running
```

All key material is generated into `config/local/deploy/` (gitignored). Nothing
secret is committed. Requires a live SSO session only if you need to (re)create
the relay; the smoke itself just needs the relay running and
`config/local/tunnel_ed25519` present.

## Real multi-machine deployment

The smoke bundles every role on one machine for the proof. In real use they
split across your devices:

1. **Hub Mac** — runs the hub + the reverse tunnel, persistently:
   - `hub --listen 127.0.0.1:<port> --trust-store <path> --hub-key <path> --tls-cert <crt> --tls-key <key>`
     (add `--vault`, `--git-root`, `--cred-store` as needed). It prints its
     **identity key** — pin that on every spoke.
   - keep the tunnel up: `hub tunnel -- ssh -NT -o ExitOnForwardFailure=yes
     -o ServerAliveInterval=15 -i config/local/tunnel_ed25519
     -R 0.0.0.0:443:127.0.0.1:<port> tunnel@18.216.57.165`
   - Persist both with launchd so they survive reboots.
2. **Spoke Macs** — `agent --hub wss://<relay-host>:443 --hub-key <pinned> …`.
   Enroll each once (number-matching) or add via `hub trust add`.
3. **Mobile / other browsers (PWA)** — a self-signed hub cert is fine for the
   native spoke (it pins the hub key), but a browser/PWA needs a **real cert**:
   point a DNS `A` record at `18.216.57.165`, issue a Let's Encrypt cert via
   **DNS-01** (the relay never touches issuance), add CAA records, and run the
   hub with that cert. Put the relay hostname only in the hub's instance config
   + the backup bundle — never in this repo.

`FileTrustStore` reads its file once at startup, so add devices **before**
starting the hub (or restart it after enrolling).
