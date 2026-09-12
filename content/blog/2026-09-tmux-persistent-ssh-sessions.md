---
title: "Stop losing work when SSH drops: tmux sessions that survive anything"
slug: tmux-persistent-ssh-sessions
cover: /images/blog/tmux-persistent-ssh-sessions.webp
date: 2026-09-11
featured: true
published: true
description: "Why SSH sessions die with the connection, how tmux keeps your work running on the server, and the commands that let builds and AI agents survive disconnects."
keywords: [tmux, ssh session disconnects, tmux attach, keep processes running ssh, tmux tutorial]
---

It's a rite of passage every systems admin knows. You're 40 minutes into a build,
your laptop suspends or the café Wi-Fi hiccups, and everything in the SSH session
is gone. The process died with the connection, because it was a child of your
login shell.

tmux breaks that dependency: your programs run inside a session that lives on
the server, and the SSH connection is just a window into it. Close the window,
on purpose or by accident, and the session keeps going.

## The five commands you actually need

tmux lives in every distro repository, so if it's missing, one command
installs it: `sudo apt install tmux` on Debian/Ubuntu or
`sudo dnf install tmux` on Fedora.

Run these five and you have the whole workflow:

```bash
tmux new -s deploy     # start a named session
tmux detach            # or Ctrl+b, then d — session keeps running
tmux ls                # list sessions on this server
tmux attach -t deploy  # reattach from anywhere
tmux kill-session -t deploy
```

Detach before you close the laptop, or don't: a dropped connection counts as a detach once the server notices. Go home and run `tmux attach -t deploy` from any machine. Your scrollback, panes, and running processes are exactly where you left them.

## Reattach automatically on connect

tmux means a disconnect costs you one command instead of your work. Make that
command zero, too.

This in `~/.bashrc` on the server drops every interactive login straight into
a session named `main`, reattaching when it already exists:

```bash
if command -v tmux >/dev/null && [ -z "$TMUX" ]; then
    tmux attach -t main 2>/dev/null || tmux new -s main
fi
```

Two details keep this from biting you. Place it below the interactivity guard at
the top of most default `.bashrc` files (the `case $- in *i*` line), so
non-interactive sessions like `scp`, `rsync`, and `git` over SSH never trigger
it. The `$TMUX` check stops shells opened inside tmux from nesting sessions. If
you would rather not touch `.bashrc` at all, `tmux new -A -s main` attaches to
`main` or creates it.

Automatic reattach only helps if you notice the drop. These settings in
`~/.ssh/config` on your laptop make a dead connection fail fast instead of
hanging forever.

The full tour of [the `~/.ssh/config` file](/blog/ssh-config-file) covers where
this belongs:

```text
Host *
    ServerAliveInterval 30
    ServerAliveCountMax 4
```

The client now sends a probe every 30 seconds and declares the connection dead
after 4 unanswered probes (about 2 minutes) instead of never. You find out
quickly, reconnect, and `main` is still there.

## Long-running agents and builds

tmux has quietly become the standard way to run terminal AI agents (Claude Code,
Codex CLI) on a remote box. Start the agent in a named session, detach, and check in from anywhere. The same approach covers `rsync` of a big dataset,
database migrations, and compile farms. It's the same for anything you'd hate to
restart because of a train tunnel.

Two tips for this style of work:

- Name sessions by task (`agent`, `migrate`, `logs`), not by date. `tmux ls`
  becomes a to-do list of what's still running.
- Use panes for supervision. `Ctrl+b %` splits the window into side-by-side
  panes, so the agent runs in one and `tail -f` on its logs in the other. The
  layout is part of the session, so it's still there when you reattach.

## tmux vs screen

GNU screen does the same job and you'll meet it on older servers. tmux is the
default choice in 2026. It has saner keybindings, status bar customization, and
scripting via `tmux send-keys` (handy for kicking off jobs from cron). Learn tmux,
and read screen's man page the one time you SSH into a fossil.

## One more way this pays off

Attaching to a tmux session only needs a terminal, not your terminal. That's
the idea behind [PocketShell](https://pocketshell.io/#faq): your SSH hosts are in
your account, and a browser tab on any machine is a real terminal to them.

## The better alternative when the panes hold agents

For shell work, tmux stays the right answer and everything above applies as
written.

When your sessions hold AI coding agents, switch to
[aplexer](/blog/aplexer-agent-multiplexer) instead. It's the better tmux
alternative for agent work. Every session has a workspace, a tag, and an
engine. `a list` shows whether Claude Code, Codex, or OpenCode is running
inside and whether
it's working or waiting. That beats remembering which pane held which job,
and it's the session layer PocketShell runs on.

## To learn more

Keep going with these:

- [aplexer: an agent multiplexer for AI coding agents](/blog/aplexer-agent-multiplexer)
- [Run AI agents on a remote machine over SSH](/blog/ssh-ai-agents-remote-machines)
- [Stop idle sessions freezing: keepalives, tmux, mosh](/blog/keep-ssh-session-alive)
- [Use screen to keep SSH sessions alive (the classic alternative)](https://embedjournal.com/screen-keep-ssh-sessions-alive-between-connections/)
- [How to keep processes running after ending an SSH session (Ask Ubuntu)](https://askubuntu.com/questions/8653/how-to-keep-processes-running-after-ending-ssh-session)
