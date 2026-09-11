# PocketShell blog: keyword research & content plan

Date: 2026-09-11. Grounded in live search-result scans (sources at the bottom).

## Strategy

PocketShell's audience searches for **SSH how-tos, not "web SSH client"** (that
latter query is dominated by Termius/Blink comparison sites we can't beat yet).
So the plan is: rank for evergreen SSH problems, and mention PocketShell once,
naturally, where it genuinely solves a pain the article just described
(e.g. "you can do this whole flow from a browser tab"). One mention per post,
after the reader got full value. No pricing talk, no "switch to us".

## Cluster 1 — AI agents over SSH (primary, timely, low competition)

This cluster is growing fast (Claude Code / Codex CLI on remote boxes) and the
existing results are forum threads and half-working scripts — beatable.

| Keyword | Intent | Post | PS mention |
|---|---|---|---|
| run claude code on remote server | how-to | ✅ drafted: `2026-09-ssh-ai-agents-remote-machines.md` | yes, end |
| codex cli headless ssh authentication | how-to | same post, own H2 | yes |
| ai agent ssh remote machine setup | how-to | same post | yes |
| keep claude code running after ssh disconnects | how-to | ✅ drafted: `2026-09-tmux-persistent-ssh-sessions.md` | yes |
| configure remote server with ai agent | how-to | same as row 1 | yes |

## Cluster 2 — Evergreen SSH fundamentals (high volume, competitive but durable)

| Keyword | Intent | Post (outline) | PS mention |
|---|---|---|---|
| ssh config file example / ssh config aliases | how-to | `~/.ssh/config` from zero: Host blocks, wildcards, per-host keys/ports, `Include`, multiplexing (`ControlMaster`/`ControlPersist`), `ProxyJump`. Final section: "your config on every machine" — sync problem → PS keeps the host list in your account | light |
| ssh tunnel / port forwarding tutorial | how-to | Local/remote/dynamic forwarding with real examples (Jupyter, Postgres, SOCKS proxy), `ServerAliveInterval`, troubleshooting. PS mention only in "further reading" | minimal |
| permission denied (publickey) | troubleshooting | Decision-tree post: key perms (600/700), `ssh -v`, `authorized_keys` format, SELinux restorecon, agent forwarding vs ProxyJump. PS mention: not needed — pure SEO play | none |
| ssh key management best practices | how-to | ed25519 vs RSA, passphrases + ssh-agent, `Keychain`/`keychain` tool, rotation, hardware keys (`-sk`), authorized_keys options (restrict, from=). PS: none | none |
| ssh into ec2 instance / connect to VPS | how-to | ".pem → permanent setup" post: move key, config entry, user choice (ubuntu/ec2-user/admin), security groups, session manager alternative. PS mention: connect from any machine afterward | light |

## Cluster 3 — Mobile & browser server admin (closest to buying intent)

| Keyword | Intent | Post (outline) | PS mention |
|---|---|---|---|
| ssh from ipad / iphone / android | how-to | Honest landscape: Termius, Blink, TermAI, mobile-terminal apps; keyboard/Mosh realities; then "or none of the above — a browser tab" (PS) | yes, as one option |
| browser based ssh client | commercial | Roundup post — list competitors honestly *including ourselves as one row*. Ranks eventually, converts well | yes |
| manage server from chromebook / locked-down laptop | how-to | Corporate-laptop angle: no installs allowed, browser is your only tool → SSH in a tab | yes |
| raspberry pi remote access | how-to | Classic Pi post: enable SSH, keys, dynamic DNS, Tailscale, port-forwarding warnings. PS mention: check on the Pi from your phone | light |

## Cluster 4 — Terminal workflow (top/mid funnel)

| Keyword | Intent | Post (outline) | PS mention |
|---|---|---|---|
| tmux vs screen | informational | Comparison + cheat-sheet table; "which should you learn in 2026" | light |
| ssh keeps disconnecting / timeout | troubleshooting | `ServerAliveInterval`, NAT timeouts, MTU, Mosh, autossh. PS: reconnects are cheap when the terminal is a tab | light |
| dotfiles management | how-to | The "same environment everywhere" problem (dotfiles repos, bare git). PS mention: same problem for hosts | light |

## Cadence

1/week. Order: AI-agents post → tmux post → ssh-config → permission-denied →
mobile SSH → tunneling → rest. Each post: ≥1 working code block per H2, no
fluff intro, `Further reading` linking 2–3 other cluster posts (internal
linking matters more than any single keyword).

## Research sources

- [How to log into Codex CLI on a remote server](https://medium.com/@djangoist/how-to-log-into-codex-cli-on-a-remote-server-0798162da0b2)
- [Script that allows you to use Codex CLI in remote SSH (r/ChatGPTCoding)](https://www.reddit.com/r/ChatGPTCoding/comments/1n4vqg2/script_that_allows_you_to_use_codex_cli_in_remote/)
- [How I code from the gym — any AI tool, one command (SSH + tmux)](https://stacktoheap.com/blog/2026/02/15/how-i-code-from-the-gym-part-2/)
- [SSH Connection Manager: run AI agents on a remote server (agentsroom.dev)](https://agentsroom.dev/features/ssh-connections)
- [15 SSH Config Tricks That Save You Hours](https://medium.com/@obaff/15-ssh-config-tricks-that-save-you-hours-4ac68ecc3e4f)
- [SSH Config File: Hosts, Keys, ProxyJump & Examples (GoLinuxCloud)](https://www.golinuxcloud.com/ssh-config/)
- [tmux for Beginners: Keep Your SSH Work Running](https://alanmervitz.com/2026/03/07/tmux-for-beginners-keep-your-ssh-work-running/)
- [Use screen to keep SSH sessions alive between connections](https://embedjournal.com/screen-keep-ssh-sessions-alive-between-connections/)
- [Keep Claude Code Running After SSH Disconnects (tmux guide)](https://codeongrass.com/blog/how-to-keep-claude-code-running-after-terminal-close/)
- [Best SSH clients for iPad in 2026 (TermAI)](https://termai.sh/blog/best-ssh-client-ipad)
- [Termius — free SSH client for iPad](https://termius.com/free-ssh-client-for-ipad)
