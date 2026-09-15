#!/usr/bin/env bash
# Re-copy the vendored sync-contract modules from the desktop repo.
#
# These files are VERBATIM copies of PocketShell-io/pocketshell-desktop's
# src/shared/{net,sshConfigCore,types,syncMerge,sync,syncConfig}.ts — the web
# app reads the account blob and folds SSH configs with the desktop's exact
# rules. Edit them THERE, commit, then run this script here and commit the
# refresh.
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

FILES="src/shared/types.ts src/shared/net.ts src/shared/sshConfigCore.ts src/shared/syncMerge.ts src/shared/sync.ts src/shared/syncConfig.ts"

for f in $FILES; do
  git -C "$DESKTOP_REPO" show "HEAD:$f" > "$f"
  echo "vendored $f (from $(git -C "$DESKTOP_REPO" rev-parse --short HEAD))"
done
