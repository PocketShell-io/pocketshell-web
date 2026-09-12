---
title: "How to Keep SSH Sessions Alive: Keepalives, tmux, Mosh"
slug: keep-ssh-session-alive
cover: /images/blog/keep-ssh-session-alive.webp
date: 2026-09-11
description: "Stop SSH freezing on idle: ServerAliveInterval keepalives, server-side timeouts, tmux for detachable sessions, and when mosh is worth installing."
keywords: [keep ssh session alive, ssh session timeout, ServerAliveInterval, mosh vs tmux]
---

Every systems administrator knows the ritual of coming back to a frozen
terminal. You wait for TCP to admit defeat, reconnect, and reconstruct what
you were doing.

"Keeping SSH alive" is two problems with separate fixes.

Idle connections die when middleboxes forget them, so keepalives keep those
healthy. A dropped connection takes your running work with it, and tmux (or
mosh) makes that survivable. You want both.

## Idle connections get forgotten

Your SSH connection is a TCP connection. Every device along the path (home
router, corporate firewall, cloud NAT, load balancer) holds state for it. That
state typically expires after a period of silence. Expect 5 to 15 minutes on
NAT gateways and firewalls, and around 350 seconds on some cloud NATs. When you resume
typing, packets flow into a mapping that no longer exists, nothing comes back, and
the terminal appears to hang while TCP retransmits.

An SSH session goes silent exactly when you do, whether you're reading a long file, thinking, or at lunch. Nothing marks it as live, so idle sessions are the first
casualties.

## Fix 1: client-side keepalives

Tell your SSH client to send an encrypted liveness probe during idle periods.

Put this in `~/.ssh/config` (the [config file guide](/blog/ssh-config-file)
explains how files and blocks are organised):

```text
Host *
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

Every 60 seconds the client sends a probe through the encrypted channel. If
three go unanswered (three minutes), it declares the connection dead and exits
instead of hanging for minutes. The probes refresh the state tables on every NAT
and firewall along the path, because traffic is flowing.

People often ask whether `TCPKeepAlive` already does this. It does, sort of, and
worse: TCP keepalives are unencrypted, and middleboxes frequently filter them. A
brief network change (a laptop roaming between access points) can make the kernel
tear down a session that would have recovered. SSH-level probes ride inside the
connection, tolerate transient blips, and give you a clean failure with a defined
timeout. Setting `TCPKeepAlive no` is a reasonable companion for exactly that
reason.

The only tuning rule: the interval must be comfortably shorter than the shortest
idle timeout in your path. If something in the middle expires connections after
five minutes, a 60-second interval is safe, and a 10-minute one isn't.

## Server-side: reap dead sessions

The mirror image lives in `/etc/ssh/sshd_config`. `ClientAliveInterval 300` and
`ClientAliveCountMax 2` make the server probe the client and close sessions that
stop answering. Without this, laptops that slept leave zombie sessions holding
PTYs and processes until the next reboot. Set both sides deliberately: client
keepalives keep good sessions alive, and server keepalives kill genuinely dead
ones.

## Fix 2: make drops harmless with tmux

Keepalives reduce idle disconnects and nothing else. A `systemctl restart`,
laptop sleep, wifi handoff, or an office fire drill that unplugs your floor
still kills everything running.

So run your work inside tmux on the server, where the session is owned by a
daemon rather than by your TCP connection:

```bash
tmux new -s work      # start a named session
# ... long-running task, editor, tail -f ...
# connection drops — whatever — reconnect and:
tmux attach -t work
```

Four commands cover the day to day:

- `C-b d` detaches manually
- `tmux ls` lists sessions
- `tmux attach -t work` reattaches
- `tmux kill-session -t work` cleans up

Raise the scrollback limit with `set-option -g history-limit 100000` in
`~/.tmux.conf`.

To start tmux automatically on SSH login, add this to the server's `~/.bashrc`:

```bash
if [ -z "$TMUX" ] && [ -n "$SSH_CONNECTION" ]; then
    exec tmux new -A -s main
fi
```

Here `$TMUX` prevents nesting sessions, and `$SSH_CONNECTION` leaves local logins
alone. The `-A` flag attaches to an existing session or creates a new one. GNU
`screen -R` works the same way if that's what's installed, but tmux is the
modern default. Panes inherit
`SSH_AUTH_SOCK` from when they started, so long-lived tmux sessions on jump hosts
can hold a stale agent socket. See [the agent forwarding guide](/blog/ssh-agent-forwarding) for the fix.

## Fix 3: mosh for unreliable networks

[mosh](https://mosh.org) replaces the connection model entirely: it uses SSH only
for initial authentication, then switches to UDP (ports 60000–61000 by default).
You get a session that survives IP changes, sleep/wake cycles, and minutes of
disconnection, with instant local echo that makes laggy links feel usable.

The trade-offs decide whether mosh fits:

- mosh must be installed on both ends, and on the server you likely need root or sudo
- the UDP ports must be open in every firewall along the path
- it doesn't support port forwarding or agent forwarding at all

Native scrollback is limited, which is why mosh and tmux are usually
installed as a pair. If your problem is a freezing idle session on a stable
network, mosh is overkill. But if your problem is working from trains and
conference wifi, nothing else compares.

## A quick decision guide

Match the row to your setup:

- Sessions freeze when idle, network is stable: client keepalives, done.
- Long tasks must survive anything: keepalives plus tmux on the server.
- Roaming between networks, hostile wifi: mosh plus tmux.
- Shared servers filling up with dead sessions: `ClientAliveInterval` on the server.

## Common pitfalls

These cover most of the pain:

- Keepalive timeouts that conflict between client and server make failures
  hard to reason about, so pick one policy per host and document it.
- Assuming keepalives protect your work. They protect only the connection, so
  anything you care about belongs in tmux, `nohup`, or `systemd-run --scope`
  before you walk away.
- Nested tmux when both your laptop and a remote host auto-attach: check
  `tmux ls` and `$TMUX` before fighting the status bar.
- Mosh behind NAT without open UDP port ranges fails confusingly after a
  successful SSH handshake, because the working handshake hides the UDP
  problem.

## The payoff

Once your session state lives on the server, the client stops mattering.
Reattach to the same session from an iPad, a borrowed Chromebook, or a work
laptop you can't install software on. It makes no difference whether the
session is tmux or an [aplexer agent session](/blog/aplexer-agent-multiplexer).

A browser-based client like [PocketShell](https://pocketshell.io/#faq) is
built for exactly this. Sign in with Google and pick a host. The list syncs
end-to-end encrypted from your desktop app. The full terminal opens in the
tab, and the server needs nothing beyond plain SSH.
