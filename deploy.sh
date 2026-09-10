#!/usr/bin/env bash
# Package and deploy the pocketshell-web stacks (sandbox account).
#
# Usage:
#   ./deploy.sh                                # zone + site on the
#                                              # cloudfront.net URL + bridge
#   ENABLE_CUSTOM_DOMAIN=true ./deploy.sh      # after GoDaddy NS delegation:
#                                              # cert, aliases, Route53 records
#   GOOGLE_WEB_CLIENT_ID=<id> ./deploy.sh      # add the pocketshell.io web
#                                              # client to accepted audiences
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
: "${REGION:=eu-west-1}"
STACK_NAME="pocketshell-web"
CERT_REGION="us-east-1"
CERT_STACK_NAME="pocketshell-web-cert"
DOMAIN_STACK_NAME="pocketshell-web-domain"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="pocketshell-web-deploy-${ACCOUNT_ID}-${REGION}"

# ---- Package the bridge Lambda (ssh2 must ship in the zip) ---------------
mkdir -p build lambda/node_modules
if [ ! -d lambda/node_modules/ssh2 ]; then
  (cd lambda && npm ci --omit=dev)
fi
rm -f build/bridge.zip
python3 - <<'EOF'
import os, shutil
os.chdir("lambda")
shutil.make_archive("../build/bridge", "zip", root_dir=".")
EOF

if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION"
fi
aws s3 cp build/bridge.zip "s3://$BUCKET/$STACK_NAME/bridge.zip"

# ---- Parameters -----------------------------------------------------------
OVERRIDES=()
if [ -n "${GOOGLE_WEB_CLIENT_ID:-}" ]; then
  # Desktop client + web client, both accepted as token audiences.
  OVERRIDES+=("GoogleClientIds=1035162854462-nos4fptbf2psbkp8ljd8tjem1psnekvt.apps.googleusercontent.com,$GOOGLE_WEB_CLIENT_ID")
fi

output_of() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey==\`$2\`].OutputValue" --output text
}

DEPLOY_ARGS=(
  --region "$REGION"
  --stack-name "$STACK_NAME"
  --template-file template.yaml
  --capabilities CAPABILITY_IAM
  --no-fail-on-empty-changeset
)
if [ "${#OVERRIDES[@]}" -gt 0 ]; then
  DEPLOY_ARGS+=(--parameter-overrides "${OVERRIDES[@]}")
fi
aws cloudformation deploy "${DEPLOY_ARGS[@]}"

if [ "${ENABLE_CUSTOM_DOMAIN:-false}" = "true" ]; then
  ZONE_ID="$(output_of "$STACK_NAME" ZoneId)"

  aws cloudformation deploy \
    --region "$CERT_REGION" \
    --stack-name "$CERT_STACK_NAME" \
    --template-file cert.yaml \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides "ZoneId=$ZONE_ID"
  CERT_ARN="$(aws cloudformation describe-stacks --region "$CERT_REGION" \
    --stack-name "$CERT_STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`CertArn`].OutputValue' --output text)"
  echo "Waiting for certificate issuance: $CERT_ARN"
  aws acm wait certificate-validated --region "$CERT_REGION" --certificate-arn "$CERT_ARN"

  aws cloudformation deploy \
    --region "$REGION" \
    --stack-name "$DOMAIN_STACK_NAME" \
    --template-file domain.yaml \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
      "ZoneId=$ZONE_ID" \
      "CertificateArn=$CERT_ARN" \
      "OriginDistributionDomain=$(output_of "$STACK_NAME" CloudFrontDomain | sed 's|https://||')" \
      "OriginDistributionId=$(output_of "$STACK_NAME" SiteDistributionId)"
fi

echo
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table
