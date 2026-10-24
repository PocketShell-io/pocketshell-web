# PocketShell Web

See [SCOPE.md](SCOPE.md) for ownership and product boundaries.

Browser client for PocketShell: sign in with the same Google account the
desktop app syncs with, see the hosts saved on that account, and open
terminal sessions on them — nothing to install.

```
browser (Vue 3 SPA) ── HTTPS ──▶ S3 + CloudFront (pocketshell.io)
        │
        ├─ HTTPS, Bearer <Google ID token> ──▶ pocketshell-sync API (host list,
        │                                      zero-knowledge encrypted blob)
        └─ WSS ?token=<ID token> ──▶ API Gateway WebSocket ──▶ bridge Lambda ──▶ SSH :22
                                               (bridge/ in this repo)
```

## Repo layout

```
src/        the SPA (Vue 3): login, host list, terminal UI (xterm.js), the
            browser half of the sync contract
public/     runtime config.js and static assets
scripts/    deploy.sh (SPA → site bucket), build helpers
tests/      vitest unit tests + browser E2E (tests/e2e/)
bridge/     the backend: WebSocket ssh2 bridge Lambda (lambda/), its
            CloudFormation stack (template.yaml) and deploy.sh — see
            bridge/README.md
relay/      reference browser-direct SSH relay (Cloudflare worker + dev relay)
```

## What lives where

- **This repo** — the SPA (`src/`) and its backend, the `ssh2` bridge
  Lambda behind a WebSocket API (`bridge/`). The bridge's stack
  `pocketshell-web` also holds the pocketshell.io Route53 zone and the
  S3 + CloudFront site origin; see `bridge/README.md` for why it was not
  split when it moved here from aws-infra.
- **aws-infra `sandbox/pocketshell-web`** — the `app.pocketshell.io`
  custom domain: us-east-1 ACM certificate, the `pocketshell-web-domain`
  stack (outer CloudFront + alias records), and the hand-applied
  apex/www/relay records (`deploy-domain.sh`).
- **aws-infra `sandbox/pocketshell-sync`** — the Google-login settings sync
  the host list comes from.
- **PocketShell-io/pocketshell-desktop** — the desktop (Electron) app whose
  sync contract this app speaks.

## Shared code with the desktop app

The sync contract is not reimplemented here, it is shared with
pocketshell-desktop through one package:

- `@pocketshell/core` (the [pocketshell-core](../pocketshell-core) repo) is the
  single implementation of the contract layer: `types`, `syncMerge`, `sync`,
  `syncConfig`, the zero-knowledge blob both clients parse, `sshConfigCore`,
  `osc52`, `aplexer` (+ commands, parsers, client core), `shellQuote`,
  `agentLaunch`, `agentCommands`, `composerSend`, `knownHostsCore`, `sftpCore`,
  `net`, `byteSize`, and `userBinPath`. The web host list is parsed by the
  desktop's `parseSyncPayload`, so a blob either app writes reads identically
  in both. A change lands in the core repo once and both apps pick it up —
  the old `scripts/sync-shared.sh` verbatim-copy loop is gone.
- The package is consumed locally as `file:../pocketshell-core` (npm links it,
  so a core rebuild is enough — no republish). When it is published to npm,
  the file: spec turns into a version.
- `src/shared/syncCrypto.ts` remains a browser twin of the desktop's
  `src/main/sync/SyncCrypto.ts` (WebCrypto instead of `node:crypto`, same
  envelope byte-for-byte) — hand-maintained, change in lockstep. Moving it
  behind an injected-crypto interface into the core is the obvious next step.
- `src/api/sync.ts` ports the desktop's `SyncService` (same errors, same
  8 KB limit, same conflict shape); only the token source differs, because
  a browser cannot refresh a Google token silently.

`tests/syncCrypto.test.ts` proves envelope interop with the desktop format
in BOTH directions (node writes → browser reads, browser writes → node
reads), and the sync/aplexer/osc52/agent tests run the core package's code
directly — the same suite the core repo runs.


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
- SSH keys and host passwords live in the account **key vault** (design:
  pocketshell-key-vault, implementation: `@pocketshell/core` keyVault). One
  vault passphrase per account derives (Argon2id, 64 MiB) the key that
  unwraps the vault's data key; the server stores only ciphertext in the
  `vault` header slot and one `vk-<keyId>` slot per key. The decrypted index
  also carries the sync passphrase, so one passphrase opens keys and hosts.
  A lost vault passphrase cannot be recovered: `/keys?reset=1` wipes the
  vault after a fresh Google sign-in and the keys are uploaded again.
- Keys are added on the Keys page (`/keys`): parsed in the tab, an encrypted
  key's own passphrase is asked once and the key is stored decrypted inside
  the vault, so other devices need only the vault passphrase. Each host names
  one vault entry plus a gateway auth policy (host / managed / both), which
  "Apply to host" pushes to the host agent with the vault PUBLIC key.
- Nothing plaintext is persisted. "Remember on this device" stores the
  vault's data key (and its verifier input), wrapped by a non-extractable
  AES-GCM key in IndexedDB; sign-out forgets it. Non-extractable means the
  key's bytes cannot be read out, not that only PocketShell can use it: any
  script running on this origin can ask the browser to unwrap the
  remembered data key with it. That includes an XSS payload and the remote
  web apps the port forwarder serves under this origin (`/fwd/…`, through
  the root-scoped `public/sw.js`; `src/forward/forwardHttp.ts` strips their
  CSP and frame headers so they render). The app sets no CSP yet. So
  "Remember on this device" is only as safe as everything this origin runs:
  type the passphrase every time on a browser you also use to open
  forwarded apps you don't trust (follow-up: a CSP, and serving forwards
  from a separate origin). Keys are decrypted only when connecting, into
  memory; on connect the secret rides the already authenticated WebSocket to
  the bridge and is used once, in memory. A locked vault shows an unlock
  sheet, never a key prompt.
- The pre-vault store (the web-only `keys` slot and the `ps.hostKeys`
  cache, both under the sync passphrase) is migrated into the vault on the
  first open after the upgrade, read back, and then deleted.
  (`identityFile` in the host blob is still just a path on whatever machine
  pushed it.)
- That bridge handling is verified in source, not asserted:
  `bridge/lambda/index.mjs` feeds the `connect`
  frame's key/password straight into the ssh2 client — never onto the
  session object, never logged, never persisted. The Lambda has no table;
  its warm session state dies on disconnect, after 10 idle minutes, and at
  the 110-minute connection cap.
- No telemetry: the browser app ships no analytics or error reporting, and
  the bridge's CloudWatch logs carry connection ids and error strings only.
  The ID token rides the `?token=` query string; the WebSocket API stage has
  no access logging configured, so the token is not written to logs either.
- Stored credentials are deletable per key on the Keys page (every device
  loses them at its next read). Signing out clears the session token, the
  in-memory vault and the remembered vault key on this device.
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

## Deploying

Two independent deploys, both against the sandbox account (eu-west-1):

```bash
scripts/deploy.sh   # SPA: build, sync dist/ to the site bucket, invalidate CF
bridge/deploy.sh    # backend: npm ci + zip the Lambda, deploy the pocketshell-web stack
```

- `scripts/deploy.sh` reads bucket/distribution/WSS from the
  `pocketshell-web` stack outputs (override with `SITE_BUCKET`,
  `CF_DISTRIBUTION_ID`, `WS_URL`, `DIRECT_WS_URL`). CI runs it on every
  push to main (`.github/workflows/deploy.yml`) with the values pinned.
- `bridge/deploy.sh` is run by hand by the operator; nothing in CI deploys
  the bridge. A Lambda code-only change also needs an
  `aws lambda update-function-code` — see `bridge/README.md`.
- The custom domain (`app.pocketshell.io`) is deployed from aws-infra
  `sandbox/pocketshell-web/deploy-domain.sh`, only when it changes.

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
   - redeploy the stack with `GOOGLE_WEB_CLIENT_ID=<id> bridge/deploy.sh` so the
     bridge (and later the sync API's authorizer) accept its tokens.
3. **Custom domain**: aws-infra `sandbox/pocketshell-web/deploy-domain.sh`
   brings app.pocketshell.io up on top of this stack — it requests the ACM
   cert, seeds its DNS validation records itself, and waits for issuance,
   so with the delegation from step 1 live one run completes end-to-end. This repo's
   `scripts/deploy.sh` keeps serving from the `CloudFrontDomain` output
   until then — no change needed when the domain goes live, `config.js`
   never hardcodes the hostname.
