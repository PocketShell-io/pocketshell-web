# bridge — the pocketshell-web backend (WebSocket ssh2 bridge)

The backend half of this repo: a Lambda behind an API Gateway WebSocket API
that verifies the browser's Google ID token on `$connect` and then runs a
real `ssh2` client to the user's saved host, one session per
`connectionId`. The SPA in `../src` talks to it through
`src/terminal/bridge.ts`.

```
lambda/        index.mjs (handler) + package.json/lock (ssh2, apigw mgmt SDK)
package.sh     build the deployable zip: build/bridge-<sha256>.zip
```

The CloudFormation stack that runs it (`pocketshell-web`, eu-west-1) and its
deploy script live in **aws-infra `sandbox/pocketshell-web/`**
(`template.yaml`, `deploy.sh`); see Deploy below.

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

## Where the stack lives

The `pocketshell-web` stack carries more than the bridge — the
`pocketshell.io` hosted zone, the S3 + CloudFront site origin and the
bridge's Lambda/WebSocket API — and it stays one stack (moving the zone to
another stack would change its name servers). Its template, deploy script,
the `app.pocketshell.io` domain layer, the DNS inventory and the CI OIDC
role all live in aws-infra `sandbox/pocketshell-web/`; see its README.
This repo keeps only the Lambda code. The stack outputs `SiteBucketName`,
`SiteDistributionId` and `WsUrl` are read by `../scripts/deploy.sh`.

## Deploy

```bash
bridge/package.sh        # -> bridge/build/bridge-<sha256>.zip (path on stdout)

cd ~/git/aws-infra/sandbox/pocketshell-web
DEPLOY_REVIEW=1 BRIDGE_SRC=~/git/pocketshell-web ./deploy.sh   # build, upload, print change set, stop
BRIDGE_SRC=~/git/pocketshell-web ./deploy.sh                   # same, and execute it
GOOGLE_WEB_CLIENT_ID=<id> BRIDGE_SRC=~/git/pocketshell-web ./deploy.sh   # also accept the web client's tokens
```

`package.sh` installs the production dependencies from the lockfile into a
clean staging copy (`npm ci --omit=dev --omit=optional --ignore-scripts`:
no native builds; ssh2 runs pure JS on the arm64 Lambda) and writes a
deterministic zip — same source and lockfile, same digest. aws-infra's
`deploy.sh` uploads it to
`s3://pocketshell-web-deploy-<account>-<region>/pocketshell-web/bridge-<sha256>.zip`
and passes that key as the stack's `BridgeCodeKey`, so a code-only change is
a template change and CloudFormation updates the function.

## Prerequisites the owner does by hand

1. **Google Cloud Console** — an OAuth client of type **Web application**
   with Authorized JavaScript origins for the app host and
   `http://localhost:5173`. Pass its client ID to this stack
   (`GOOGLE_WEB_CLIENT_ID` on aws-infra's `deploy.sh`) and to the web app (`public/config.js`). No
   client secret involved: the browser flow (GIS) yields an ID token
   directly.
2. **pocketshell-sync CORS** — the sync stack (aws-infra
   `sandbox/pocketshell-sync/template.yaml`) lists the origins allowed to call it from a
   browser; add the app origin there if missing.
3. **GoDaddy delegation** of pocketshell.io to this stack's `NameServers`
   (done once; see aws-infra for the domain side).

## History

This directory was moved from aws-infra `sandbox/pocketshell-web` with
`git subtree`, so its full history is in this repo. On 2026-10-09 the stack template and
`deploy.sh` went back to aws-infra `sandbox/pocketshell-web/` (copied from
`534b483`); only the Lambda code stays here. Path-filtered `git log`
does not cross the subtree merge; to see the pre-move commits of a file:

```bash
m=$(git log --format=%H --grep='BRIDGE import' -1)   # the subtree merge
git log --oneline "$m^2" -- lambda/index.mjs
```

## Removing

See aws-infra `sandbox/pocketshell-web/README.md` ("Removing").
