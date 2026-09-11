---
title: "How to Keep SSH Sessions Alive: Keepalives, tmux, Mosh"
slug: keep-ssh-session-alive
date: 2026-09-11
description: "Stop SSH freezing on idle: ServerAliveInterval keepalives, server-side timeouts, tmux for detachable sessions, and when mosh is worth installing."
keywords: [keep ssh session alive, ssh session timeout, ServerAliveInterval, mosh vs tmux]
---

Every systems administrator knows the ritual: come back to a terminal, find it frozen mid-prompt, wait for TCP to admit defeat, reconnect, and try to reconstruct what you were doing. "Keeping SSH alive" is actually two separate problems with separate fixes. First, connections dying during idle periods. Second, losing your shell and running work when a connection drops for any reason — sleep, roaming, a train tunnel. Keepalives address the first; tmux (or mosh) makes the second survivable. You want both.

## Why sessions freeze in the first place

Your SSH connection is a TCP connection, and every device along the path — home router, corporate firewall, cloud NAT, load balancer — holds state for it. That state typically expires after a period of *silence*, often 5 to 15 minutes on NAT gateways and firewalls, and around 350 seconds on some cloud NATs. When you resume typing, packets flow into a mapping that no longer exists, nothing comes back, and the terminal appears to hang while TCP retransmits.

An SSH session is silent exactly when you are: reading a long file, thinking, at lunch. Nothing marks it as live, so idle sessions are the first casualties.

## Fix 1: client-side keepalives

Tell your SSH client to send an encrypted liveness probe during idle periods. In `~/.ssh/config` (see the [config file guide](/blog/ssh-config-file) for how files and blocks are organised):

```text
Host *
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

Every 60 seconds the client sends a probe through the encrypted channel; if three go unanswered (three minutes), it declares the connection dead and exits instead of hanging for minutes. This refreshes the state tables on every NAT and firewall along the path, because traffic is flowing.

A common question: isn't this what `TCPKeepAlive` does? Sort of — and worse. TCP keepalives are unencrypted, frequently filtered by middleboxes, and a brief network change (laptop roaming between access points) can make the kernel tear down a session that would have recovered. SSH-level probes ride inside the connection, tolerate transient blips, and give you a clean failure with a defined timeout. Setting `TCPKeepAlive no` is a reasonable companion for exactly that reason.

The only tuning rule: the interval must be comfortably shorter than the shortest idle timeout in your path. If something in the middle expires connections after five minutes, a 60-second interval is safe; a 10-minute one is not.

### Server-side: reap dead sessions

The mirror image lives in `/etc/ssh/sshd_config`. `ClientAliveInterval 300` and `ClientAliveCountMax 2` make the server probe the client and close sessions that stop answering. Without this, laptops that slept leave zombie sessions holding PTYs and processes until the next reboot. Set both sides deliberately: client keepalives keep good sessions alive, server keepalives kill genuinely dead ones.

## Fix 2: make drops harmless with tmux

Keepalives only reduce disconnections. They do nothing for `systemctl restart`, laptop sleep, wifi handoff, or the office fire drill that unplugs your floor. The durable fix is running your work inside **tmux on the server**, where the session is owned by a daemon, not by your TCP connection:

```bash
tmux new -s work      # start a named session
# ... long-running task, editor, tail -f ...
# connection drops — whatever — reconnect and:
tmux attach -t work
```

The essentials: `C-b d` detaches manually, `tmux ls` lists sessions, `tmux attach -t work` reattaches, `tmux kill-session -t work` cleans up. Increase scrollback with `set-option -g history-limit 100000` in `~/.tmux.conf`. To land in tmux automatically on SSH login, add this to the server's `~/.bashrc`:

```bash
if [ -z "$TMUX" ] && [ -n "$SSH_CONNECTION" ]; then
    exec tmux new -A -s main
fi
```

The guards matter: `$TMUX` prevents nesting sessions, and `$SSH_CONNECTION` leaves local logins alone. (`new -A` attaches to the session or creates it.) GNU `screen -R` works the same way if that is what is installed; tmux is the modern default. One interaction worth knowing: panes inherit `SSH_AUTH_SOCK` from when they started, so long-lived tmux sessions on jump hosts can hold a stale agent socket — see [the agent forwarding guide](/blog/ssh-agent-forwarding) for the fix.

## Fix 3: mosh for unreliable networks

[mosh](https://mosh.org) replaces the connection model entirely: it uses SSH only for initial authentication, then switches to UDP (ports 60000–61000 by default). The result is a session that survives IP changes, sleep/wake cycles, and minutes of disconnection, with instant local echo that makes laggy links feel usable.

The trade-offs: mosh must be installed on both ends (and on the server you likely need root or sudo), the UDP ports must be open in any firewall in the path, and it does not support port forwarding or agent forwarding at all. Native scrollback is limited, which is one reason mosh and tmux are usually installed as a pair. If your problem is a freezing idle session on a stable network, mosh is overkill; if your problem is working from trains and conference wifi, nothing else compares.

## A quick decision guide

- **Sessions freeze when idle, network is stable:** client keepalives, done.
- **Long tasks must survive anything:** keepalives plus tmux on the server.
- **Roaming between networks, hostile wifi:** mosh plus tmux.
- **Shared servers filling up with dead sessions:** `ClientAliveInterval` on the server.

## Common pitfalls

- **Both keepalive directions configured with conflicting timeouts** makes failures hard to reason about; pick one policy per host and document it.
- **Assuming keepalives protect work.** They protect the *connection*. Anything you care about belongs in tmux, `nohup`, or `systemd-run --scope` before you walk away.
- **Nested tmux** when both your laptop and a remote host auto-attach: check `tmux ls` and `$TMUX` before fighting the status bar.
- **Mosh behind NAT without port ranges opened** fails confusingly after a successful SSH handshake — the SSH part working is exactly what hides the UDP problem.

## The payoff

Once your session state lives on the server, the client stops mattering. You can reattach to the same tmux session from an iPad, a borrowed Chromebook, or a work laptop you cannot install software on — which is the situation a browser-based client like [PocketShell](https://pocketshell.io/#faq) is built for: sign in with Google, pick a host (the list syncs end-to-end encrypted from your desktop app), and the full terminal opens in the tab, with the server needing nothing beyond plain SSH.
