#!/usr/bin/env bash
# Package and deploy the pocketshell-web stacks (sandbox account).
#
# Usage:
#   ./deploy.sh                                # zone + site + pocketshell.io
#                                              # custom domain (cert, aliases,
#                                              # Route53 records) + bridge
#   GOOGLE_WEB_CLIENT_ID=<id> ./deploy.sh      # add the pocketshell.io web
#                                              # client to accepted audiences
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
: "${REGION:=eu-west-1}"
STACK_NAME="pocketshell-web"
CERT_REGION="us-east-1"
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

ZONE_ID="$(output_of "$STACK_NAME" ZoneId)"

# ---- Certificate (ACM us-east-1, owned by this script, not CloudFormation) -
# A AWS::CertificateManager::Certificate resource inside a stack deadlocks on
# first create: it blocks the stack until DNS validation succeeds, while the
# in-stack helper that would write the validation CNAMEs cannot run until the
# stack's resources exist. So deploy.sh drives ACM directly: find-or-request,
# mirror the validation CNAMEs into the zone ourselves, wait for ISSUED.
find_cert_arn() {
  aws acm list-certificates --region "$CERT_REGION" \
    --query "CertificateSummaryList[?DomainName=='pocketshell.io'].CertificateArn" \
    --output text | head -n1
}

CERT_ARN="$(find_cert_arn)"
if [ -z "$CERT_ARN" ]; then
  echo "Requesting ACM certificate for pocketshell.io"
  CERT_ARN="$(aws acm request-certificate --region "$CERT_REGION" \
    --domain-name pocketshell.io \
    --subject-alternative-names www.pocketshell.io \
    --validation-method DNS \
    --idempotency-token pocketshell-web \
    --query Certificate.CertificateArn --output text)"
fi

# ACM publishes its validation CNAMEs a few seconds after the request, so
# this re-seeds on every pass while waiting; the UPSERT is idempotent and the
# records stay in the zone afterwards, which is also what keeps renewals free.
seed_validation_records() {
  aws acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
    --query "Certificate.DomainValidationOptions[].ResourceRecord" --output json |
  ZONE_ID="$ZONE_ID" python3 - <<'PYEOF'
import json, os, subprocess, sys
records = [r for r in json.load(sys.stdin) if r and r.get("Name") and r.get("Value")]
if not records:
    sys.exit(0)  # ACM has not published the options yet; the caller retries
changes = [{"Action": "UPSERT",
            "ResourceRecordSet": {"Name": r["Name"], "Type": "CNAME", "TTL": 300,
                                  "ResourceRecords": [{"Value": r["Value"]}]}}
           for r in records]
subprocess.run(["aws", "route53", "change-resource-record-sets",
                "--hosted-zone-id", os.environ["ZONE_ID"],
                "--change-batch", json.dumps({"Changes": changes})],
               check=True, stdout=subprocess.DEVNULL)
print(f"seeded {len(records)} validation CNAME(s) into the zone")
PYEOF
}

echo "Waiting for certificate issuance: $CERT_ARN"
status="PENDING_VALIDATION"
for attempt in $(seq 1 60); do
  status="$(aws acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
    --query Certificate.Status --output text 2>/dev/null || echo UNKNOWN)"
  [ "$status" = "ISSUED" ] && break
  seed_validation_records || true
  sleep 30
done
[ "$status" = "ISSUED" ] || { echo "certificate still $status after ~30 min" >&2; exit 1; }

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

echo
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table
