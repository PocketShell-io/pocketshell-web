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

# One deploy at a time — concurrent runs pick the same changeset names and
# race each other into AlreadyExistsException (hit in practice).
exec 9>build/deploy.lock
flock -n 9 || { echo "another deploy.sh is already running" >&2; exit 1; }

REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
: "${REGION:=eu-west-1}"
STACK_NAME="pocketshell-web"
CERT_REGION="us-east-1"
DOMAIN_STACK_NAME="pocketshell-web-domain"

# The high-level `aws cloudformation deploy` is gone from this box's CLI
# (aws-cli 1.44 dropped the deploy/package customizations) — do its job with
# the raw changeset APIs: create → wait → skip when empty → execute → wait.
cfn_deploy() {
  local region="$1" stack="$2" template="$3"; shift 3
  local param_args=() p
  for p in "$@"; do
    param_args+=("ParameterKey=${p%%=*},ParameterValue=${p#*=}")
  done
  local cs="deploysh-$(date +%s)-$$"
  local type=UPDATE
  if ! aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
       --query Stacks[0].StackId --output text >/dev/null 2>&1; then
    type=CREATE
  fi
  aws cloudformation create-change-set --region "$region" \
    --stack-name "$stack" --change-set-name "$cs" --change-set-type "$type" \
    --template-body "file://$template" --capabilities CAPABILITY_IAM \
    ${param_args[@]+"${param_args[@]}"} >/dev/null
  aws cloudformation wait change-set-create-complete --region "$region" \
    --stack-name "$stack" --change-set-name "$cs" >&2
  if [ "$(aws cloudformation describe-change-set --region "$region" \
         --stack-name "$stack" --change-set-name "$cs" \
         --query HasChanges --output text)" = "false" ]; then
    echo "No changes to deploy. Stack $stack is up to date"
    aws cloudformation delete-change-set --region "$region" \
      --stack-name "$stack" --change-set-name "$cs" >/dev/null
    return 0
  fi
  aws cloudformation execute-change-set --region "$region" \
    --stack-name "$stack" --change-set-name "$cs" >/dev/null
  if [ "$type" = "CREATE" ]; then
    aws cloudformation wait stack-create-complete --region "$region" \
      --stack-name "$stack" >&2
  else
    aws cloudformation wait stack-update-complete --region "$region" \
      --stack-name "$stack" >&2
  fi
}

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

cfn_deploy "$REGION" "$STACK_NAME" template.yaml ${OVERRIDES[@]+"${OVERRIDES[@]}"}

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
  # request-certificate returns CertificateArn at the TOP level (unlike
  # describe-certificate's Certificate.* nesting) — a nested query silently
  # yields the literal "None" and poisons everything downstream.
  CERT_ARN="$(aws acm request-certificate --region "$CERT_REGION" \
    --domain-name pocketshell.io \
    --subject-alternative-names www.pocketshell.io \
    --validation-method DNS \
    --idempotency-token pocketshellweb \
    --query CertificateArn --output text)"
fi
case "$CERT_ARN" in
  arn:aws:acm:*) : ;; # looks like a certificate ARN
  *) echo "no usable certificate ARN: '$CERT_ARN'" >&2; exit 1 ;;
esac

# ACM publishes its validation CNAMEs a few seconds after the request, so
# this re-seeds on every pass while waiting; the UPSERT is idempotent and the
# records stay in the zone afterwards, which is also what keeps renewals free.
seed_validation_records() {
  aws acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
    --query "Certificate.DomainValidationOptions[].ResourceRecord" --output json |
  ZONE_ID="$ZONE_ID" python3 - <<'PYEOF'
import json, os, subprocess, sys
try:
    records = [r for r in json.load(sys.stdin) if r and r.get("Name") and r.get("Value")]
except json.JSONDecodeError:
    sys.exit(0)  # describe failed upstream; the caller's next pass retries
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

cfn_deploy "$REGION" "$DOMAIN_STACK_NAME" domain.yaml \
  "ZoneId=$ZONE_ID" \
  "CertificateArn=$CERT_ARN" \
  "OriginDistributionDomain=$(output_of "$STACK_NAME" CloudFrontDomain | sed 's|https://||')" \
  "OriginDistributionId=$(output_of "$STACK_NAME" SiteDistributionId)"

echo
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table
