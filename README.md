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
  browser half of the sync contract.
- **aws-infra `sandbox/pocketshell-web`** — the stack: Route53 zone for
  pocketshell.io, CloudFront distribution, and the `ssh2` bridge Lambda
  behind a WebSocket API (deployed by that directory's `deploy.sh`).
- **aws-infra `sandbox/pocketshell-sync`** — the Google-login settings sync
  the host list comes from.
- **PocketShell-io/pocketshell-desktop** — the desktop (Electron) app whose
  sync contract this app speaks.

## Shared code with the desktop app

The sync contract is not reimplemented here, it is shared with
pocketshell-desktop:

- `src/shared/{types,syncMerge,sync,syncConfig}.ts` are VERBATIM copies of
  the desktop's `src/shared/` modules — refresh them with
  `scripts/sync-shared.sh` after changing them there, never edit the copies.
  The web host list is parsed by the desktop's `parseSyncPayload`, so a
  blob either app writes reads identically in both.
- `src/shared/syncCrypto.ts` is the browser twin of the desktop's
  `src/main/sync/SyncCrypto.ts` (WebCrypto instead of `node:crypto`, same
  envelope byte-for-byte) — hand-maintained, change in lockstep.
- `src/api/sync.ts` ports the desktop's `SyncService` (same errors, same
  8 KB limit, same conflict shape); only the token source differs, because
  a browser cannot refresh a Google token silently.

`tests/syncCrypto.test.ts` proves envelope interop with the desktop format
in BOTH directions (node writes → browser reads, browser writes → node
reads), and `tests/syncMerge.test.ts` pins the desktop's parse/merge rules.


## Security model

- Login is a Google ID token. The sync API validates it with its JWT
  authorizer; the WS bridge verifies it itself (Google JWKS, audience, email
  allowlist) on `$connect` — WebSocket APIs have no native authorizer.
- The sync blob is zero-knowledge: the browser decrypts it with the sync
  passphrase (PBKDF2 600k + AES-256-GCM, identical to the desktop app), and
  the server never sees plaintext.
- Importing an SSH config is a browser-local act: the file (or pasted text)
  is parsed in the tab and the file itself never leaves it. Only the hosts
  you tick join the account blob — encrypted like everything else in the
  slot. The parser (`src/sshConfigImport.ts`) is the desktop parser's web
  twin minus what a tab cannot do: no `Include`, `~` kept verbatim, host
  patterns (`*`, `?`, `!`) skipped because the bridge dials hosts directly.
- A key's own passphrase (for encrypted OpenSSH keys) is collected in the
  same dialog and stored under the same envelope as the key it unlocks; on
  connect both ride the bridge's `connect` frame (`auth.passphrase`).
- Key material syncs, encrypted: the browser asks for a key or password per
  host and stores it in `localStorage`, encrypted with the sync passphrase
  using the same envelope scheme — and pushes that envelope to the second
  settings slot (`keys`), which only web clients read (the desktop's parser
  has never seen it). On unlock a device merges the account's records with
  its local cache, so a key attached once is usable on every device; the
  server holds one more opaque blob it cannot open. On connect the secret
  rides the already authenticated transport and is used once, in memory.
  (`identityFile` in the host blob is still just a path on whatever machine
  pushed it.)
- That bridge handling is verified in source, not asserted:
  `aws-infra/sandbox/pocketshell-web/lambda/index.mjs` feeds the `connect`
  frame's key/password straight into the ssh2 client — never onto the
  session object, never logged, never persisted. The Lambda has no table;
  its warm session state dies on disconnect, after 10 idle minutes, and at
  the 110-minute connection cap.
- No telemetry: the browser app ships no analytics or error reporting, and
  the bridge's CloudWatch logs carry connection ids and error strings only.
  The ID token rides the `?token=` query string; the WebSocket API stage has
  no access logging configured, so the token is not written to logs either.
- Stored credentials are deletable per host: "Remove key" on the Hosts
  screen re-encrypts both envelopes — the local cache and the account's
  `keys` slot — without that credential. Signing out clears the session
  token and in-memory state but keeps the encrypted local envelope — it is
  useless without the sync passphrase, and clearing site data removes it
  entirely.
- `tests/publicClaims.test.ts` pins the public copy to this model: every
  key-safety surface must disclose the bridge hop, and absolute
  "keys never leave your browser" claims must not reappear.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run test       # vitest (crypto interop + merge rules + parser/store)
npm run build      # typecheck + vite build → dist/
tests/e2e/run-e2e.sh   # browser E2E vs the electron repo's docker sshd fixture
```

The E2E suite (`tests/e2e/`) drives the built app in Chromium against the
`pocketshell-test:ssh` fixture from the electron repo: the fake sync API
only ever accepts opaque envelopes (and the test decrypts them with the
passphrase), and the fake bridge opens REAL SSH sessions on the container
with whatever key + passphrase the browser sent — including the
passphrase-protected key. Needs docker, `/usr/bin/python3` with playwright
and paramiko.

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
3. **Custom domain**: every `./deploy.sh` of the aws-infra stack brings
   pocketshell.io up with the site — it requests the ACM cert, seeds its
   DNS validation records itself, and waits for issuance, so with the
   delegation from step 1 live one run completes end-to-end. This repo's
   `scripts/deploy.sh` keeps serving from the `CloudFrontDomain` output
   until then — no change needed when the domain goes live, `config.js`
   never hardcodes the hostname.
