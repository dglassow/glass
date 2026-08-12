#!/usr/bin/env bash
# Create the Terraform state backend (S3 bucket + DynamoDB lock table) before the
# first `terraform init`. Idempotent. Reads bucket/table/region from backend.hcl.
# Requires an active AWS session (aws sso login) with the glass profile.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${AWS_PROFILE:-glass}"
hcl() { grep -E "^\s*$1\s*=" backend.hcl | sed -E 's/.*=\s*"?([^"]+)"?.*/\1/' | tr -d '[:space:]'; }

BUCKET="$(hcl bucket)"
TABLE="$(hcl dynamodb_table)"
REGION="$(hcl region)"
[ -n "$BUCKET" ] && [ -n "$TABLE" ] && [ -n "$REGION" ] || { echo "backend.hcl missing bucket/dynamodb_table/region" >&2; exit 1; }

echo "bootstrap: bucket=$BUCKET table=$TABLE region=$REGION profile=$PROFILE"

if ! aws s3api head-bucket --bucket "$BUCKET" --profile "$PROFILE" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" --profile "$PROFILE"
fi
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled --profile "$PROFILE"
aws s3api put-bucket-encryption --bucket "$BUCKET" --profile "$PROFILE" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" --profile "$PROFILE" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

if ! aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE" --region "$REGION" --profile "$PROFILE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
fi
echo "bootstrap: state backend ready."
