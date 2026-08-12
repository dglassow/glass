#!/usr/bin/env bash
#
# Glass relay — Lightsail provisioning (Phase 2, plan §2/§14).
#
# Idempotent: safe to re-run at any time; it converges the instance, the
# static IP, and the firewall to the declared state. Run it after
# `aws sso login`; it refuses to start without live AWS credentials.
#
#   GLASS_RELAY_REGION=us-west-2 ./provision.sh
#
# Configuration is environment-only — NOTHING per-install is committed here
# (public repo, plan §4). Record the printed static IP in the backup bundle,
# never in this repo.
#
#   GLASS_RELAY_REGION      required   e.g. us-west-2
#   GLASS_RELAY_NAME        optional   instance name        (default glass-relay)
#   GLASS_RELAY_AZ          optional   availability zone    (default ${REGION}a)
#   GLASS_RELAY_BUNDLE      optional   size                 (default nano_3_0, $5/mo)
#   GLASS_RELAY_BLUEPRINT   optional   OS image             (default ubuntu_24_04)
#   GLASS_RELAY_ADMIN_CIDR  optional   extra CIDR allowed on 22 (e.g. 203.0.113.7/32)
#   GLASS_RELAY_KEYPAIR     optional   Lightsail key pair name for SSH
#
# List valid bundles/blueprints for your region with:
#   aws lightsail get-bundles / aws lightsail get-blueprints
set -euo pipefail

: "${GLASS_RELAY_REGION:?set GLASS_RELAY_REGION (e.g. us-west-2)}"
export AWS_REGION="$GLASS_RELAY_REGION"
export AWS_DEFAULT_REGION="$GLASS_RELAY_REGION"

NAME="${GLASS_RELAY_NAME:-glass-relay}"
AZ="${GLASS_RELAY_AZ:-${GLASS_RELAY_REGION}a}"
BUNDLE="${GLASS_RELAY_BUNDLE:-nano_3_0}"
BLUEPRINT="${GLASS_RELAY_BLUEPRINT:-ubuntu_24_04}"
ADMIN_CIDR="${GLASS_RELAY_ADMIN_CIDR:-}"
KEYPAIR="${GLASS_RELAY_KEYPAIR:-}"
IP_NAME="${NAME}-ip"
HERE="$(cd "$(dirname "$0")" && pwd)"

step() { printf '\n== %s\n' "$*"; }

step "preflight: AWS identity (SSO session must be active)"
if ! aws sts get-caller-identity --query Arn --output text; then
  echo "no live AWS credentials — run: aws sso login" >&2
  exit 1
fi

step "instance ${NAME} (${BUNDLE}, ${BLUEPRINT}, ${AZ})"
if aws lightsail get-instance --instance-name "$NAME" >/dev/null 2>&1; then
  echo "already exists — leaving it alone"
else
  create_args=(
    --instance-names "$NAME"
    --availability-zone "$AZ"
    --blueprint-id "$BLUEPRINT"
    --bundle-id "$BUNDLE"
    --user-data "file://${HERE}/cloud-init.sh"
  )
  if [ -n "$KEYPAIR" ]; then create_args+=( --key-pair-name "$KEYPAIR" ); fi
  aws lightsail create-instances "${create_args[@]}" >/dev/null
  echo "created; waiting for it to reach 'running'"
fi

for _ in $(seq 1 60); do
  state="$(aws lightsail get-instance-state --instance-name "$NAME" --query 'state.name' --output text)"
  if [ "$state" = "running" ]; then break; fi
  sleep 5
done
if [ "${state:-}" != "running" ]; then
  echo "instance did not reach 'running' within 5 minutes (state: ${state:-unknown})" >&2
  exit 1
fi
echo "state: running"

step "static IP ${IP_NAME}"
if ! aws lightsail get-static-ip --static-ip-name "$IP_NAME" >/dev/null 2>&1; then
  aws lightsail allocate-static-ip --static-ip-name "$IP_NAME" >/dev/null
  echo "allocated"
fi
attached_to="$(aws lightsail get-static-ip --static-ip-name "$IP_NAME" --query 'staticIp.attachedTo' --output text)"
if [ "$attached_to" != "$NAME" ]; then
  aws lightsail attach-static-ip --static-ip-name "$IP_NAME" --instance-name "$NAME" >/dev/null
  echo "attached to ${NAME}"
else
  echo "already attached"
fi
STATIC_IP="$(aws lightsail get-static-ip --static-ip-name "$IP_NAME" --query 'staticIp.ipAddress' --output text)"

step "firewall: exactly 443 (world) + 22 (lightsail-connect${ADMIN_CIDR:+ + ${ADMIN_CIDR}})"
# put-instance-public-ports REPLACES the whole rule set atomically — this is
# what makes the firewall declarative: the default port-80 rule is closed by
# omission, and re-running always converges to exactly these two rules.
ssh_rule='{"fromPort":22,"toPort":22,"protocol":"tcp","cidrListAliases":["lightsail-connect"]'
if [ -n "$ADMIN_CIDR" ]; then ssh_rule="${ssh_rule},\"cidrs\":[\"${ADMIN_CIDR}\"]"; fi
ssh_rule="${ssh_rule}}"
tls_rule='{"fromPort":443,"toPort":443,"protocol":"tcp","cidrs":["0.0.0.0/0"],"ipv6Cidrs":["::/0"]}'
aws lightsail put-instance-public-ports \
  --instance-name "$NAME" \
  --port-infos "[${tls_rule},${ssh_rule}]" >/dev/null
echo "applied"

step "done"
cat <<EOF

  static IP:  ${STATIC_IP}

  Next steps (manual, see README.md):
    1. DNS: point an A record for your relay hostname at ${STATIC_IP}.
       Record the hostname + IP in the BACKUP BUNDLE, never in this repo.
    2. SSH in (lightsail-connect in the console always works) and install
       Node.js >= 20, then deploy the relay per README.md + glass-relay.service.
    3. Run ./check.sh any time to verify nothing has drifted.
EOF
