#!/usr/bin/env bash
# Build the SPA and push it to the pocketshell-web site bucket, then
# invalidate CloudFront. Stack values come from the aws-infra stack outputs
# unless overridden:
#   SITE_BUCKET=... CF_DISTRIBUTION_ID=... WS_URL=... ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-eu-west-1}"
INFRA_DIR="${AWS_INFRA_DIR:-$HOME/git/aws-infra/sandbox/pocketshell-web}"

stack_output() {
  (cd "$INFRA_DIR" && aws cloudformation describe-stacks --region "$REGION" \
    --stack-name pocketshell-web \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null)
}

SITE_BUCKET="${SITE_BUCKET:-$(stack_output SiteBucketName)}"
CF_DISTRIBUTION_ID="${CF_DISTRIBUTION_ID:-$(stack_output SiteDistributionId)}"
WS_URL="${WS_URL:-$(stack_output WsUrl)}"
# Browser-direct relay (aws-infra sandbox/pocketshell-relay). Auto-detected
# from its stack output once that stack exists; DIRECT_WS_URL=... overrides,
# DIRECT_WS_URL='' forces empty (bridge only).
if [ ! "${DIRECT_WS_URL+x}" = x ]; then
  DIRECT_WS_URL="$(aws cloudformation describe-stacks --region "$REGION" \
    --stack-name pocketshell-relay \
    --query "Stacks[0].Outputs[?OutputKey=='WsUrl'].OutputValue" --output text 2>/dev/null)"
  # Bare `[ ... ] && ...` would kill the script under set -e whenever the
  # stack is absent — the reason every deploy silently no-opped since this
  # line landed. An empty relay output keeps the Lambda bridge.
  if [ "$DIRECT_WS_URL" = "None" ]; then DIRECT_WS_URL=""; fi
fi

[ -n "$SITE_BUCKET" ] || { echo "SITE_BUCKET not set and stack not deployed" >&2; exit 1; }
[ -n "$CF_DISTRIBUTION_ID" ] || { echo "CF_DISTRIBUTION_ID not set" >&2; exit 1; }

npm run build

# config.js is generated at deploy time so rotations do not need code changes.
cp public/config.js dist/config.js
python3 - "$WS_URL" "$DIRECT_WS_URL" <<'EOF'
import json, sys, pathlib
path = pathlib.Path("dist/config.js")
cfg = {"syncApiUrl": "https://a7sota2qic.execute-api.eu-west-1.amazonaws.com", "googleClientId": "1035162854462-kkqius5o2ni136ed6l58iig5pdpeh4u6.apps.googleusercontent.com", "wsUrl": sys.argv[1] if len(sys.argv) > 1 else "", "directWsUrl": sys.argv[2] if len(sys.argv) > 2 else ""}
existing = path.read_text() if path.exists() else ""
try:
    merged = json.loads(existing.split("=", 1)[1].strip().rstrip(";")) if existing else {}
except Exception:
    merged = {}
merged.update({k: v for k, v in cfg.items() if v})
path.write_text(f"window.POCKETSHELL_WEB = {json.dumps(merged, indent=2)};\n")
EOF

# The bucket serves only the app now; --delete clears stale keys.
aws s3 sync dist/ "s3://$SITE_BUCKET" --delete --region "$REGION"

aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION_ID" --paths "/*" >/dev/null
echo "Deployed to s3://$SITE_BUCKET (distribution $CF_DISTRIBUTION_ID)"
