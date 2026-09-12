---
title: "How to run multiple AI coding agents in parallel"
slug: multiple-ai-coding-agents
cover: /images/blog/multiple-ai-coding-agents.webp
date: 2026-09-12
featured: false
published: true
description: "How to run several AI coding agents at the same time without collisions: git worktrees for isolation, named sessions you can address, a status board instead of terminal piles, and task sequencing that keeps agents from stepping on each other."
keywords: [run multiple ai agents, multiple claude code sessions, parallel ai coding agents, manage multiple ai agents, git worktree multiple agents, claude code parallel sessions]
---

One agent is a demo, and a bench of agents on separate tasks is a workload.
It fails in a new way: you lose track of what's running and which one has
been waiting for you since lunch. Naming, isolation, and a status board fix
this, not a bigger terminal grid.

## One task, one agent, one checkout

Two agents in the same directory will collide. Both edit the same files,
both stage the same paths, and every fix one makes invalidates the other's
assumptions.

Give each agent its own checkout on its own branch, and git worktrees do
this without a second clone:

```bash
git worktree add ../shop-rate-limits -b rate-limits
git worktree add ../shop-pagination  -b pagination
cd ../shop-rate-limits
```

Each worktree is a full working directory with its own branch. Worktrees
share one object store, so disk cost stays low and branches merge back the
normal way. Keep the mapping strict, one worktree per task and per
agent. The worktree goes away when the task merges.

## Name every session so you can address it

A checkout alone doesn't help if your only handle on the work is "the tmux
pane in window 3". Sessions need names tied to what they're doing, so you
can attach, message, or kill them without hunting.

With [aplexer](/blog/aplexer-agent-multiplexer), a session is addressed by
its workspace and tag, which maps one-to-one onto the worktree layout.

The [introduction post](/blog/aplexer-agent-multiplexer) covers the install
if you're starting from scratch:

```bash
cd ~/worktrees/shop-rate-limits
a here codex rate-limits     # start or reattach codex, tagged rate-limits

cd ~/worktrees/shop-pagination
a here claude pagination
```

`a list` then shows every workspace and the agent running in each, so the
list reads like a status board instead of a pile of pane titles. It also
shows whether each session is working or waiting.

## Watch the board, not the terminals

Once more than two agents run, opening a window per session stops scaling.
You need one place that answers "what needs me right now", and you attach
only when the answer is "this one".

`a` with no arguments is that board for one machine. It groups sessions by
workspace and shows which ones are `working` or `waiting`. Checking on
eight sessions costs one command instead of eight windows.

The board also answers the quieter question of whether anything is actually
progressing. When I ran an agent team on real projects, agents drifted into
process problems. They skipped steps, declared work finished too early, and
ran for an hour with no evidence of progress. A board with live states turns
that silence into data. I describe the full team setup, roles included, on
[AI Shipping Blog](https://aishippingblog.com/p/i-built-an-ai-agent-team-for-software).

## Sequence the work so agents don't collide

Isolation keeps agents out of each other's files, but they can still collide
at a higher level. Two agents refactor the same interface from two
worktrees, and both open pull requests that can't merge. Sequencing is your
job, not the agents'.

Keep batches small and scopes explicit. Two parallel tasks is a good ceiling
to start with. Each task gets a short spec with acceptance criteria before
its agent starts, so "done" is checkable.

For tracking, either GitHub issues or a file-based board works, as long as
status lives in one obvious place:

```text
shop/
  042-rate-limits.todo.md
  041-pagination.in-progress.md
  040-login-remember-me.done.md
```

Keep the same discipline either way. A task moves forward only through its
named states, and an agent that claims completion gets checked against the
acceptance criteria before its worktree merges.

## Contain the blast radius

Parallel agents multiply whatever access you gave them, so a few boundaries
keep the downside bounded:

- Run unattended agents on a server, not your laptop: the run survives your
  laptop closing, and you skip permission prompts only on machines with
  nothing precious on them. [The remote setup
  guide](/blog/ssh-ai-agents-remote-machines) gets an agent onto a server
  from zero.
- Sandbox credentials with short-lived sessions and scoped accounts, and let
  real deployments go through CI, where a human can still see the diff.
- Cap resources per session, because aplexer profiles take memory and
  process limits, so a capped session that eats its limit gets OOM killed
  alone.

On a [PocketShell](https://pocketshell.io/) host, the board lives in a
browser tab, and the host list spans machines. "What needs me" then covers
every server you run.

## To learn more

These three pick up where this one stops:

- [aplexer: an agent multiplexer for AI coding agents](/blog/aplexer-agent-multiplexer)
- [Configuring a remote machine over SSH with AI agents](/blog/ssh-ai-agents-remote-machines)
- [Check on your AI coding agents from your phone](/blog/check-ai-agents-from-phone)
