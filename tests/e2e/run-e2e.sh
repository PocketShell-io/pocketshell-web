#!/usr/bin/env bash
# End-to-end test for the config-import + key-upload + real-terminal +
# gateway-dial flow, run against the REAL sshd fixture fleet from the desktop
# repo (tests-docker/, pubkey-only). A pass proves the whole chain —
#   config parsed in-browser → selected hosts → sync envelopes (asserted
#   encrypted in BOTH slots, decryptable with the passphrase) → key +
#   passphrase attached → the browser's OWN ssh2 speaking real SSH over a
#   dumb WebSocket<->TCP relay pipe → real sessions on the container → the
#   folder-first workspace's "Start a session here" → Shell → the shipping
#   TerminalView xterm answering a remote OSC 52 yank in the browser
#   clipboard (and refusing a remote "clear", acknowledged by the same
#   command's real output) → a full gateway-protocol dial
#   (broker exchange, auth frame with only the scoped token, ready, real SSH
#   behind it) against a protocol-shaped WS fixture with the real sshd
#   behind IT. The fixture is protocol-shaped, NOT the Go production
#   gateway; no production-gateway evidence is claimed from this run.
# Every wire surface the browser touches is custody-scanned — HTTP requests
# through ONE captured-HTTP policy (the structured exact-surface URL rules
# pinning scheme/host/effective port/path/query for the direct relay, gateway,
# sync and broker fixtures; the method + exact-Bearer Authorization rule on
# the account surfaces; a full secret-set scan of every header value and
# body), the direct-relay and gateway WebSocket dial URLs through the same
# URL policy, and EVERY recorded relay/gateway frame (binary AND text, the
# gateway's first/auth TEXT frame included) — with offline negative controls
# proving the oracle, the recorder, the URL policy, the captured-HTTP policy
# and the credential-safe failure diagnostics bite.
#
# Usage: tests/e2e/run-e2e.sh
# Requires: docker, /usr/bin/python3 with playwright + cryptography,
# ELECTRON_REPO pointing at the desktop checkout that owns tests-docker/
# (default: $HOME/git/pocketshell-desktop).
set -euo pipefail
cd "$(dirname "$0")/../.."

DESKTOP_REPO="${ELECTRON_REPO:-$HOME/git/pocketshell-desktop}"
COMPOSE="docker compose -f $DESKTOP_REPO/tests-docker/docker-compose.yml"

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
# The helper image = base sshd + sftp + tmux + the pocketshell helper and
# aplexer: the session dependencies the folder-first workspace (and the OSC 52
# leg through it) need. Built through compose in layer order, but run as a
# dedicated container on a free port with a run-unique name — `compose up`
# collides with any concurrent fleet using the same project name. Build from
# the CURRENT tree every run (a cache hit when nothing changed): a stale image
# bakes an older authorized_keys and every pubkey auth fails with a "key
# rejected" that looks like a fixture outage.
$COMPOSE build ssh tmux helper >/dev/null
CNAME="ps-web-e2e-$$"
FIXTURE_PORT="$(free_port)"
docker rm -f "$CNAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$CNAME" -p "$FIXTURE_PORT":22 pocketshell-test:helper >/dev/null

# The committed passphrase-less fixture key, under the names the e2e uses.
cp "$DESKTOP_REPO/tests-docker/test_key" "$WORK/key_plain"
cp "$DESKTOP_REPO/tests-docker/test_key.pub" "$WORK/key_plain.pub"
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

# Session dependencies for the OSC 52 leg: an EMPTY folder (as testuser —
# the folder-first workspace sessions run as testuser) the folder-first
# workspace can enter, reaching its "Start a session here" empty state.
docker exec "$CNAME" sh -lc 'mkdir -p ~testuser/git/osc-demo && chown -R testuser:testuser ~testuser/git'

# The fixture's real host key: the gateway leg pairs against its ACTUAL
# ED25519 fingerprint (out-of-band, like a real enrollment), and the fake
# gateway echoes the real key line in its advisory ready frame.
docker exec "$CNAME" cat /etc/ssh/ssh_host_ed25519_key.pub > "$WORK/host_key.pub"

# The config the browser will import. The canary comment must appear in NO
# request body; the wildcard patterns must be skipped, not imported.
# dockertest, manualbox AND keylesstest deliberately share ONE endpoint: the
# selection-collision counterexample. The old endpoint-first resolution
# resolved a keylesstest dial to manualbox's record and borrowed its key —
# the fixed resolution must never do that.
cat > "$WORK/import.config" <<EOF
# e2e-canary-7f3k4m — if this string leaves the browser, the test fails
Host dockertest
  HostName 127.0.0.1
  Port $FIXTURE_PORT
  User testuser
  IdentityFile ~/.ssh/key_enc

Host manualbox
  HostName 127.0.0.1
  Port $FIXTURE_PORT

Host keylesstest
  HostName 127.0.0.1
  Port $FIXTURE_PORT
  User testuser

Host *.pool.example.com !keep.pool.example.com
  User patternuser
EOF

# --- 2. type-check + build + serve the real dist ----------------------------
# Type-check for real (the e2e receipt claims it), then build into the run's
# own directory: the checkout's dist/ is contended by concurrent agent builds
# in this repo, and vite's emptyOutDir race breaks both.
npx vue-tsc --noEmit
npx vite build --outDir "$WORK/dist" --emptyOutDir >/dev/null
BASE_PORT="$(free_port)"
# The preview runs via node_modules/.bin/vite, not npx: the trap kills
# PREVIEW_PID, and killing the npx wrapper orphaned the vite child, leaking
# a ~100 MB server per run.
node_modules/.bin/vite preview --outDir "$WORK/dist" --port "$BASE_PORT" --strictPort >"$WORK/preview.log" 2>&1 &
PREVIEW_PID=$!
trap 'kill "$PREVIEW_PID" 2>/dev/null || true; docker rm -f "$CNAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://localhost:$BASE_PORT/" && break
  sleep 0.2
done

# --- 3. the browser flow ----------------------------------------------------
/usr/bin/python3 tests/e2e/e2e_hosts_keys.py \
  "http://localhost:$BASE_PORT" "$WORK" "$FIXTURE_PORT" "$CNAME" "$WORK/key_plain.pub"
status=$?

echo "artifacts in $WORK (screenshots: $WORK/*.png)"
exit "$status"
