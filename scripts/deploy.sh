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

[ -n "$SITE_BUCKET" ] || { echo "SITE_BUCKET not set and stack not deployed" >&2; exit 1; }
[ -n "$CF_DISTRIBUTION_ID" ] || { echo "CF_DISTRIBUTION_ID not set" >&2; exit 1; }

npm run build

# config.js is generated at deploy time so rotations do not need code changes.
cp public/config.js dist/config.js
python3 - "$WS_URL" <<'EOF'
import json, sys, pathlib
path = pathlib.Path("dist/config.js")
cfg = {"syncApiUrl": "https://a7sota2qic.execute-api.eu-west-1.amazonaws.com", "googleClientId": "", "wsUrl": sys.argv[1] if len(sys.argv) > 1 else ""}
existing = path.read_text() if path.exists() else ""
try:
    merged = json.loads(existing.split("=", 1)[1].strip().rstrip(";")) if existing else {}
except Exception:
    merged = {}
merged.update({k: v for k, v in cfg.items() if v})
path.write_text(f"window.POCKETSHELL_WEB = {json.dumps(merged, indent=2)};\n")
EOF

aws s3 sync dist/ "s3://$SITE_BUCKET" --delete --region "$REGION"

# Blog pages are extensionless keys (…/blog/<slug>) so sync uploads them with
# a generic content type; re-copy with an explicit HTML one. The index is
# additionally copied to the bare "blog" key (S3 REST does not serve
# directory indexes itself).
find dist/blog -maxdepth 1 -type f ! -name "*.*" -print0 2>/dev/null | while IFS= read -r -d '' f; do
  aws s3 cp "$f" "s3://$SITE_BUCKET/blog/${f##*/}" --content-type "text/html; charset=utf-8" --region "$REGION"
done
if [ -f dist/blog/index.html ]; then
  aws s3 cp dist/blog/index.html "s3://$SITE_BUCKET/blog" --content-type "text/html; charset=utf-8" --region "$REGION"
  # /blog/ (trailing slash) is a distinct S3 request; without this key it
  # 404s into the SPA fallback and serves the landing page.
  aws s3api put-object --bucket "$SITE_BUCKET" --key "blog/" --body dist/blog/index.html \
    --content-type "text/html; charset=utf-8" --region "$REGION" >/dev/null
fi

aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION_ID" --paths "/*" >/dev/null
echo "Deployed to s3://$SITE_BUCKET (distribution $CF_DISTRIBUTION_ID)"
