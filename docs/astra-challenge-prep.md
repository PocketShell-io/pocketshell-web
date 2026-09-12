# Astra Challenge prep — verification record (2026-09-12)

Status per the challenge-prep issue. Evidence is in-repo; nothing here
requires trusting marketing copy.

## P0 — security claims vs architecture: DONE

The verified model (source, not assertion):

1. Credentials at rest — `src/stores/hosts.ts`: key/password per host lives
   in `localStorage` under `ps.hostKeys`, encrypted with the sync
   passphrase (PBKDF2 600k + AES-256-GCM, `src/shared/syncCrypto.ts`).
2. Transfer — `src/terminal/bridge.ts` sends `auth` in the `connect` frame
   over WSS (API Gateway, TLS) to the bridge Lambda.
3. Bridge handling — `aws-infra/sandbox/pocketshell-web/lambda/index.mjs`
   feeds the frame's key/password straight into the ssh2 client options:
   never onto the session object, never logged (CloudWatch lines carry
   connection ids and error strings only), never persisted (no table; warm
   state dies on `$disconnect`, at 10 min idle, at the 110 min connection
   cap).
4. The sync server never sees key material: the synced blob carries host
   metadata only; `ps.hostKeys` never leaves the browser except in (3).
5. Token handling — the Google ID token rides `?token=` on the WS URL; the
   WebSocket stage has **no access logging configured**
   (`template.yaml`, `WsStage`), so the token is not written to logs. The
   sync API takes the token in the `Authorization` header; its lambda logs
   error objects only. The browser app ships no analytics/error reporting
   (no Sentry/Posthog in `package.json`).

Changes shipped for P0:

- `index.html` JSON-LD + `LandingView.vue` visible FAQ, features copy, and
  security band now disclose the bridge hop; the false "never uploaded"
  key claim is gone everywhere (also the passphrase chip, reworded to
  "never leaves the device" — which is true).
- `HostsView.vue` has an explicit per-host **Remove key** action
  (`hosts.removeHostSecret` re-encrypts the envelope without the
  credential). Signing out keeps the encrypted envelope in localStorage —
  documented in the store and README; clearing site data wipes it.
- `README.md` security model states the above as verified facts.
- `tests/publicClaims.test.ts` pins the copy: no "never uploaded" on any
  public surface, and each key-safety surface must keep the bridge
  disclosure.

## P1 — demo/first-run: PARTIALLY VERIFIED, decisions needed

- **Allowlist blocks new accounts**: bridge `AllowedEmails` defaults to
  alexey only (`template.yaml`); pocketshell-sync enforces its own. A
  clean-browser demo by anyone else fails at sign-in until the allowlist
  is widened — Alexey's call (add a demo address, or a second stack).
- Error paths hardened: the generic bridge `ssh connect failed` now
  expands to an actionable message in `TerminalView.vue` (bad key,
  unreachable host, WS failure); status leaves "connecting…" on failure —
  no infinite spinner. Invalid creds → clear error; tab close →
  `$disconnect` destroys bridge state; reconnect re-attaches the aplexer
  session.
- **Demo host**: needs AWS (phone-gated). Proposal: separate sandbox host
  + allowlisted demo Google account; no production secrets on it; session
  reset = `a kill <session>` between visitors. Not provisioned yet.
- Host prep requirement is stated honestly ("the PocketShell CLI" in FAQ
  + README); no "nothing to install on servers" claim exists.

## P1 — Astra role / launch: OPEN, needs Alexey

- Which parts were built with Astra is not recorded in either repo; the
  landing/README make no Astra claims today, so nothing to correct — but
  a provable statement needs a write-up before launch.
- Product Hunt rules (Sept 18 scheduling, repeat launches, multiple
  entries, required Astra role): unverified — the launch announcement
  only pins the date. Treat all four as unknown until confirmed.
- Video/screenshots/demo script: not started.

## Local run log

`npm test` → 16/16 (includes the new claims regression test);
`npm run build` (blog + vue-tsc + vite) → OK; built `dist/` carries no
"never uploaded" and both bridge disclosures.
