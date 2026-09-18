#!/usr/bin/env bash
# End-to-end test for the browser-direct SSH path: the app's own ssh2 client
# (src/terminal/direct.ts) dials the local dev relay (relay/dev-relay.mjs),
# which pipes to the REAL sshd fixture from the electron repo
# (tests-docker/pocketshell-test:ssh, pubkey-only). The key attached in the
# browser is ~/.ssh/id_hetzner when present (its authorized_keys half is
# injected into the fixture) — the actual production key, encrypted with a
# one-space passphrase — falling back to a fresh generated key otherwise.
# A pass proves the whole direct chain in a real browser build:
#   sign-in fakes → host + key stored → directWsUrl branch → browser ssh2
#   (polyfilled crypto) → dumb relay → sshd PTY; and the relay wire carries
#   ciphertext only.
#
# Usage: tests/e2e/run-direct-e2e.sh
# Requires: docker, /usr/bin/python3 with playwright.
set -euo pipefail
cd "$(dirname "$0")/../.."

ELECTRON_REPO="${ELECTRON_REPO:-$HOME/git/pocketshell-electron}"
COMPOSE="docker compose -f $ELECTRON_REPO/tests-docker/docker-compose.yml"

WORK="$(mktemp -d /tmp/ps-web-direct-e2e.XXXXXX)"
echo "direct e2e workdir: $WORK"

free_port() {
  /usr/bin/python3 - <<PY
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0))
print(s.getsockname()[1]); s.close()
PY
}

# --- 1. the sshd fixture -----------------------------------------------------
$COMPOSE build ssh >/dev/null
CNAME="ps-web-direct-e2e-$$"
FIXTURE_PORT="$(free_port)"
RELAY_PORT="$(free_port)"
docker rm -f "$CNAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$CNAME" -p "$FIXTURE_PORT":22 pocketshell-test:ssh >/dev/null

cleanup() {
  kill "${RELAY_PID:-0}" "${PREVIEW_PID:-0}" 2>/dev/null || true
  docker rm -f "$CNAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The real key if it exists, else a generated stand-in with the same shape.
if [ -f "$HOME/.ssh/id_hetzner" ]; then
  cp "$HOME/.ssh/id_hetzner" "$WORK/key_real"
  chmod 600 "$WORK/key_real"
  echo "using the real ~/.ssh/id_hetzner key"
else
  ssh-keygen -t ed25519 -N ' ' -C pocketshell-web-direct-e2e -f "$WORK/key_real" -q
  chmod 600 "$WORK/key_real"
  echo "id_hetzner not found — using a generated one-space-passphrase key"
fi

# The key must be authorized: append its public half to the fixture.
ssh-keygen -y -f "$WORK/key_real" > "$WORK/key_real.pub"
docker exec -i "$CNAME" sh -c 'cat >> /home/testuser/.ssh/authorized_keys && chmod 600 /home/testuser/.ssh/authorized_keys' < "$WORK/key_real.pub"

# Readiness gate, same as run-e2e.sh: sshd accepting the committed key.
cp "$ELECTRON_REPO/tests-docker/test_key" "$WORK/key_gate"
chmod 600 "$WORK/key_gate"
for _ in $(seq 1 60); do
  if ssh -i "$WORK/key_gate" -p "$FIXTURE_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 testuser@127.0.0.1 true 2>/dev/null; then
    break
  fi
  sleep 0.5
done
ssh -i "$WORK/key_gate" -p "$FIXTURE_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 true 2>/dev/null \
  || { echo "fixture sshd never came up on :$FIXTURE_PORT"; docker logs "$CNAME" | tail -20; exit 1; }

# --- 2. relay + real dist + preview -------------------------------------------
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

# --- 3. the browser flow -------------------------------------------------------
/usr/bin/python3 tests/e2e/e2e_direct_ssh.py \
  "http://localhost:$BASE_PORT" "$WORK" "$FIXTURE_PORT" "$RELAY_PORT"
status=$?

echo "artifacts in $WORK (relay log: $WORK/relay.log)"
exit "$status"
