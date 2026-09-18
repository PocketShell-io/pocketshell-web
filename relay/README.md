# PocketShell dumb relay

A Cloudflare Worker that pipes bytes between a browser WebSocket and a TCP
stream toward `host:port`. That is all it does: the browser runs the SSH
client itself (src/terminal/direct.ts), so every byte crossing here is
already SSH ciphertext, encrypted between the browser and the host. The
relay has no keys and no plaintext — being dumb is the feature.

What intelligence it does have is the front door: the `?token=` Google ID
token is verified against Google's JWKS (signature, audience, expiry,
verified email) and checked against `ALLOWLIST_EMAILS` before the TCP leg
dials. No token, no dial — this is not an open relay. Private and link-local
targets (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, *.internal) are
refused at the door too.

Why: the API Gateway WebSocket bridge bills per message. One Workers free
tier allows 100k requests a day, and a session is one request — this is
effectively free at any personal scale.

## Deploy

    cd relay
    npx wrangler login
    npx wrangler deploy --var ALLOWLIST_EMAILS:you@example.com

Then point the app at it: set `directWsUrl` in `public/config.js`
(`wss://pocketshell-relay.<your-subdomain>.workers.dev`) and redeploy the
app. An empty `directWsUrl` keeps a user on the Lambda bridge — the client
code paths coexist by design (src/terminal/session.ts lazy-loads the ssh2
bundle only in direct mode).

## Behavior notes

- For local dev and tests, `node relay/dev-relay.mjs [port=8787]` runs the
  same dumb pipe without the token check — never expose it publicly.
- One WebSocket per session; `?host=&port=&token=` on the query string
  (same pattern the Lambda bridge uses for `?token=`).
- The worker holds no state between messages; a dropped TCP leg closes the
  WebSocket and the client sees a clean session end.
- Google JWKS responses are cached at the edge for an hour.

## Production deploy (AWS)

The deployed relay is not this Worker but its protocol twin:
`aws-infra/sandbox/pocketshell-relay` (`relay.go` — same wire contract and
token checks, plus a fail-closed email allowlist) on a t4g.nano behind
`wss://relay.pocketshell.io/`, TLS via in-process ACME, no SSH port,
administered over SSM. `./deploy.sh` there provisions the stack, ships the
arm64 binary via S3+SSM, and health-gates on the protocol's 426. This
Worker remains the portable reference; the app consumes either one the
same way, via `directWsUrl`.
