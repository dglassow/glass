#!/usr/bin/env bash
# terraform wrapper. Terraform 1.5's S3 backend uses an older AWS SDK that can't
# read the modern SSO `sso_session` profile format, so we hand it short-lived
# credentials exported from the active SSO session instead.
#
# Usage:  ./tf.sh plan            (AWS_PROFILE defaults to glass)
#         ./tf.sh apply -var-file=... etc.
# Requires a live SSO session first:  aws sso login --sso-session mwarfare
set -euo pipefail
cd "$(dirname "$0")"
PROFILE="${AWS_PROFILE:-glass}"

if ! aws sts get-caller-identity --profile "$PROFILE" >/dev/null 2>&1; then
  echo "No valid session for profile '$PROFILE'. Run: aws sso login --sso-session mwarfare" >&2
  exit 1
fi
eval "$(aws configure export-credentials --profile "$PROFILE" --format env)"
exec terraform "$@"
