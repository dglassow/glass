#!/usr/bin/env bash
#
# Glass relay — teardown. Deletes the instance and RELEASES the static IP
# (a static IP left allocated but detached bills hourly).
#
# Destructive; requires an explicit --yes. The relay holds no state worth
# backing up — everything per-install lives in the backup bundle already.
#
#   GLASS_RELAY_REGION=us-west-2 ./teardown.sh --yes
set -euo pipefail

: "${GLASS_RELAY_REGION:?set GLASS_RELAY_REGION (e.g. us-west-2)}"
export AWS_REGION="$GLASS_RELAY_REGION"
export AWS_DEFAULT_REGION="$GLASS_RELAY_REGION"
NAME="${GLASS_RELAY_NAME:-glass-relay}"
IP_NAME="${NAME}-ip"

if [ "${1:-}" != "--yes" ]; then
  echo "This deletes instance '${NAME}' and releases static IP '${IP_NAME}'." >&2
  echo "Spokes lose off-tailnet reach until you re-provision (new IP => DNS update)." >&2
  echo "Run again with --yes to proceed." >&2
  exit 1
fi

if aws lightsail get-instance --instance-name "$NAME" >/dev/null 2>&1; then
  aws lightsail delete-instance --instance-name "$NAME" >/dev/null
  echo "deleted instance ${NAME}"
else
  echo "instance ${NAME} not found — skipping"
fi

if aws lightsail get-static-ip --static-ip-name "$IP_NAME" >/dev/null 2>&1; then
  aws lightsail release-static-ip --static-ip-name "$IP_NAME" >/dev/null
  echo "released static IP ${IP_NAME}"
else
  echo "static IP ${IP_NAME} not found — skipping"
fi

echo "done. Remember to remove/repoint the DNS record for the old IP."
