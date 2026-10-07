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
- Your **Google sign-in only admits the route** (and only to hosts registered
  to your own account). The thing that logs you into the host is your **SSH
  private key**, which lives in this browser and never crosses the gateway.
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

## Setting up a new gateway host

1. **On the host**: install and enroll the gateway agent (see the gateway
   server/agent docs). Enrollment registers the device — it prints a
   **device id** (e.g. `home-laptop`) — and shows the host's **SSH host key
   fingerprint** (`SHA256:…`).
2. **In the browser, Hosts → Add host**: fill in name/hostname/user as usual,
   then set **Gateway device id** to what enrollment printed. Leave
   **Gateway address** alone unless you run your own gateway.
3. **Attach your SSH key** with **Key…** — same as any host. Gateway
   connections are key-only; a password login is never attempted.
4. **Pair the host** with **Pair…**: paste the host's `SHA256:…` fingerprint.
   Get it from the host itself — the agent's enrollment screen, or by running
   this on the host over a connection you already trust:

   ```
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

5. **Connect.** The first bytes flow only after: the gateway admitted your
   token, the host's agent answered, and the host presented the exact key you
   paired.

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
  travel to the bridge infrastructure. Gateway hosts therefore stay out of
  the sweep (before their secrets are even decrypted); open a session and run
  `a warnings` yourself to see them. Wiring the sweep onto the gateway
  transport itself is future work.
- **Port forwarding is not implemented on any browser transport** (see the
  API surface — it refuses with its own name); gateway hosts add nothing
  there.
- Desktop and Android have their own transports; nothing on this page claims
  they dial through the gateway.
- One browser SSH engine (ssh2) serves gateway and direct dials alike, so
  terminal/exec/SFTP behave identically; the differences are only the route
  and the trust model described above.
