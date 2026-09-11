---
title: "SSH Keys and authorized_keys: Setup and Hardening"
slug: ssh-authorized-keys-hardening
date: 2026-09-11
description: "Generate ed25519 keys with ssh-keygen, install them with ssh-copy-id, then harden the server: disable passwords and restrict each key's scope."
keywords: [ssh authorized_keys, ssh-keygen ed25519, ssh-copy-id, disable ssh password authentication]
---

Public key authentication is the single highest-value SSH hardening step: it
removes password guessing from the equation entirely. But "I have a key" and "the
server is actually hardened" are different things. In this guide you generate a
modern key pair and install it correctly. Then you turn password login off
without locking yourself out, and use `authorized_keys` options to limit what
each key can do.

## Step 1: generate a modern key pair

On the machine you connect *from*:

```bash
ssh-keygen -t ed25519 -a 100 -C "alexey@thinkpad-2026"
```

Three flags matter here:

- `-t ed25519` picks Ed25519, the current sensible default. Since OpenSSH 9.5,
  `ssh-keygen` generates Ed25519 even without the flag, but being explicit costs
  nothing and documents intent for people on older tooling.
- `-a 100` raises the number of KDF rounds used to derive the encryption key from
  your passphrase, making an offline brute-force attack on a stolen key file
  expensive.
- `-C` sets a comment. Use something that tells you *where the key lives*, a
  device name and year. The comment ends up in the server's `authorized_keys`, so
  avoid embedding secrets in it.

Give the key a passphrase. An unencrypted key in `~/.ssh/` is only as safe as
every process running under your account. `ssh-agent` means you type the
passphrase once per boot, not per connection.

**On legacy RSA:** the old `ssh-rsa` signature scheme (SHA-1-based) has been
disabled by default since OpenSSH 8.8, and modern clients and servers negotiate
`rsa-sha2-256`/`rsa-sha2-512` automatically. An existing RSA key usually still
works without changes. If you must generate RSA for an ancient appliance, use at
least `-b 3072`.

**On key hygiene:** generate one key pair per device rather than copying one
private key everywhere. It costs nothing, and revocation becomes surgical: lose
the tablet, delete that one line from `authorized_keys`. A compromise of one
machine no longer inherits access on all of them.

## Step 2: install the public key on the server

The convenient way, which handles directory and permission setup:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub deploy@10.0.4.17
```

The manual equivalent, if you're already on the server or building images:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAAC3Nza... alexey@thinkpad-2026' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Permissions aren't cosmetic, because `sshd` (with `StrictModes` on, the default)
refuses to read `authorized_keys` if someone other than you can write the file or
any directory above it. That's a classic failure on NFS-mounted home directories
and restored backups. On RHEL-family systems after manual edits, fix SELinux
labels with `restorecon -Rv ~/.ssh`. Test from a **second terminal** before
closing your current session.

## Step 3: disable password authentication

Once key login works, retire passwords. Modern distros ship an `sshd_config.d` drop-in directory, and the policy belongs there:

```bash
# /etc/ssh/sshd_config.d/00-hardening.conf
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowGroups ssh-users
```

`PermitRootLogin prohibit-password` is a defensible middle ground if you must
ever reach a box as root. `AllowGroups` (or `AllowUsers`) limits who can log in at all, so create the group and add your accounts first.

Then validate and apply:

```bash
sshd -t                        # syntax check — never skip this
systemctl reload sshd          # reload, not restart: keeps existing sessions
```

Before you log out, open a **new** terminal and confirm the key login still
works. Keep the cloud provider's serial console as a last-resort backstop.

**Pitfall that bites everyone on cloud images:** `sshd_config` uses
first-value-wins semantics, and the `Include` directive for `sshd_config.d` sits
at the *top* of the file. Debian/Ubuntu cloud images ship `50-cloud-init.conf`
containing `PasswordAuthentication yes`, which therefore beats your `99-*.conf`.
Name your drop-in `00-hardening.conf` (or delete the cloud-init file) and verify
with `sshd -T | grep -i password`.

## Step 4: restrict what each key can do

`authorized_keys` lines accept options before the key, which turns one file into
per-key policy:

```text
# Backup puller: no shell at all, only rsync into /srv/backups, only from the NAS
restrict,from="10.0.4.17",command="/usr/bin/rrsync -ro /srv/backups" ssh-ed25519 AAAA... backup@nas

# CI deploy key: git commands only, no interactive login
restrict,command="git-shell -c \"$SSH_ORIGINAL_COMMAND\"" ssh-ed25519 AAAA... ci-deploy

# Rotating contractor key, self-expiring
restrict,expiry-time="20260901" ssh-ed25519 AAAA... contractor-temp
```

The `restrict` option disables every permission (pty, port/agent/X11 forwarding,
command execution), and you grant back only what the key needs. `command=` forces
a fixed command regardless of what the client asks, and the requested command
arrives in `$SSH_ORIGINAL_COMMAND`. `from=` limits the source address, noting
that through a jump host the server sees the jump host's IP. These options matter
because `authorized_keys` lives in users' home directories, where a careless
`>>` can silently add a stray key. Review the file periodically with
`awk '{print $3}' ~/.ssh/authorized_keys` to list key comments.

## Troubleshooting "Permission denied (publickey)"

These five checks find the cause most of the time:

1. **Run `ssh -vvv`.** If the key is never offered, the problem is client-side.
   Wrong identity file, wrong alias, or an agent issue (check with `ssh -G host`,
   which prints the fully resolved config - see the
   [`~/.ssh/config` guide](/blog/ssh-config-file) for how blocks resolve).
2. **Read the server log.** `journalctl -u ssh -n 50` (Debian/Ubuntu) or
   `journalctl -u sshd` (RHEL) states the exact reason. "Authentication refused:
   bad ownership or modes" is the permissions problem from Step 2.
3. **Check the user.** Cloud servers often expect `ubuntu`, `admin`, or
   `ec2-user`. Connecting as `root` fails before keys are considered.
4. **Force the right key** with
   `ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes host` to rule out agent noise.
5. **SELinux** on RHEL-family after manual file creation:
   `restorecon -Rv ~/.ssh`.

## Keys across many devices

One key per device multiplies management overhead, which is why the per-device
model pairs naturally with clients that keep credentials local. If you work from
machines where you can't (or shouldn't) install your keys at all, a browser-based
client like [PocketShell](https://pocketshell.io/#security) follows the same
principle. The host list syncs from your desktop app with zero-knowledge end-to-end encryption. A key you enter for a host is stored encrypted in that browser only, and it never syncs anywhere.
