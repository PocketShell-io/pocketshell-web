#!/usr/bin/env bash
# Re-copy the vendored sync-contract modules from the desktop repo.
#
# These files are VERBATIM copies of PocketShell-io/pocketshell-desktop's
# src/shared/{net,sshConfigCore,types,syncMerge,sync,syncConfig,osc52}.ts — the
# web app reads the account blob, folds SSH configs, and answers the terminal's
# OSC 52 clipboard sequence with the desktop's exact code. aplexer.ts (the
# session manager's types and join command), shellQuote.ts, and userBinPath.ts
# back the web sessions workspace, which speaks the host's `a` CLI with the
# desktop's exact commands. agentLaunch.ts + agentCommands.ts + composerSend.ts
# build the `pocketshell agent …` launch line for the composer with the
# desktop's exact contract. Edit them THERE, commit, then run this script here
# and commit the refresh.
#
#   DESKTOP_REPO=/path/to/checkout scripts/sync-shared.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DESKTOP_REPO:-}" ]; then
  if [ -d "$HOME/git/pocketshell-desktop" ]; then
    DESKTOP_REPO="$HOME/git/pocketshell-desktop"
  else
    DESKTOP_REPO="$HOME/git/pocketshell-electron"  # pre-transfer checkout name
  fi
fi

FILES="src/shared/types.ts src/shared/net.ts src/shared/sshConfigCore.ts src/shared/syncMerge.ts src/shared/sync.ts src/shared/syncConfig.ts src/shared/osc52.ts src/shared/aplexer.ts src/shared/shellQuote.ts src/shared/userBinPath.ts src/shared/agentLaunch.ts src/shared/agentCommands.ts src/shared/composerSend.ts src/shared/knownHostsCore.ts src/shared/aplexerCommands.ts src/shared/aplexerParsers.ts src/shared/aplexerClientCore.ts src/shared/sftpCore.ts src/shared/byteSize.ts"

for f in $FILES; do
  git -C "$DESKTOP_REPO" show "HEAD:$f" > "$f"
  echo "vendored $f (from $(git -C "$DESKTOP_REPO" rev-parse --short HEAD))"
done
