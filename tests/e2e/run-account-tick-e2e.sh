#!/usr/bin/env bash
# End-to-end test for the shared sync tick rule on the web's /account page
# (pocketshell#3072). The web's local host list IS the synced account, so
# every account host overlaps a local one; the page must show each as
# "In account", ticked, an untouched Sync now must keep them all in the
# account, and only an explicit untick may show "remove on sync" and remove
# one. Real Chromium against the built dist; only Google sign-in (GIS stub)
# and the sync API (an in-memory slot store holding real envelopes) are
# faked. No sshd, no relay.
#
# Usage: tests/e2e/run-account-tick-e2e.sh [screenshot-dir]
# Requires: /usr/bin/python3 with playwright and cryptography.
set -euo pipefail
cd "$(dirname "$0")/../.."

WORK="$(mktemp -d /tmp/ps-web-account-tick-e2e.XXXXXX)"
SHOTS="${1:-$WORK/shots}"
echo "account-tick e2e workdir: $WORK (screenshots: $SHOTS)"

free_port() {
  /usr/bin/python3 - <<PY
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0))
print(s.getsockname()[1]); s.close()
PY
}

cleanup() {
  kill "${PREVIEW_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT

npx vite build --outDir "$WORK/dist" --emptyOutDir --minify false >/dev/null
BASE_PORT="$(free_port)"
node_modules/.bin/vite preview --outDir "$WORK/dist" --port "$BASE_PORT" --strictPort >"$WORK/preview.log" 2>&1 &
PREVIEW_PID=$!
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://localhost:$BASE_PORT/" && break
  sleep 0.2
done
curl -sf -o /dev/null "http://localhost:$BASE_PORT/" || { echo "preview never came up on :$BASE_PORT"; tail -20 "$WORK/preview.log"; exit 1; }

/usr/bin/python3 tests/e2e/e2e_account_tick.py "http://localhost:$BASE_PORT" "$SHOTS"
