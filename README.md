# PocketShell Web

Browser client for PocketShell: sign in with the same Google account the
desktop app syncs with, see the hosts saved on that account, and open
terminal sessions on them — nothing to install.

```
browser (Vue 3 SPA) ── HTTPS ──▶ S3 + CloudFront (pocketshell.io)
        │
        ├─ HTTPS, Bearer <Google ID token> ──▶ pocketshell-sync API (host list,
        │                                      zero-knowledge encrypted blob)
        └─ WSS ?token=<ID token> ──▶ API Gateway WebSocket ──▶ bridge Lambda ──▶ SSH :22
                                               (aws-infra sandbox/pocketshell-web)
```

## What lives where

- **This repo** — the SPA. Login, host list, terminal UI (xterm.js), and the
  WebCrypto half of the sync contract.
- **aws-infra `sandbox/pocketshell-web`** — the stack: Route53 zone for
  pocketshell.io, CloudFront distribution, and the `ssh2` bridge Lambda
  behind a WebSocket API (deployed by that directory's `deploy.sh`).
- **aws-infra `sandbox/pocketshell-sync`** — the Google-login settings sync
  the host list comes from.

## Security model

- Login is a Google ID token. The sync API validates it with its JWT
  authorizer; the WS bridge verifies it itself (Google JWKS, audience, email
  allowlist) on `$connect` — WebSocket APIs have no native authorizer.
- The sync blob is zero-knowledge: the browser decrypts it with the sync
  passphrase (PBKDF2 600k + AES-256-GCM, identical to the desktop app), and
  the server never sees plaintext.
- SSH key material never syncs (`identityFile` in the blob is a path on
  whatever machine pushed it). The browser asks for a key or password per
  host and stores it in `localStorage`, encrypted with the sync passphrase
  using the same envelope scheme. On connect it rides the already
  authenticated WebSocket to the bridge and is used once, in memory.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + vite build → dist/
```

`public/config.js` is runtime configuration (sync API URL, Google web client
ID, bridge WSS URL) — not bundled, so values rotate without a rebuild.

## Deploying the site

```bash
scripts/deploy.sh   # builds, syncs dist/ to the site bucket, invalidates CF
```

The script reads bucket/distribution/WSS from the aws-infra stack outputs
(override with `SITE_BUCKET`, `CF_DISTRIBUTION_ID`, `WS_URL`).

## First-run checklist (one-time, manual)

1. **GoDaddy → Route 53**: set pocketshell.io's nameservers to the stack's
   `NameServers` output (`aws cloudformation describe-stacks --stack-name
   pocketshell-web --region eu-west-1`). Nothing under the domain resolves
   until this is done; until then the site serves from the `CloudFrontDomain`
   output.
2. **Google web client**: console.cloud.google.com → Credentials → create an
   OAuth client ID of type **Web application** (the desktop one cannot issue
   browser tokens) with authorized JavaScript origins
   `https://pocketshell.io` and `http://localhost:5173`. Then:
   - put the client ID into `config.js` (`googleClientId`),
   - redeploy the stack with `GOOGLE_WEB_CLIENT_ID=<id> ./deploy.sh` so the
     bridge (and later the sync API's authorizer) accept its tokens.
3. **Custom domain**: after the delegation is live,
   `ENABLE_CUSTOM_DOMAIN=true ./deploy.sh` in the aws-infra stack issues the
   ACM cert (DNS-validated) and moves the site onto pocketshell.io.
