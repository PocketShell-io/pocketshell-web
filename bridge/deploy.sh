#!/usr/bin/env bash
# Package the bridge Lambda and deploy the `pocketshell-web` stack
# (sandbox account, eu-west-1): zone, site bucket + CloudFront, bridge.
#
# Usage:
#   ./deploy.sh                                # package + deploy the stack
#   GOOGLE_WEB_CLIENT_ID=<id> ./deploy.sh      # add the pocketshell.io web
#                                              # client to accepted audiences
#
# The app.pocketshell.io custom domain (us-east-1 ACM certificate + the
# `pocketshell-web-domain` stack) is infra and lives in aws-infra
# sandbox/pocketshell-web/deploy-domain.sh; it reads this stack's outputs.
# Run it after this script only when the site distribution or zone changed.
set -euo pipefail
cd "$(dirname "$0")"

# One deploy at a time — concurrent runs pick the same changeset names and
# race each other into AlreadyExistsException (hit in practice).
mkdir -p build  # a fresh checkout has no build/ yet; the lock lives there
exec 9>build/deploy.lock
flock -n 9 || { echo "another deploy.sh is already running" >&2; exit 1; }

REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
: "${REGION:=eu-west-1}"
STACK_NAME="pocketshell-web"

# The high-level `aws cloudformation deploy` is gone from this box's CLI
# (aws-cli 1.44 dropped the deploy/package customizations) — do its job with
# the raw changeset APIs: create → wait → skip when empty → execute → wait.
cfn_deploy() {
  local region="$1" stack="$2" template="$3"; shift 3
  local param_args=() p v
  # aws-cli v1 shorthand splits values on commas, so a value like the
  # comma-delimited GoogleClientIds list must carry embedded quotes.
  for p in "$@"; do
    v="${p#*=}"
    case "$v" in
      *,*) param_args+=("ParameterKey=${p%%=*},ParameterValue='$v'") ;;
      *)   param_args+=("ParameterKey=${p%%=*},ParameterValue=$v") ;;
    esac
  done
  local cs="deploysh-$(date +%s)-$$"
  local type=UPDATE
  if ! aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
       --query Stacks[0].StackId --output text >/dev/null 2>&1; then
    type=CREATE
  fi
  # --capabilities is greedy: bare words after it become more capabilities,
  # so --parameters must come AFTER the param args, never before them.
  local xtra=(--capabilities CAPABILITY_IAM)
  if [ ${#param_args[@]} -gt 0 ]; then
    xtra+=(--parameters "${param_args[@]}")
  fi
  aws cloudformation create-change-set --region "$region" \
    --stack-name "$stack" --change-set-name "$cs" --change-set-type "$type" \
    --template-body "file://$template" "${xtra[@]}" >/dev/null
  # A no-op update never reaches CREATE_COMPLETE: CFN fails the change set
  # with "didn't contain changes", which the waiter reports as terminal.
  aws cloudformation wait change-set-create-complete --region "$region" \
    --stack-name "$stack" --change-set-name "$cs" >&2 || true
  local cs_status has_changes cs_reason
  cs_status="$(aws cloudformation describe-change-set --region "$region" \
    --stack-name "$stack" --change-set-name "$cs" --query Status --output text)"
  has_changes="$(aws cloudformation describe-change-set --region "$region" \
    --stack-name "$stack" --change-set-name "$cs" --query HasChanges --output text)"
  if [ "$cs_status" != "CREATE_COMPLETE" ]; then
    cs_reason="$(aws cloudformation describe-change-set --region "$region" \
      --stack-name "$stack" --change-set-name "$cs" --query StatusReason --output text || true)"
    if [ "$cs_status" = "FAILED" ] && [[ "$cs_reason" == *"didn't contain changes"* ]]; then
      echo "No changes to deploy. Stack $stack is up to date"
      aws cloudformation delete-change-set --region "$region" \
        --stack-name "$stack" --change-set-name "$cs" >/dev/null
      return 0
    fi
    echo "change set for $stack: $cs_status — $cs_reason" >&2
    return 1
  fi
  if [ "$has_changes" = "false" ]; then
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
# Content-addressed key: a fixed key made code-only changes invisible to
# CloudFormation ("no changes"), which kept serving the old function code.
CODE_SHA="$(sha256sum build/bridge.zip | cut -c1-16)"
CODE_KEY="$STACK_NAME/bridge-$CODE_SHA.zip"
aws s3 cp build/bridge.zip "s3://$BUCKET/$CODE_KEY"

# ---- Parameters -----------------------------------------------------------
OVERRIDES=("BridgeCodeKey=$CODE_KEY")
if [ -n "${GOOGLE_WEB_CLIENT_ID:-}" ]; then
  # Desktop client + web client, both accepted as token audiences.
  OVERRIDES+=("GoogleClientIds=1035162854462-nos4fptbf2psbkp8ljd8tjem1psnekvt.apps.googleusercontent.com,$GOOGLE_WEB_CLIENT_ID")
fi

output_of() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey==\`$2\`].OutputValue" --output text
}

cfn_deploy "$REGION" "$STACK_NAME" template.yaml ${OVERRIDES[@]+"${OVERRIDES[@]}"}

echo
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table
