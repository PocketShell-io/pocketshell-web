#!/usr/bin/env bash
# End-to-end test for the config-import + key-upload flow, run against the
# REAL sshd fixture from the electron repo (tests-docker/pocketshell-test:ssh,
# pubkey-only): the browser's captured connect frames are used to open actual
# SSH sessions with paramiko, so a pass proves the whole chain —
#   config parsed in-browser → selected hosts → sync envelope (asserted
#   encrypted, decryptable with the passphrase) → key + passphrase attached →
#   connect frame → SSH session on the docker container.
#
# Usage: tests/e2e/run-e2e.sh [--keep-server]
# Requires: docker, /usr/bin/python3 with playwright + paramiko.
set -euo pipefail
cd "$(dirname "$0")/../.."

ELECTRON_REPO="${ELECTRON_REPO:-$HOME/git/pocketshell-electron}"
COMPOSE="docker compose -f $ELECTRON_REPO/tests-docker/docker-compose.yml"

WORK="$(mktemp -d /tmp/ps-web-e2e.XXXXXX)"
echo "e2e workdir: $WORK"

free_port() {
  /usr/bin/python3 - <<PY
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0))
print(s.getsockname()[1]); s.close()
PY
}

# --- 1. the sshd fixture ----------------------------------------------------
# Build the image through compose when missing, but run a dedicated container
# on a free port with a run-unique name — `compose up` collides with any
# concurrent fleet using the same project name, and 3202 may already be taken.
# Build from the CURRENT tree every run (a cache hit when nothing changed):
# a stale image bakes an older authorized_keys and every pubkey auth fails
# with a "key rejected" that looks like a fixture outage.
$COMPOSE build ssh >/dev/null
CNAME="ps-web-e2e-$$"
FIXTURE_PORT="$(free_port)"
docker rm -f "$CNAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$CNAME" -p "$FIXTURE_PORT":22 pocketshell-test:ssh >/dev/null

# The committed passphrase-less fixture key, under the name the e2e uses.
cp "$ELECTRON_REPO/tests-docker/test_key" "$WORK/key_plain"
chmod 600 "$WORK/key_plain"

# sshd accepting the committed key is the fixture's own healthcheck; reuse it
# as the readiness gate.
for _ in $(seq 1 60); do
  if ssh -i "$WORK/key_plain" -p "$FIXTURE_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 testuser@127.0.0.1 true 2>/dev/null; then
    break
  fi
  sleep 0.5
done
ssh -i "$WORK/key_plain" -p "$FIXTURE_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 true 2>/dev/null \
  || { echo "fixture sshd never came up on :$FIXTURE_PORT"; docker logs "$CNAME" | tail -20; exit 1; }

# A key WITH a passphrase, generated fresh; its pubkey joins the fixture's
# authorized_keys for this run.
ssh-keygen -t ed25519 -N 'e2e-key-passphrase' -C pocketshell-web-e2e -f "$WORK/key_enc" -q
chmod 600 "$WORK/key_enc"
docker exec -i "$CNAME" sh -c 'cat >> /home/testuser/.ssh/authorized_keys && chmod 600 /home/testuser/.ssh/authorized_keys' < "$WORK/key_enc.pub"

# The config the browser will import. The canary comment must appear in NO
# request body; the wildcard patterns must be skipped, not imported.
cat > "$WORK/import.config" <<'EOF'
# e2e-canary-7f3k4m — if this string leaves the browser, the test fails
Host dockertest
  HostName 127.0.0.1
  Port 3202
  User testuser
  IdentityFile ~/.ssh/key_enc

Host manualbox
  HostName 127.0.0.1
  Port 3202

Host keylesstest
  HostName 127.0.0.1
  Port 3202
  User testuser

Host *.pool.example.com !keep.pool.example.com
  User patternuser
EOF

# --- 2. build + serve the real dist ----------------------------------------
# Build into the run's own directory: the checkout's dist/ is contended by
# concurrent agent builds in this repo, and vite's emptyOutDir race breaks
# both. Type-checking still runs (vue-tsc via the build script).
npx vite build --outDir "$WORK/dist" --emptyOutDir >/dev/null
BASE_PORT="$(free_port)"
npx vite preview --outDir "$WORK/dist" --port "$BASE_PORT" --strictPort >"$WORK/preview.log" 2>&1 &
PREVIEW_PID=$!
trap 'kill "$PREVIEW_PID" 2>/dev/null || true; docker rm -f "$CNAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://localhost:$BASE_PORT/" && break
  sleep 0.2
done

# --- 3. the browser flow ----------------------------------------------------
/usr/bin/python3 tests/e2e/e2e_hosts_keys.py \
  "http://localhost:$BASE_PORT" "$WORK" "$FIXTURE_PORT"
status=$?

echo "artifacts in $WORK (screenshots: $WORK/*.png)"
exit "$status"
