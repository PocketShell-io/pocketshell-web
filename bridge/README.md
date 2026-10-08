# bridge — the pocketshell-web backend (WebSocket ssh2 bridge)

The backend half of this repo: a Lambda behind an API Gateway WebSocket API
that verifies the browser's Google ID token on `$connect` and then runs a
real `ssh2` client to the user's saved host, one session per
`connectionId`. The SPA in `../src` talks to it through
`src/terminal/bridge.ts`.

```
lambda/        index.mjs (handler) + package.json/lock (ssh2, apigw mgmt SDK)
template.yaml  CloudFormation for the `pocketshell-web` stack (eu-west-1)
deploy.sh      npm ci → zip → upload → change-set deploy of that stack
```

```
browser ──HTTPS──▶ CloudFront ──OAC──▶ private S3 (static SPA)
   │
   └─▶ Google Sign-In → ID token (aud = web client ID)
        │                              │
        │ Bearer <ID token>            │ wss://…?token=<ID token>
        ▼                              ▼
   pocketshell-sync API         WebSocket API (this stack)
   (host settings, CORS)              │ $connect verifies the token
        ▼                             ▼ against Google JWKS + allowlist
   AES-256-GCM envelope,        Lambda: ssh2 client, one session per
   decrypted in-browser         connectionId, held in warm state
        ▼                             ▼
   passphrase → host list ────▶ SSH to the saved host (shell, resize)
```

## Why the bridge exists

Browsers cannot open TCP, so `ssh2` runs inside the bridge Lambda. API
Gateway WebSocket APIs invoke the Lambda per frame, and consecutive frames
of one connection land on the same warm execution environment in practice,
so the ssh2 session lives in module state keyed by `connectionId`. If a
frame ever hits a cold environment the client receives `session_lost` and
re-establishes the shell transparently. Hard limits: 10 min socket idle
(client pings every 60 s), 2 h connection lifetime (client reconnects
before that on the next keystroke... to be implemented; for now the tab
shows the drop and one click reopens the session).

Host credentials never touch storage: the `connect` frame carries either
the browser-generated key's PEM or a pasted key/password, in memory only.

## What is in the stack (and why it is not split)

`template.yaml` is the live `pocketshell-web` CloudFormation stack and it
is byte-identical to the version that was deployed from aws-infra. It
carries more than the bridge:

- the bridge itself — Lambda, IAM role, log group, WebSocket API, routes,
  stage, invoke permission;
- the static-site origin — private S3 bucket (`pocketshell-web-site-*`),
  OAC, bucket policy, www-redirect CloudFront Function, the inner
  CloudFront distribution that `../scripts/deploy.sh` syncs `dist/` into;
- the `pocketshell.io` Route53 hosted zone and its Search Console TXT.

The zone and the site would ideally live in aws-infra, but moving a
resource between CloudFormation stacks is a replacement (or a careful
retain + import), and replacing the hosted zone changes its nameservers —
breaking the GoDaddy delegation. So the template moved here whole, with
the app. Treat zone/site edits in it as infra changes.

What stayed in aws-infra (`sandbox/pocketshell-web/`): the
`app.pocketshell.io` custom domain — `domain.yaml` (stack
`pocketshell-web-domain`: the outer CloudFront distribution + app. alias
records), the us-east-1 ACM certificate, the hand-applied apex/www/relay
records in `route53-site-records.json`, and `deploy-domain.sh` that drives
them. That script reads this stack's `ZoneId`, `CloudFrontDomain` and
`SiteDistributionId` outputs, so those output names are a contract.

## Deploy

```bash
bridge/deploy.sh                             # package + deploy the stack
GOOGLE_WEB_CLIENT_ID=<id> bridge/deploy.sh   # also accept the web client's tokens
```

`deploy.sh` builds `lambda/node_modules` with `npm ci --omit=dev` (only when
`ssh2` is missing — delete `lambda/node_modules` to force a fresh install),
zips `lambda/` into `build/bridge.zip`, uploads it to
`s3://pocketshell-web-deploy-<account>-<region>/pocketshell-web/bridge.zip`,
and deploys `template.yaml` with raw change-set APIs (aws-cli v1 on the
operator box lacks `cloudformation deploy`). Outputs: `ZoneId`,
`NameServers`, `SiteBucketName`, `SiteDistributionId`, `CloudFrontDomain`,
`WsUrl` (the SPA's `wsUrl`; `../scripts/deploy.sh` reads it).

Note: the Lambda's `Code` points at a fixed S3 key, so a code-only change
uploads a new zip but leaves the template unchanged — CloudFormation then
reports "no changes" and the function keeps the old code. Push new code
with `aws lambda update-function-code --function-name pocketshell-web-bridge
--s3-bucket <deploy bucket> --s3-key pocketshell-web/bridge.zip
--region eu-west-1` after `deploy.sh` uploads the zip.

The custom domain is not deployed from here; see aws-infra
`sandbox/pocketshell-web/README.md`.

## Prerequisites the owner does by hand

1. **Google Cloud Console** — an OAuth client of type **Web application**
   with Authorized JavaScript origins for the app host and
   `http://localhost:5173`. Pass its client ID to this stack
   (`GOOGLE_WEB_CLIENT_ID`) and to the web app (`public/config.js`). No
   client secret involved: the browser flow (GIS) yields an ID token
   directly.
2. **pocketshell-sync CORS** — the sync stack (aws-infra
   `sandbox/pocketshell-sync`) lists the origins allowed to call it from a
   browser; add the app origin there if missing.
3. **GoDaddy delegation** of pocketshell.io to this stack's `NameServers`
   (done once; see aws-infra for the domain side).

## History

This directory was moved from aws-infra `sandbox/pocketshell-web` with
`git subtree`, so its full history is in this repo. Path-filtered `git log`
does not cross the subtree merge; to see the pre-move commits of a file:

```bash
m=$(git log --format=%H --grep='BRIDGE import' -1)   # the subtree merge
git log --oneline "$m^2" -- lambda/index.mjs
```

## Removing

```bash
aws cloudformation delete-stack --stack-name pocketshell-web --region eu-west-1
```

Delete the aws-infra `pocketshell-web-domain` stack first — it depends on
this stack's distribution and zone. The hosted zone, buckets and log
groups outlive the stack until deleted by hand.
