---
title: "SSH from an iPad or iPhone: what actually works"
slug: ssh-from-ipad-iphone
cover: /images/blog/ssh-from-ipad-iphone.webp
date: 2026-09-12
featured: false
published: true
description: "How to SSH from an iPad or iPhone in 2026: native clients, key setup, mosh for flaky mobile networks, the keyboard problem, and the browser option when you can't install apps."
keywords: [ssh from ipad, ssh client for ipad, ssh from iphone, ssh iphone, mosh ios, best ssh client ipad]
---

Your laptop is closed, an agent is mid-run on a server, and you're on the couch
with an iPad. You can absolutely SSH from here. The protocol doesn't care what
sits on your end, but the keyboard, the connection, and the app you pick all
do. Pick a client that fits the small screen, and set it up before you need
it.

## There's no built-in terminal, so you need an app

Apple ships Terminal.app on the Mac, where recent releases gave it a real
overhaul. iOS and iPadOS still have no terminal app, and Apple hasn't
announced one. On iPhone and iPad, SSH means a third-party app. The market is
mature, though, and the good clients have been polished for a decade.

## The native clients worth your time

A few names cover most iPad and iPhone SSH users:

- Termius is the polished default, with host management, key management,
  and sync between your phone, tablet, and desktop. The free tier covers plain
  SSH, while sync and SFTP sit behind a subscription. Android gets the same
  app, so it covers mixed-device teams.
- Blink Shell is the power user's pick. It gives you a real shell on the
  device, so you run `ssh` the way you do on a Mac. It's built around
  [mosh](https://mosh.org), which matters more than anything else on a mobile
  network when the connection keeps changing.
- Prompt 3, SecureShellFish, and WebSSH are solid single-purpose
  clients, and SecureShellFish integrates with the iOS Files app, which is
  handy if you move files as often as you run commands.

Any of them handles a quick `systemctl status` or `tail -f`. They differ in
how they handle keys, mosh, and keyboard shortcuts, so pick by how you work
rather than by feature-list length.

## Set up a key before you need it

Password auth over a touchscreen is misery, and typing a 40-character password
on a phone keyboard is where typos become lockouts. Generate a key on the
device instead. Every client above has a key generator.

Install the public half on the server:

```bash
# on the server, from the client's export or any copy of the .pub file
echo "ssh-ed25519 AAAA... ipad-pro" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Give each device its own key, so losing the iPad means removing one line from
`authorized_keys` instead of rotating everything. Comment each line with the
device it belongs to, because in three months you won't remember which
`AAAA...` is which. Our
[guide to hardening `authorized_keys`](/blog/ssh-authorized-keys-hardening)
covers the `from=` and `restrict` options that limit a key to one device.

## Mosh fixes the connection, not the app

Mobile networks kill idle TCP connections. Your phone drops to LTE between
rooms, or the Wi-Fi roams you onto a different network. Somewhere along the
way a NAT gateway forgets the mapping, and a plain SSH session freezes.

`mosh` (mobile shell) was built for exactly this problem. It talks UDP instead
of TCP, so it survives IP changes without dropping the session. It also echoes
keystrokes locally, so the terminal feels instant even on a laggy hotel
network.

Install it on the server and open its UDP range:

```bash
sudo apt install mosh        # Debian/Ubuntu
sudo dnf install mosh        # Fedora
sudo ufw allow 60000:61000/udp
```

Connect with `mosh user@server` instead of `ssh`, and watch for these snags:

- The locale error. mosh requires a UTF-8 locale on both ends. If you see
  `The locale requested by LC_CTYPE=... isn't available here`, generate one on
  the server with `sudo locale-gen en_US.UTF-8`.
- The port range. Each session takes a UDP port between 60000 and 61000.
  Corporate or hotel firewalls that block outbound UDP will block mosh
  entirely. Plain SSH on 22 is your fallback there.

Blink uses mosh by default, which is most of the reason people swear by it on
the go. Termius supports it on paid plans.

## The keyboard is the real bottleneck

After a week of mobile SSH you stop blaming the network and start blaming the
keyboard. The touch keyboard has no `Esc`, no `Ctrl`, and no arrow keys, and
`vim` is unusable without them. Every serious client adds its own extra key
row above the keyboard. Check that a client has one before committing to it.
An external keyboard solves everything, and the iPad accepts any Bluetooth or
USB one.

You can also reduce how much typing mobile SSH needs at all.

Aliases in `~/.ssh/config` turn `ssh deploy@203.0.113.7 -p 2222` into
`ssh deploy`:

```text
# ~/.ssh/config
Host deploy
  HostName 203.0.113.7
  User deploy
  Port 2222
```

Our [`~/.ssh/config` guide](/blog/ssh-config-file) covers aliases, jump hosts,
and per-host keys in depth. Write the config once on a real keyboard, and the
iPad then only ever types `ssh deploy`. Apply the same treatment to long
commands. Anything you'll want to re-run on a phone should become an alias, a
script on the server, or a `Makefile` target.

One more server-side tweak for plain-SSH sessions on mobile: keepalive packets
stop NAT gateways from dropping your connection during idle stretches.

```bash
# ~/.ssh/config on the client
Host *
  ServerAliveInterval 20
  ServerAliveCountMax 3
```

mosh makes this unnecessary for mosh sessions, but it rescues the cases where
you can't use mosh.

## The browser route for locked-down devices

A managed iPad, a borrowed Chromebook, and a locked-down work laptop all share
one constraint. You get no App Store and no installs, so the browser is the
only tool available. A browser tab is a perfectly good terminal.

For exactly this case, [PocketShell](https://pocketshell.io/) opens a real
xterm.js SSH session in a browser tab. You sign in, pick a host, and connect,
and the server sees your usual key and `authorized_keys` file. Nothing is
installed there beyond the
[aplexer](/blog/aplexer-agent-multiplexer)
session layer, which keeps your agent sessions alive between visits. On a
device where you can't generate or store an SSH key at all, that's often the
only path that works.

## To learn more

These three pick up where this one stops:

- [tmux sessions that survive SSH disconnects](/blog/tmux-persistent-ssh-sessions)
- [The `~/.ssh/config` file: aliases, ProxyJump, and multiplexing](/blog/ssh-config-file)
- [Run AI agents on a remote machine over SSH](/blog/ssh-ai-agents-remote-machines)
