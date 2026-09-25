#!/usr/bin/env bash
# End-to-end test for the beforeunload nav guard (src/platform/navGuard.ts).
# No sshd, no key: the "host" is a silent TCP fixture the e2e script itself
# hosts — it accepts the dev relay's connection and never speaks SSH, which
# holds the browser's dial in 'connecting' while the tab closes. A pass
# proves, in a real Chromium against the built dist:
#   sign-in fakes → shared picker (state idle) → close: NO leave dialog;
#   host added → dial in flight ('Connecting to…') → close: the browser's
#   own beforeunload dialog fires.
#
# Usage: tests/e2e/run-nav-guard-e2e.sh
# Requires: /usr/bin/python3 with playwright.
set -euo pipefail
cd "$(dirname "$0")/../.."

WORK="$(mktemp -d /tmp/ps-web-navguard-e2e.XXXXXX)"
echo "nav-guard e2e workdir: $WORK"

free_port() {
  /usr/bin/python3 - <<PY
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0))
print(s.getsockname()[1]); s.close()
PY
}

SILENT_PORT="$(free_port)"
RELAY_PORT="$(free_port)"

# A real parseable key (one-space passphrase, the real-world shape). Nothing
# ever authenticates against it — the silent fixture never speaks SSH — the
# picker just refuses to dial a keyless host.
ssh-keygen -t ed25519 -N ' ' -C pocketshell-web-navguard-e2e -f "$WORK/key_real" -q
chmod 600 "$WORK/key_real"

cleanup() {
  kill "${RELAY_PID:-0}" "${PREVIEW_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT

# --- relay + real dist + preview ---------------------------------------------
node relay/dev-relay.mjs "$RELAY_PORT" >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 50); do
  grep -q "dev relay" "$WORK/relay.log" 2>/dev/null && break
  sleep 0.1
done

npx vite build --outDir "$WORK/dist" --emptyOutDir --minify false >/dev/null
BASE_PORT="$(free_port)"
node_modules/.bin/vite preview --outDir "$WORK/dist" --port "$BASE_PORT" --strictPort >"$WORK/preview.log" 2>&1 &
PREVIEW_PID=$!
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://localhost:$BASE_PORT/" && break
  sleep 0.2
done
curl -sf -o /dev/null "http://localhost:$BASE_PORT/" || { echo "preview never came up on :$BASE_PORT"; tail -20 "$WORK/preview.log"; exit 1; }

/usr/bin/python3 tests/e2e/e2e_nav_guard.py "http://localhost:$BASE_PORT" "$WORK" "$SILENT_PORT" "$RELAY_PORT" "$WORK/key_real"
