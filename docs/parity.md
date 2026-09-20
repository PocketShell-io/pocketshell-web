# Feature parity: web vs desktop

The web app (this repo) and the desktop app (`pocketshell-desktop`) serve the
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
- `osc52.ts` — the OSC 52 clipboard decoder the terminal pane answers remote
  yanks with (moved to the desktop's `src/shared/` so both panes run the same
  refusals; added 2026-09-15)
- `aplexer.ts` — the session manager's types, sort key, and join command, so
  the web workspace speaks the host's `a` CLI with the desktop's exact
  sentences (added 2026-09-19)
- `shellQuote.ts`, `userBinPath.ts` — POSIX quoting and the user-bin PATH
  list both clients' probe/wrap/join commands are built from (added 2026-09-19)
- `knownHostsCore.ts` — the pure host-key half both clients verify with: the
  `[host]:port` token, the trusted/mismatch/unknown verdict, and the RFC 4251
  blob decode, so a browser pin and a known_hosts line classify a key with
  the same rules (added 2026-09-20)

Rules: edit in the desktop repo, commit there, run the script here, commit the
refresh. Wrappers stay per-platform: the desktop wrapper owns the filesystem
(`Include` expansion, `~` → absolute paths), the web wrapper owns browser
constraints (no `Include`, `~` kept verbatim, host patterns skipped).

## The sessions workspace (web twin of the desktop's host workspace)

On a configured relay (`config.directWsUrl`) the browser speaks SSH itself
(`src/terminal/connection.ts` — one `SshConnection` per host visit, many
channels), and `/term/:name` renders `HostWorkspaceView` instead of the
single raw-shell terminal:

- **Sidebar** — the host's live sessions grouped by workspace path, in the
  order the host's `a snapshot --json --sort accessed` returns (the host's
  order IS the panel's order, as on desktop). Rows show tag, engine, activity
  age, and per-row rename/stop.
- **Tabs** — one terminal per joined session. A join runs the vendored
  `aplexerAttachCommand` (by UUID) directly under an exec-with-PTY channel —
  the desktop's `'exec'` command mode, so no login shell delays the join.
  A host without `a` gets one raw shell tab: the pre-workspace behaviour with
  a tab bar around it.
- **Actions** — `a start/kill/rename/ack` through
  `src/aplexer/client.ts`, the browser twin of the desktop's
  `helper/AplexerClient.ts`: same commands, PATH-wrapped once, same
  classifier sentences (`already belongs to`, `no matching session`,
  `unexpected argument`), same total contracts (never throws for anything
  the host does).
- **Status bar** — the active tab's `workspace:tag` selector, engine, phase,
  plus session/open counts.
- **Crash warnings** — the issue #1 banner, now fed by the shared connection's
  exec channel (`warningsParse.ts` is the pure half; the ephemeral-bridge
  runner in `warnings.ts` remains for the bridge-mode terminal).

The controller (`src/workspace/controller.ts`) is framework-free: the five
seconds poll, tab lifecycle, and actions are unit-tested without a DOM, and
the Vue view is chrome + xterm wiring only.

## Gap matrix

| Desktop capability | Web status | Gate |
| --- | --- | --- |
| Google sign-in + account sync of hosts | done (shared contract) | — |
| Host CRUD, encrypted local secrets | done | — |
| Import hosts from `~/.ssh/config` | done (shared core) | — |
| Key + key-passphrase auth | done (browser-direct; bridge mode kept) | — |
| Terminal (PTY, resize, reconnect) | done (bridge: `session_lost` + retry; direct: one `SshConnection`, many channels) | — |
| OSC52 copy, URL links | done (vendored `shared/osc52.ts`; web-links addon) | — |
| Sessions: tree, grouping, launch/stop/rename dialogs, tabs | done over direct SSH (see above); hosts without `a` keep the plain shell | — |
| Session composer, agent launch (`pocketshell agent …`), slash commands | done 2026-09-20: launch-line builder + command catalog vendored (`shared/agentLaunch.ts` + `agentCommands.ts` + `composerSend.ts`, fixture-pinned); session composer with slash palette (`workspace/composer.ts`); agent launch picker (`workspace/agentProbe.ts`) | web-only work |
| Files: SFTP browse/edit (`FileTree`, `CodeEditor`) | missing | direct path can use ssh2's SFTP; bridge needs sftp frames |
| Port forwarding panel + traffic counters | `HostEntry` already carries parsed forward specs (displayed as text only) | **cannot listen on a browser** — local forwards need a desktop/CLI companion; remote forwards could ride an exec |
| Known-hosts verification (TOFU pinning) | done 2026-09-20 (direct mode): unknown key → first-connect prompt (once / pin / cancel), pin stored envelope-encrypted per browser (`ps.hostPins`), changed key → hard block + "Host key changed" panel with a remove-pin remedy; classification is the shared `knownHostsCore.ts` | pins are per-browser (the desktop's known_hosts is per-machine too); bridge mode keeps accept-always |
| Path links/highlights, Files-tab extras | waits on Files parity | — |
| Themes, fonts, settings store | partial (config.js endpoints only) | web-only |
| Update banner | n/a (web deploys continuously) | — |

Port forwarding is the one capability a browser tab cannot provide outright:
a tab may not open listening sockets. Remote forwards (`ssh -R`) could be
attempted over an exec channel, but local forwards need something outside the
tab (desktop app, CLI, or a WebRTC/relay helper).

## Roadmap order (cheapest parity first)

1. **Shared-library hygiene** — done for the parser core, OSC52, the
   aplexer session layer, and the agent launch line (`agentLaunch.ts` +
   `agentCommands.ts` + `composerSend.ts`, vendored 2026-09-20); next
   candidate is the `SshConfigWriter` core (export-to-config).
2. **Sessions workspace** — done 2026-09-19 (sidebar, tabs, launch/stop/
   rename, warnings ack, status bar, drawer sidebar on touch widths).
3. **Composer + agent launch** — done 2026-09-20 (launch-line builder +
   session composer with the slash palette + agent launch picker).
4. **Host-key pinning** — done 2026-09-20: the desktop's hostVerifier body
   extracted to `shared/knownHostsCore.ts`; the web pauses the handshake on an
   unknown key (ssh2's async hostVerifier), pins on accept, hard-blocks and
   offers the remove-pin remedy on change.
5. **Files over SFTP** — ssh2 speaks SFTP on the direct path; the bridge
   path needs frames.
6. **Port forwarding** — blocked by the browser sandbox (see matrix); decide
   the companion story before building UI.
