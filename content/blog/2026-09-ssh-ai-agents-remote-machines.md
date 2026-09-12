---
title: "Configuring a remote machine over SSH with AI agents"
slug: ssh-ai-agents-remote-machines
cover: /images/blog/ssh-ai-agents-remote-machines.png
date: 2026-09-11
featured: true
published: true
description: "How to run Claude Code or Codex CLI on a remote server over SSH: key-based access, a sandboxed user, headless authentication, and aplexer sessions for long-running jobs."
keywords: [ssh, claude code remote server, codex cli headless, ai agent ssh, configure remote server]
---

AI coding agents are at their best on a box that isn't your laptop. Think a cheap VPS for staging, a beefy build server, or a Raspberry Pi on your desk. The agent gets a real shell on that machine, and you get your CPU
back. Everything you take for granted locally has to be set up deliberately
over SSH. Nothing is there by default: the dotfiles, the logged-in
browser, the terminal that survives a Wi-Fi blip.

I wrote down the setup I wish I'd had on day one. It works the same for Claude
Code, Codex CLI, Gemini CLI, or any other terminal-based agent.

## 1. Get key-based SSH access right first

If you're still typing passwords, fix that before anything else:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "you@laptop"
ssh-copy-id user@your-server
```

Then stop typing flags by putting the host in `~/.ssh/config`:

```text
Host build
    HostName build.example.com
    User alexey
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
```

`ssh build` now works, and `ServerAliveInterval` keeps the connection from being
dropped by NAT middleboxes. You'll want that while an agent runs for twenty
minutes between your keystrokes.

## 2. Create a dedicated user for the agent

Don't run an autonomous agent as your main account, and never as root.

Give it its own user with just enough access:

```bash
sudo useradd -m -s /bin/bash agent
sudo -u agent mkdir -p /home/agent/.ssh
# append your public key to /home/agent/.ssh/authorized_keys, then:
sudo chmod 700 /home/agent/.ssh && sudo chmod 600 /home/agent/.ssh/authorized_keys
sudo chown -R agent:agent /home/agent/.ssh
```

Work in a directory the agent owns (say `/home/agent/workspace`), and use `sudo`
rules if it genuinely needs them. An explicit allowlist of commands is far better
than blanket `ALL=(ALL) NOPASSWD:ALL`. If the agent does something destructive,
it's confined to its own home, and your machine's real config stays out of reach.

## 3. Install the agent on the remote box

Agents are ordinary CLIs, so on the server:

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code

# Codex CLI
npm install -g @openai/codex
```

If the server has no Node yet, install it via your package manager or
[nvm](https://github.com/nvm-sh/nvm) under the agent user.

## 4. Headless authentication (the part every guide skips)

Both CLIs normally want to open a browser. A headless server has no browser, so
you complete the OAuth dance from your laptop instead.

Claude Code has a clean path for servers: on your machine run
`claude setup-token`, which yields a long-lived token, then on the server:

```bash
export ANTHROPIC_AUTH_TOKEN=<the token>
claude
```

Put the export in the agent user's `~/.bashrc` so it survives relogins. If you'd
rather reuse an interactive login, run `claude` on the server. Copy the
authorization URL it prints into your laptop's browser, and paste the resulting
code back into the terminal.

Codex CLI needs one extra step: `codex login` prints an authorization URL,
but its OAuth callback targets port 1455 on the server.

Connect with a local port forward first. Then run the login on the server and
open the printed URL in your laptop's browser.

The callback tunnels back to the server:

```bash
ssh -L 1455:localhost:1455 build   # from your laptop
codex login                        # on the server, in that session
```

Either way, once the dance is done the auth state sits on the server.
`~/.claude` holds Claude Code's state and `~/.codex` holds Codex CLI's, and you
authenticate exactly once.

## 5. Give the agent a session that outlives your SSH connection

The difference between "agent finished while I commuted" and "agent died when
the train went through a tunnel" is the session layer. The agent has to run on
the server, independent of your SSH connection, and you need a way to check on
it later.

For agent work we use [aplexer](https://github.com/PocketShell-io/aplexer), a
session layer built for agents. A session is a workspace, a tag, and an engine,
not a flat pane name.

Instead of remembering which pane held which job, you address sessions by name:

```bash
a start --workspace "$PWD" --tag review -- claude   # on the server
# runs on the server now — safe to close the laptop
```

`a list` shows every session with its engine and whether the agent inside is
working or waiting. Checking on a long refactor becomes a glance instead of an
archaeology dig through panes.

When you come back, whether from the same laptop, a different one, or your
phone:

```bash
ssh build
cd ~/workspace && a attach --workspace "$PWD" --tag review   # Ctrl-b d detaches when you need to go
```

Everything the agent did while you were gone is still there. Long refactors,
test loops, and installs all survive disconnects.

tmux is the default answer. If it's already your habit, stick with it:
`tmux new -s agent` starts a session and `tmux attach -t agent` brings it
back.

If you're choosing a session layer from scratch, compare the alternatives to
tmux:

- GNU screen is the veteran. It's preinstalled almost everywhere and does the
  job, with a keymap that shows its age.
- Zellij is a modern multiplexer with discoverable keybindings and layout
  files that make it a solid pick for plain shell work.
- aplexer is the main one for agent work and the session layer PocketShell
  runs on.

All three keep a process alive through a disconnect. Only the last one tells
you what's running inside when you come back.

## 6. Stay in the loop

An agent with a shell will happily run commands, so stack the odds in your
favor:

- Work on a branch. Tell the agent to commit to `agent/...` branches, and
  you review the diff and merge.
- Commit early, commit often. Git is your undo button - instruct the agent
  to commit after each step.
- Read the transcript. Detaching doesn't mean approving. Scroll through what
  it ran before you merge.
- Audit periodically. `last`, `history` under the agent user, and your usual
  log rotation will show you anything odd.

## Doing this from anywhere

The one annoyance with the setup above is that it still requires an SSH client
and your config file on whatever machine you're sitting at. That's the reason I
built [PocketShell](https://pocketshell.io/#how): it's a real terminal to your
saved hosts, in a browser tab. The `a attach` step above works from an iPad
or a locked-down work laptop with nothing installed, which is where a lot of
agent babysitting happens.

## To learn more

Keep going with these:

- Keep long jobs alive: [tmux sessions that survive disconnects](/blog/tmux-persistent-ssh-sessions)
- Organize your hosts: [`~/.ssh/config` examples](/blog/ssh-config-file)
- [Codex CLI on a remote server: the auth problem](https://medium.com/@djangoist/how-to-log-into-codex-cli-on-a-remote-server-0798162da0b2)
- [Running any AI tool remotely with SSH + tmux](https://stacktoheap.com/blog/2026/02/15/how-i-code-from-the-gym-part-2/)
