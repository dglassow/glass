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

Nothing here runs automatically — you apply it with your credentials to account
`446121093838`:

```bash
aws sso login --profile <your-profile>        # your session, not mine
export AWS_PROFILE=<your-profile>

# The hub's dedicated tunnel key (generate once, keep the private key on the hub):
ssh-keygen -t ed25519 -f ~/.glass/tunnel_key -N "" -C glass-tunnel

cd infra/lightsail
terraform init
terraform apply -var="tunnel_ssh_pubkey=$(cat ~/.glass/tunnel_key.pub)"
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

`terraform destroy` tears it all down.
