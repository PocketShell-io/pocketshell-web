# Feature parity: web vs desktop

The web app (this repo) and the desktop app (`pocketshell-electron`) serve the
same product. This file is the working gap analysis: what the desktop has,
what the web has, what gates each gap, and the order we close them. The stated
preference is to close gaps by REUSING desktop code (a shared, vendored
library) rather than re-implementing it.

## How code is shared today

`scripts/sync-shared.sh` vendors verbatim copies from the desktop repo's
`src/shared/` into `src/shared/` here:

- `types.ts` — the sync contract (`HostEntry`, `ForwardSpec`, payload shapes)
- `syncMerge.ts`, `sync.ts`, `syncConfig.ts` — pull/push/merge rules
- `net.ts`, `sshConfigCore.ts` — shared constants + the pure OpenSSH-config
  directive core (used by the desktop's `SshConfigParser` and this repo's
  `sshConfigImport.ts` wrapper; added 2026-09-15)

Rules: edit in the desktop repo, commit there, run the script here, commit the
refresh. Wrappers stay per-platform: the desktop wrapper owns the filesystem
(`Include` expansion, `~` → absolute paths), the web wrapper owns browser
constraints (no `Include`, `~` kept verbatim, host patterns skipped).

## Gap matrix

| Desktop capability | Web status | Gate |
| --- | --- | --- |
| Google sign-in + account sync of hosts | done (shared contract) | — |
| Host CRUD, encrypted local secrets | done | — |
| Import hosts from `~/.ssh/config` | done (shared core) | — |
| Key + key-passphrase auth to bridge | done | — |
| Write synced hosts BACK to `~/.ssh/config` | missing; pure core exists (`SshConfigWriter`) — web could offer "download generated config" | web-only |
| Terminal (PTY, resize, reconnect) | done (bridge protocol has `session_lost` + one retry) | — |
| OSC52 copy, link hints, mouse selection, path highlights | missing | web-only (xterm addons) |
| Known-hosts verification (TOFU pinning) | missing — the SSH handshake happens inside the bridge, so the client never sees the host key | needs bridge frame (fingerprint in `connected`) |
| Files: SFTP browse/edit (`FileTree`, `CodeEditor`) | missing | needs bridge frames (sftp) |
| Port forwarding panel + traffic counters | `HostEntry` already carries parsed `localForwards`/`remoteForwards`/`proxyJump` (displayed as text only) | needs bridge frames (forward open/close) |
| Sessions: tmux tree, grouping, launch dialogs | missing (web terminal is one raw shell per connect) | needs bridge/helper protocol |
| Agents: composer, slash commands, agent sessions | missing | needs helper + bridge protocol |
| Themes, fonts, settings store | partial (config.js endpoints only) | web-only |
| Update banner | n/a (web deploys continuously) | — |

`needs bridge` items are blocked on the Lambda in `aws-infra`
(sandbox/pocketshell-web) growing the corresponding frames; the web client and
the bridge deploy independently, so each protocol addition should ship with
its client feature.

## Roadmap order (cheapest parity first)

1. **Shared-library hygiene** (this file's "How code is shared" list) — done for
   the parser; next candidate is the `SshConfigWriter` core so export-to-config
   is vendor-not-reimplement.
2. **Web-only terminal polish**: OSC52, link hints — no protocol work.
3. **Host-key pinning**: small bridge addition (server sends host-key
   fingerprint in the `connected` frame; web pins it per host in the local
   envelope and warns on change).
4. **Files over the bridge**: sftp frames (list/read/write/rename/delete), then
   vendor or mirror the desktop's file-model code where it is pure.
5. **Port forwards**: forward frames; the parsed `HostEntry` forward specs feed
   the UI directly.
6. **Sessions/agents**: largest surface; design the bridge/helper protocol
   before any client work.
