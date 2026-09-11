# pocketshell-web — pocketshell.io static client + terminal bridge

Web sibling of the PocketShell Android app and pocketshell-electron: open
`pocketshell.io`, sign in with the same Google account the desktop sync uses,
pull the encrypted host list from the `pocketshell-sync` API, and open real
terminal sessions on those hosts from the browser.

Two halves, one stack (plus the us-east-1 cert sidecar):

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

## Deploy

```bash
./deploy.sh                                # zone + site + bridge + pocketshell.io
GOOGLE_WEB_CLIENT_ID=<id> ./deploy.sh      # accept the web client's tokens
```

`deploy.sh` builds `lambda/node_modules` with npm, zips, uploads to the
deploy bucket, and runs `aws cloudformation deploy` — for the main stack,
then the cert sidecar, then the custom-domain stack, in that order. Outputs
include `NameServers` (point GoDaddy at these), `CloudFrontDomain` (works
before delegation), and `WsUrl` (bake into the web app's `src/config.ts`).

`cert.yaml` (us-east-1) holds the CloudFront viewer certificate and, via a
custom resource, mirrors its DNS validation CNAMEs into the pocketshell.io
zone. Validation completes as soon as GoDaddy delegates; run against a not
yet delegated domain, the deploy waits (and eventually fails its wait) at
PENDING_VALIDATION — re-run once the delegation is live.

## Prerequisites the owner does by hand

1. **GoDaddy** — replace pocketshell.io's nameservers with the stack's
   `NameServers` output (Route 53 delegation; the zone is created here, the
   domain stays registered at GoDaddy).
2. **Google Cloud Console** — create an OAuth client of type **Web
   application** with Authorized JavaScript origins
   `https://pocketshell.io` and `http://localhost:5173`. Pass its client ID
   to this stack (`GOOGLE_WEB_CLIENT_ID`) and to the web app build. No
   client secret involved: the browser flow (GIS) yields an ID token
   directly.
3. **pocketshell-sync CORS** — the sync stack's template lists the origins
   allowed to call it from a browser; add `https://pocketshell.io` there if
   missing and redeploy that stack.

## Removing

```bash
aws cloudformation delete-stack --stack-name pocketshell-web --region eu-west-1
aws cloudformation delete-stack --stack-name pocketshell-web-cert --region us-east-1
```

The hosted zone, buckets, and log groups are retained (no DeletionPolicy
overrides needed — the zone and bucket simply outlive the stack until
deleted by hand).
