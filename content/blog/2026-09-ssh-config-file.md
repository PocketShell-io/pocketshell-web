---
title: "The SSH config file: ~/.ssh/config with examples"
slug: ssh-config-file
date: 2026-09-11
published: true
description: "How to use the ~/.ssh/config file: host aliases, per-host keys, wildcards, ProxyJump, connection reuse and includes, with examples and debugging tips."
keywords: [ssh config file, ~/.ssh/config, ssh config example, ssh proxyjump, ssh controlmaster]
---

Typing `ssh deploy@10.0.4.17 -p 2222 -i ~/.ssh/work_ed25519 -o ServerAliveInterval=60`
once is fine, but typing it forty times a week is a configuration problem. SSH already ships the solution: `~/.ssh/config`, a per-user file of saved defaults that turns that command into `ssh staging`.

In this guide you'll meet the parts of the config file that matter in daily work. You'll also get the one semantic rule people trip over, and the debugging moves for a config that isn't doing what you think.

## File locations and read order

OpenSSH reads configuration in this order, with earlier sources winning:

1. Command-line options (`-p`, `-i`, `-o`, ...)
2. The user file `~/.ssh/config`
3. The system file `/etc/ssh/ssh_config`

The user file should be owned by you and not writable by anyone else:

```bash
touch ~/.ssh/config
chmod 700 ~/.ssh
chmod 600 ~/.ssh/config
```

Since OpenSSH 7.3, a `~/.ssh/config` can pull in other files, which is handy for
separating work and personal hosts or keeping shared chunks in version control:

```text
Include ~/.ssh/config.d/*.conf
```

To test a file without touching your real one, use `ssh -F ~/alt-config host`.

## The one rule that causes most confusion

For every parameter, **the first value obtained wins**. Files and patterns are processed top to bottom. Once `HostName`, `User`, or any other option has a value, later matching blocks can't change it. This is the opposite of what most
tools do, and it dictates layout: specific `Host` blocks go at the top, catch-all
defaults at the bottom.

## A working example

This example puts specific hosts first and defaults last:

```text
# ~/.ssh/config — specific hosts first

Host staging
    HostName 10.0.4.17
    User deploy
    Port 2222
    IdentityFile ~/.ssh/work_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 60
    ServerAliveCountMax 3

Host db-prod
    HostName db.internal.example.com
    User admin
    ProxyJump bastion
    IdentityFile ~/.ssh/work_ed25519
    IdentitiesOnly yes

# Defaults — always last
Host *
    AddKeysToAgent yes
    TCPKeepAlive no
```

With this in place, `ssh staging` connects as `deploy` to `10.0.4.17` on port
2222 with the right key, and `ssh db-prod` routes through the jump host
automatically. `IdentitiesOnly yes` deserves a call-out: without it, the client
offers every key in the agent and can trip server-side `MaxAuthTries` limits
before reaching the correct one.

Everything from `scp` to Ansible reads this file, so
`rsync -av ./site/ staging:/var/www` resolves the alias too.

## Wildcards, aliases, and patterns

`Host` patterns match the name you typed on the command line (and, for some
options, the canonical hostname):

```text
Host web-*
    User deploy

Host *.internal
    ProxyJump bastion
    IdentityFile ~/.ssh/work_ed25519

Host bastion !*.internal
    ForwardAgent no
```

A leading `!` negates the match. `Host *` matches everything, which is exactly
why it belongs last. If you place it first, it sets defaults that no later block can override. Aliases can even differ from the real hostname via `HostName`,
which is how `Host db-prod` above maps to a longer internal name.

## Jump hosts with ProxyJump

Since OpenSSH 7.3, `ProxyJump` is the clean way to reach hosts behind a bastion.
It makes a TCP tunnel through the jump host and runs the real SSH session
end-to-end from your machine. The bastion never sees your keys or your agent.
That's a meaningful security advantage over the older agent-forwarding approach
(see [SSH agent forwarding](/blog/ssh-agent-forwarding) for when forwarding is
still the right tool).

```text
Host bastion
    HostName bastion.example.com
    User alexey

Host db-prod
    HostName 172.16.0.9
    ProxyJump bastion
```

Chains work by comma-separating, so `ProxyJump bastion1,bastion2` traverses two
hops in order. On the command line the same thing is
`ssh -J bastion1,bastion2 target`. The older `ProxyCommand ssh -W %h:%p bastion`
still works and remains useful for exotic transports, but prefer `ProxyJump` on
any current OpenSSH.

## Reusing connections

Re-authenticating to the same host repeatedly costs seconds and, with two-factor
authentication, real attention.

Connection multiplexing fixes it:

```text
Host *
    ControlMaster auto
    ControlPath ~/.ssh/sockets/%r@%h-%p
    ControlPersist 10m
```

The first connection becomes the master. Subsequent sessions to the same host
multiplex over its socket instantly, and `ControlPersist 10m` keeps the master
alive for ten minutes after the last session closes. You'll need to create
`~/.ssh/sockets` first. One caveat: a multiplexed session inherits the master's
forwarded agent and environment, which can behave oddly in [long-lived tmux
sessions](/blog/tmux-persistent-ssh-sessions). If in doubt,
`ssh -o ControlPath=none host` bypasses the socket.

## Match blocks for conditional settings

`Match` applies options based on the target, user, or even the result of a
command:

```text
Match host *.dev.example.com user alexey
    IdentityFile ~/.ssh/dev_ed25519

Match final host *.prod
    BatchMode yes
```

`Match exec` runs a shell command and applies the block if it exits zero. That makes it the escape hatch for "use this key only when on the VPN" via something
like `Match exec "nc -z -w1 10.0.0.1 53"`.

## Debugging and common pitfalls

Start here when a config misbehaves:

- **`ssh -G staging`** prints the fully resolved configuration for that host and
  exits. When a connection uses a setting you didn't expect, this is the fastest
  answer.
- **`ssh -v`** shows which config lines and keys were actually used. Use `-vvv`
  if you're truly lost.
- **`Host *` placed first** silently shadows every per-host setting below it. If
  aliases seem ignored, check the order.
- **Bad permissions** (a `config` file that's group- or world-writable) can abort
  connection attempts. OpenSSH refuses some files it considers unsafe.
- **Comments are full lines only.** A `#` after an option on the same line is
  treated as part of the value or rejected, not stripped the way you might
  expect.
- **Leading whitespace is fine** (indentation is conventional, not significant),
  but misspelled keywords are silently ignored, which is another reason `ssh -G`
  should be your first stop.

## The same config on every machine

An alias you rely on is only useful where the file exists, and the config doesn't
follow you by default.

Two practical answers:

- **A dotfiles repo.** Keep `~/.ssh/config` in a private git repository and
  symlink it into place on each machine. Commit the config only, never private
  keys. The hostnames and usernames in it are information about your
  infrastructure, so keep the repo private.
- **Include from a synced folder.** If `~/.ssh` should stay local, keep the
  shared part in whatever folder already syncs between your machines.

The real config then pulls that folder in:

```text
# ~/.ssh/config
Include ~/sync/ssh/*.conf
```

And when the machine you're sitting at is borrowed (an iPad, a locked-down work
laptop where you can't edit `~/.ssh` at all),
[PocketShell](https://pocketshell.io/#security) keeps your saved host list synced to your account end-to-end encrypted. Private keys never sync. The alias follows you even when the config file can't.

## To learn more

These two pick up where this one stops:

- [SSH agent forwarding: what it hands over, and when ProxyJump is better](/blog/ssh-agent-forwarding)
- [tmux sessions that survive SSH disconnects](/blog/tmux-persistent-ssh-sessions)
