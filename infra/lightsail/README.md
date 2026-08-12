# Glass relay (Lightsail) — infra-as-code

A stock Amazon Linux Lightsail box running only `sshd`. The hub dials **out** and
holds a reverse forward of the box's `:443` down to the hub's local TLS listener
(`ssh -NT -R 0.0.0.0:443:127.0.0.1:<hub-tls-port> tunnel@<relay>`), so:

- the VPS runs **zero Glass code** and only ever sees ciphertext;
- there is exactly one hub, so `sshd` just forwards `:443` verbatim — no routing;
- a compromised VPS can drop traffic (DoS) but cannot read or MITM it — TLS
  terminates in the hub, and spokes pin the hub's Ed25519 identity key (mutual
  auth + TLS channel binding), so even a valid-cert interceptor is refused.

**No secrets live in this repo.** The relay hostname, the tunnel SSH key, and the
TLS cert/key live only in the hub's instance config and the encrypted backup
bundle (plan §4/§10).

## Apply (under your own AWS SSO session)

Nothing here runs automatically — you apply it with your own credentials. The
account-specific bits (state bucket name, tunnel pubkey) live in **gitignored**
files, never in this repo.

```bash
# 0. Log into your Identity Center session (profile assumes an admin role):
aws sso login --sso-session <your-sso-session>

# 1. Point the backend at your account (copy the template, fill in the bucket):
cp backend.hcl.example backend.hcl        # gitignored; bucket = glass-tfstate-<ACCOUNT_ID>

# 2. Create the state backend once (S3 bucket + DynamoDB lock table). Idempotent:
AWS_PROFILE=<your-profile> ./bootstrap.sh

# 3. The hub's dedicated tunnel key (generate once, keep the PRIVATE key on the
#    hub — e.g. config/local/, which is gitignored). The pubkey is auto-loaded
#    for terraform via a gitignored *.auto.tfvars:
ssh-keygen -t ed25519 -f ../../config/local/tunnel_ed25519 -N "" -C glass-hub-tunnel
printf 'tunnel_ssh_pubkey = "%s"\n' "$(cat ../../config/local/tunnel_ed25519.pub)" > tunnel.auto.tfvars

# 4. Init + apply. ./tf.sh wraps terraform to feed it short-lived SSO creds
#    (terraform 1.5's S3 backend can't read the modern sso_session profile):
AWS_PROFILE=<your-profile> terraform init -backend-config=backend.hcl
AWS_PROFILE=<your-profile> ./tf.sh plan
AWS_PROFILE=<your-profile> ./tf.sh apply
# note the output relay_ip
```

## After apply

1. Point a DNS A record (e.g. `relay.<your-domain>`) at `relay_ip`. Put that
   hostname **only** in the hub's instance config + backup bundle, never here.
2. On the hub, issue a Let's Encrypt cert for that hostname via **DNS-01** (the
   VPS never touches issuance) and add CAA records
   (`accounturi` + `validationmethods=dns-01`, RFC 8657) so the VPS cannot mint a
   cert even if it is compromised.
3. Run the hub with `--tls-cert --tls-key --hub-key <hub-key.json>` and keep the
   tunnel up with `hub tunnel -- ssh -NT -o ExitOnForwardFailure=yes
   -o ServerAliveInterval=15 -R 0.0.0.0:443:127.0.0.1:<hub-tls-port>
   tunnel@relay.<your-domain>`.
4. Pin the hub's public key (printed at hub startup) in each spoke's config.

`AWS_PROFILE=<your-profile> ./tf.sh destroy` tears it all down.
