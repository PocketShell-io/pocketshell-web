# Connecting through the PocketShell gateway

The gateway is the browser client's route to a host with no open SSH port —
a laptop or home server behind residential NAT. The host runs the PocketShell
gateway agent, which dials OUT to `gateway.pocketshell.io` and stays dialled
in; the browser dials the gateway's per-host WebSocket and speaks **real SSH
end-to-end** through it, straight to the host's own sshd.

What the gateway is and is not:

- The gateway **relays opaque bytes**. Your SSH session is encrypted between
  the browser and the host exactly like a direct connection; the gateway can
  neither read nor alter it in any way that survives SSH's own integrity
  checks.
- The browser never hands the gateway your **sign-in token**. The raw Google
  sign-in also authorizes your account's sync storage (reads, writes,
  deletes), so before a gateway dial the browser exchanges it — at the
  trusted account service, never at the gateway — for a **gateway-scoped
  management token**: it authorizes the gateway's management surface only
  (session routing and the enrollment actions — enroll / list / revoke),
  only for your account, and only
  for five minutes. A failed exchange fails the dial; there is no fallback
  to the raw token.
- The thing that logs you into the host is your **SSH private key**, which
  lives in this browser and crosses the gateway only inside the encrypted
  SSH session — never in a credential frame, never in the token exchange.
- The gateway can never vouch for your host. Only **you** can — by pairing
  its key fingerprint (below). A connection without a pairing is refused, and
  a host whose key ever stops matching the pairing is refused loudly, before
  any login is attempted.

This is a different transport from the legacy "bridge" dial (which hands a
host's hostname and key to a Lambda for the connection) and from the **link**
transport (`pocketshell link run` + a relay token, for machines you manage
with the desktop's link). Gateway hosts sync as ordinary hosts in your
account list — the gateway address and device id are stored with the host;
the fingerprint pairing is NOT synced, because trust is per-device.

**Legacy credential boundary (existing transports, until migrated):** the
browser-direct relay dial still rides the raw sign-in in its query string,
authorized by that relay only; and a deployment with no direct relay
configured uses the Lambda bridge, whose `connect` frame carries a host's
key. The automatic warnings sweep no longer sends any host key to that
bridge — keys move only on a dial you started, over the host's own
transport. Gateway hosts are excluded from that sweep entirely (see
maturity limits). Link hosts do sweep, but their bridge frame carries
exactly the shared relay token — never the SSH private key a stale
credential record may still hold, and nothing at all when the token is
missing (no key fallback). The sweep and the dial resolve a host's
transport with the same fail-closed rule: a malformed or conflicting
transport marker on a synced host refuses the dial and excludes the host
from the sweep, it never degrades into a direct dial.

## Setting up a new gateway host

1. **In the browser, Hosts → Add host**: fill in name/hostname/user as usual,
   then set **Gateway device id**. Leave **Gateway address** alone unless you
   run your own gateway.
2. **On the host**: enroll the gateway agent (see the pocketshell-gateway
   repo's agent docs). Enrollment needs a token: use the host's row
   **Enroll token…** action here — it mints a gateway-scoped management
   token, copies it
   to your clipboard, and expires within five minutes. Paste it into the
   enrollment command on the host (it reads the token from stdin). Your
   actual sign-in is never used on the host. Enrollment confirms the host's
   **SSH host key fingerprint** (`SHA256:…`).
3. **Attach your SSH key** with **Key…** — same as any host. Gateway
   connections are key-only; a password login is never attempted.
4. **Pair the host** with **Pair…**: paste the host's `SHA256:…` fingerprint.
   Get it from the host itself — the agent's enrollment screen, or by running
   this on the host over a connection you already trust:

   ```
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

5. **Connect.** The first bytes flow only after: the browser obtained a
   scoped gateway token, the gateway admitted it, the host's agent answered,
   and the host presented the exact key you paired.

## Pairing is the security model

- **No pairing, no dial.** The browser refuses to contact the host — and
  refuses to send it your key — until this device holds a fingerprint you
  provisioned.
- **Key changed → refused.** If the host presents a different key (rebuilt
  server, rotated keys, or someone in the middle), the connection dies during
  key exchange with a clear message and **nothing was sent to the host**.
- **Rotation is deliberate.** Re-pairing (Pair… → save a new fingerprint) is
  yours to do after verifying the change out of band; nothing re-pairs
  automatically, and no gateway answer can ever create or replace a pairing.
- Pairings live in this browser's encrypted local store (`ps.hostPins`,
  encrypted with your sync passphrase), keyed by device id, per device — the
  same treatment as the browser's other known-hosts pins.

## Development against a local/docker gateway

The gateway address on a host entry must be `wss://…`. Plain `ws://` is
refused unless the deployment explicitly opts in via runtime config
(`public/config.js`):

```js
window.POCKETSHELL_WEB = {
  gatewayServerUrl: 'ws://localhost:8080',   // your dev gateway
  gatewayAllowInsecureWs: true,              // the explicit dev flag
};
```

`gatewayAllowInsecureWs` exists so a local or docker-compose gateway
(`pocketshell-gateway-tunnel` worker on a loopback port) can be tested from a
browser; it must stay `false` in any production config, and the refusal is a
config error before any dial, never a silent downgrade.

## Maturity limits (what the gateway transport does not do yet)

- **Crash warnings (`a warnings`) don't sweep gateway hosts.** The automatic
  warnings sweep runs over the legacy bridge transport only, and gateway host
  keys are excluded from that transport by design — a gateway key must never
  travel to the bridge infrastructure. Plain browser-direct hosts are
  excluded too whenever a direct relay is configured (their keys stay in the
  browser); only a deployment with no direct relay keeps the historical
  sweep, because there the bridge IS the host transport. Open a session and
  run `a warnings` yourself to see them; wiring the sweep onto the gateway
  transport itself is future work.
- **Port forwarding is not implemented on any browser transport** (see the
  API surface — it refuses with its own name); gateway hosts add nothing
  there.
- **Desktop and Android do not dial through the gateway yet.** A synced
  gateway host opened from a client without gateway support would attempt a
  plain SSH dial to the entry's hostname:port — that client must refuse
  gateway hosts instead; the web implements the gateway path, the native
  paths are pending, and nothing here claims otherwise.
- One browser SSH engine (ssh2) serves gateway and direct dials alike, so
  terminal/exec/SFTP behave identically; the differences are only the route
  and the trust model described above.
