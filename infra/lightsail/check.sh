#!/usr/bin/env bash
#
# Glass relay — drift + reachability probe. Exit 0 = everything as declared.
#
# This is the stand-in for Terraform's plan/drift detection, and it doubles as
# the plan §16 drill probe ("Relay VPS unreachable", "TLS certificate expiry").
#
#   Infra checks (need only an SSO session):
#     - instance exists and is running
#     - static IP allocated AND attached (a detached static IP bills hourly)
#     - firewall is exactly {443 world, 22 restricted} — port 80 closed
#
#   Live end-to-end checks (need DNS + the deployed relay + the hub tunnel;
#   run only when GLASS_RELAY_HOST is set):
#     - TCP 443 reachable
#     - the TLS certificate presented THROUGH the relay is valid for more than
#       GLASS_CERT_MIN_DAYS (default 21). With TLS passthrough the cert served
#       is the HUB's, so this one probe proves relay + tunnel + hub end-to-end.
#
#   GLASS_RELAY_REGION   required
#   GLASS_RELAY_NAME     optional (default glass-relay)
#   GLASS_RELAY_HOST     optional — relay hostname; enables the live checks.
#                        Comes from your backup bundle config, NOT this repo.
#   GLASS_CERT_MIN_DAYS  optional (default 21)
set -uo pipefail

: "${GLASS_RELAY_REGION:?set GLASS_RELAY_REGION (e.g. us-west-2)}"
export AWS_REGION="$GLASS_RELAY_REGION"
export AWS_DEFAULT_REGION="$GLASS_RELAY_REGION"
NAME="${GLASS_RELAY_NAME:-glass-relay}"
IP_NAME="${NAME}-ip"
HOST="${GLASS_RELAY_HOST:-}"
MIN_DAYS="${GLASS_CERT_MIN_DAYS:-21}"

fail=0
ok()  { printf '  PASS  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }

echo "== infra (region ${GLASS_RELAY_REGION})"

state="$(aws lightsail get-instance-state --instance-name "$NAME" \
  --query 'state.name' --output text 2>/dev/null)"
if [ "$state" = "running" ]; then ok "instance ${NAME} is running"
else bad "instance ${NAME}: state '${state:-absent}' (expected running)"; fi

attached="$(aws lightsail get-static-ip --static-ip-name "$IP_NAME" \
  --query 'staticIp.attachedTo' --output text 2>/dev/null)"
if [ "$attached" = "$NAME" ]; then ok "static IP ${IP_NAME} attached"
elif [ -z "$attached" ] || [ "$attached" = "None" ]; then
  bad "static IP ${IP_NAME} missing or DETACHED (detached static IPs bill hourly)"
else bad "static IP ${IP_NAME} attached to '${attached}' (expected ${NAME})"; fi

ports="$(aws lightsail get-instance-port-states --instance-name "$NAME" \
  --query 'portStates[].fromPort' --output text 2>/dev/null | tr '\t' '\n' | sort -n | xargs)"
if [ "$ports" = "22 443" ]; then ok "firewall open ports are exactly 22 and 443"
else bad "firewall open ports are '${ports:-none}' (expected exactly '22 443')"; fi

open443="$(aws lightsail get-instance-port-states --instance-name "$NAME" \
  --query "portStates[?fromPort==\`443\`].cidrs[]" --output text 2>/dev/null | xargs)"
if [ "$open443" = "0.0.0.0/0" ]; then ok "443 is world-reachable (0.0.0.0/0)"
else bad "443 cidrs are '${open443:-none}' (expected 0.0.0.0/0)"; fi

ssh_cidrs="$(aws lightsail get-instance-port-states --instance-name "$NAME" \
  --query "portStates[?fromPort==\`22\`].cidrs[]" --output text 2>/dev/null | xargs)"
if [ "$ssh_cidrs" = "" ] || [ "$ssh_cidrs" = "None" ]; then
  ok "22 has no world CIDR (lightsail-connect alias only)"
else
  case "$ssh_cidrs" in
    *0.0.0.0/0*) bad "22 is open to the WORLD (0.0.0.0/0) — restrict it" ;;
    *) ok "22 restricted to: ${ssh_cidrs}" ;;
  esac
fi

if [ -z "$HOST" ]; then
  echo "== live checks skipped (set GLASS_RELAY_HOST to enable — value lives in your backup bundle)"
else
  echo "== live (${HOST})"
  if nc -z -w 5 "$HOST" 443 2>/dev/null; then ok "tcp ${HOST}:443 reachable"
  else bad "tcp ${HOST}:443 unreachable — §16 'relay unreachable' drill condition"; fi

  end_date="$(echo | openssl s_client -connect "${HOST}:443" -servername "$HOST" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [ -z "$end_date" ]; then
    bad "no TLS certificate presented through the relay (tunnel down, or hub not serving TLS)"
  else
    # macOS (BSD date) first, GNU date fallback.
    end_s="$(date -j -f '%b %e %T %Y %Z' "$end_date" +%s 2>/dev/null || date -d "$end_date" +%s 2>/dev/null)"
    now_s="$(date +%s)"
    if [ -z "$end_s" ]; then
      bad "could not parse certificate end date: ${end_date}"
    else
      days=$(( (end_s - now_s) / 86400 ))
      if [ "$days" -ge "$MIN_DAYS" ]; then ok "hub certificate valid for ${days} more days"
      else bad "hub certificate expires in ${days} days (< ${MIN_DAYS}) — renew now (§16)"; fi
    fi
  fi
fi

exit "$fail"
