---
title: "SSH Agent Forwarding: Setup, Risks, and Safer Paths"
slug: ssh-agent-forwarding
date: 2026-09-11
published: true
description: "How SSH agent forwarding works, how to enable it with ForwardAgent and ssh-add -h, the real security risks, and when ProxyJump is the better choice."
keywords: [ssh agent forwarding, ForwardAgent, ssh-add, ssh proxyjump]
---

If you have ever SSHed into a bastion host and then tried to `git pull` or hop to a second server, you have hit the problem agent forwarding solves: your private key lives on your laptop, but the machine you are on now needs to authenticate somewhere else. The wrong fix is copying your key to the bastion. The right fix is letting the remote host borrow your local agent — carefully, and with an understanding of what you are actually handing over.

## What the SSH agent actually does

`ssh-agent` is a small background process that holds decrypted private keys in memory. When you connect to a host, the SSH client asks the agent to perform a signing operation; the key itself never leaves the agent's memory and never touches disk while it is loaded. The client finds the agent through the `SSH_AUTH_SOCK` environment variable, which points at a Unix domain socket.

Load keys with `ssh-add`:

```bash
ssh-add                      # adds the default identities (~/.ssh/id_ed25519, etc.)
ssh-add -l                   # list loaded keys (fingerprints)
ssh-add -d ~/.ssh/id_ed25519 # remove a specific key
ssh-add -D                   # remove all keys
```

Two options are worth adopting as habits. `ssh-add -t 4h` keeps the key loaded for four hours, after which the agent forgets it. `ssh-add -c` makes the agent demand confirmation (via `SSH_ASKPASS`) before every signing operation, so a rogue process cannot silently use your key.

You can also skip manual `ssh-add` entirely. Since OpenSSH 7.2, this in `~/.ssh/config` loads a key into the agent the first time you use it:

```text
Host *
    AddKeysToAgent yes
```

Since OpenSSH 8.9 the directive also accepts a lifetime, so `AddKeysToAgent 8h` adds keys on use and expires them after eight hours.

## Enabling agent forwarding

Forwarding is off by default. Enable it per host in `~/.ssh/config`:

```text
Host bastion
    HostName bastion.example.com
    User alexey
    ForwardAgent yes
```

or once, on the command line: `ssh -A bastion`. The config entry is the better habit — `ssh -A` is easy to fire off reflexively, while a per-host `ForwardAgent yes` keeps forwarding off for every host you have not consciously enabled it for. When you connect, the client asks the remote `sshd` to create a new Unix socket on that host (usually under `/tmp/ssh-XXXXXX/agent.<pid>`), tunnels it back to your local agent, and sets `SSH_AUTH_SOCK` on the remote side to point at it.

Verify from inside the remote session:

```bash
echo "$SSH_AUTH_SOCK"
# /tmp/ssh-QXth4z8BhR/agent.21431

ssh-add -l
# 256 SHA256:AbCd... alexey@laptop (ED25519)
```

If `ssh-add -l` shows your local fingerprints on the remote host, forwarding works: any connection *from* that host to a third machine can now authenticate as you.

## Why forwarding is risky

Agent forwarding does not copy your key, but it does something nearly as powerful: it exposes your agent's socket on the remote host. Anyone who can open that socket — root, most obviously, and any process running as your user — can ask your agent to sign authentication requests. They never see the key, but for as long as the forwarded socket exists they can impersonate you on every other host your key can reach.

This is the standard caveat, and it deserves emphasis: **only forward your agent to machines you trust as much as your own laptop.** A shared build box, a university login server, or any multi-tenant bastion is a poor place for `ForwardAgent yes`. A compromised intermediary can also keep the hijacked agent usable beyond your logout by holding an open connection to the socket.

If you like the idea of a key that never has to exist anywhere beyond the machine in front of you, that is exactly how [PocketShell](https://pocketshell.io/#security), a browser-based SSH client, handles private keys: they never sync at all — one is entered per host, stored encrypted in that one browser, and used in memory when you connect.

## Safer forwarding with destination constraints

OpenSSH 8.9 added a middle ground: destination constraints. When adding a key, you declare which hops the agent may ever use it for, even if the socket is stolen:

```bash
ssh-add -h bastion.example.com \
        -h 'bastion.example.com>deploy@web01.internal' \
        ~/.ssh/id_ed25519
```

The first constraint allows the origin-to-bastion hop. The second, in `src>dst` form, allows the key to be used through the bastion to reach `web01.internal` as `deploy` — and nowhere else. If someone on the bastion grabs the socket and points it at an unrelated server, the agent refuses to sign. Combined with `-t` (a lifetime) this shrinks both the blast radius and the window. It requires no changes on the server side, only a modern client — and OpenSSH 8.9 is more than four years old at this point.

## When you do not need forwarding at all

Before reaching for `-A`, check whether the newer tool removes the need:

- **`ProxyJump` (OpenSSH 7.3+).** For host-to-host hopping, `ssh -J bastion web01` tunnels your TCP connection *through* the bastion. The SSH session runs end-to-end between your laptop and `web01`; the bastion only relays encrypted bytes and never sees your key or your agent. This is the default answer for "I need to reach an internal server via a jump host."
- **Deploy keys and machine users.** For `git pull` on a server, a deploy key scoped to one repository is far better than your personal identity. Git hosting providers all support them, and a leaked deploy key is much easier to contain.
- **Short-lived certificates.** Organizations running an SSH certificate authority issue keys that expire in hours; the agent's value drops when every key is ephemeral anyway.

Rule of thumb: use `ProxyJump` for connectivity, agent forwarding only when a *remote-originated* connection genuinely must authenticate as you, and destination constraints whenever it does.

## Troubleshooting: common pitfalls

- **Forwarding enabled on the wrong hop.** `ForwardAgent yes` must apply to the host you connect *to* (the bastion), not the final target. Enabling it in a `Host *` block forwards your agent everywhere, which is the worst of both worlds — see [the `~/.ssh/config` guide](/blog/ssh-config-file) for per-host blocks.
- **`SSH_AUTH_SOCK` is empty on the remote.** Check that `AllowAgentForwarding` has not been set to `no` in `sshd_config`, and that the remote shell's rc files are not overwriting the variable.
- **tmux on the remote has stale sockets.** Panes started under an earlier login keep that login's `SSH_AUTH_SOCK`, which disappears when the session ends. For shells you open afterward, publish the current socket globally right after connecting: `tmux set-environment -g SSH_AUTH_SOCK "$SSH_AUTH_SOCK"`. In an already-running pane, re-point it at the newest socket: `export SSH_AUTH_SOCK=$(ls -t /tmp/ssh-*/agent.* 2>/dev/null | head -1)`. More on this pattern in [tmux sessions that survive SSH disconnects](/blog/tmux-persistent-ssh-sessions).
- **`sudo git pull` fails.** `sudo` strips the environment, so the agent socket is lost. Use `sudo -E` (preserves `SSH_AUTH_SOCK`), or better, check out with the deploy key of the user you are sudoing into.
- **Works interactively, fails in scripts.** Non-interactive SSH sessions may not source the profile that sets `SSH_AUTH_SOCK`; test with `ssh -t host 'ssh-add -l'` to reproduce what a login shell sees.

## Further reading

- [The `~/.ssh/config` file: aliases, ProxyJump, and multiplexing](/blog/ssh-config-file)
- [Run AI agents on a remote machine over SSH](/blog/ssh-ai-agents-remote-machines)
