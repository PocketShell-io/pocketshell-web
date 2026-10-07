#!/usr/bin/env bash
# Combined shipping-contract proof: the REAL production Vite browser bundle
# (normal UI/config paths — connection.ts / webApi / pin store, no transport
# adapters, no fallbacks) against the REAL Go gateway built from the pinned
# accepted pocketshell-gateway source (registry-enabled: production routingauth
# JWT verification through the local broker fixture's JWKS), the REAL
# pocketshell-link home agent bridging its LOOPBACK sshd, and a multi-key
# OpenSSH fixture fleet (six host-key modes matching the browser host-key
# algorithm contract: ssh-ed25519 > rsa-sha2-512 > rsa-sha2-256 > ssh-rsa).
#
# What runs, concretely:
#   1. the broker fixture (tests/e2e/gateway_fixture_broker.py): a LOCAL
#      stand-in for the separately-trusted sync service's auth broker. Its
#      authorizer is an exact-match LOCAL fixture sign-in — NOT Google, NOT
#      the live Cloud authorizer; the tokens it mints are verified by the
#      gateway's PRODUCTION routingauth verifier (RS256, exact issuer,
#      aud/scope/exp claims, JWKS).
#   2. gateway instance A from the pinned gateway source WITH -registry
#      (identity + tunnel enabled, zero dev-auth flags — the shipping auth
#      posture, plain-HTTP listener for the lab only) and instance B serving
#      the legacy browser-direct relay under its DOCUMENTED dev posture
#      (-dev-allow-any-token -dev-allow-private-hosts, no registry — the
#      legacy direct transport cannot verify a fixture sign-in without a
#      live Google JWKS, so the direct leg's authorization is explicitly a
#      dev posture, not a production claim).
#   3. pocketshell-link enroll (broker token on stdin, --expect-host-key
#      pinned out of band) + run per dial-able host-key mode; the ECDSA-only
#      mode's enrollment must REFUSE honestly before any HTTP.
#   4. the production browser bundle served by vite preview, driven by
#      Playwright with READ-ONLY WebSocket observation (page.on('websocket')
#      frame events — no route interception on any transport) through
#      tests/e2e/e2e_gateway_prod.py.
#
# Everything is run-scoped: uniquely named containers, freshly allocated
# ports, a run-scoped registry state file under
# /var/lib/pocketshell-relay/ (the production default base dir), an
# ephemeral broker signing key, ephemeral SSH keys. Peer containers, ports
# and daemons are never touched; cleanup removes only this run's objects.
#
# Usage: tests/e2e/run-gateway-e2e.sh
# Requires: docker, go (for the gateway build), /usr/bin/python3 with
# playwright + cryptography + websockets, ELECTRON_REPO pointing at the
# desktop checkout that owns tests-docker/ (default: $HOME/git/pocketshell-desktop).
set -euo pipefail
cd "$(dirname "$0")/../.."

DESKTOP_REPO="${ELECTRON_REPO:-$HOME/git/pocketshell-desktop}"
GATEWAY_REPO="${GATEWAY_REPO:-$HOME/git/pocketshell-gateway}"
WEB_COMMIT="$(git rev-parse HEAD)"
GW_COMMIT="$(git -C "$GATEWAY_REPO" rev-parse HEAD)"
CORE_COMMIT="$(git -C "$HOME/git/gateway-browser-integrated-workspace/pocketshell-core" rev-parse HEAD)"

WORK="$(mktemp -d /tmp/ps-gw-e2e.XXXXXX)"
echo "e2e workdir: $WORK"
RUNID="psgwe2e-$$"
FAIL_MARKER="$WORK/FAILED"

cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then echo "FAILED" > "$FAIL_MARKER"; fi
  [[ -n "${PREVIEW_PID:-}" ]] && kill "$PREVIEW_PID" 2>/dev/null || true
  [[ -n "${BROKER_PID:-}" ]] && kill "$BROKER_PID" 2>/dev/null || true
  [[ -n "${GWA_PID:-}" ]] && kill "$GWA_PID" 2>/dev/null || true
  [[ -n "${GWB_PID:-}" ]] && kill "$GWB_PID" 2>/dev/null || true
  for agentpid in "${AGENT_PIDS[@]:-}"; do kill "$agentpid" 2>/dev/null || true; done
  # The advisory-tamper leg may have restarted gateway A under a new PID —
  # its command line carries this run's registry path.
  [[ -n "${REGISTRY_FILE:-}" ]] && pkill -f "$REGISTRY_FILE" 2>/dev/null || true
  # Preserve the sshd fleet's view (accepted/failed userauth lines) BEFORE
  # the containers go away — userauth failures are diagnosed from these.
  for cname in "${CONTAINERS[@]:-}"; do
    docker logs "$cname" > "${WORK:-/tmp}/sshd-${cname}.log" 2>&1 || true
  done
  for cname in "${CONTAINERS[@]:-}"; do docker rm -f "$cname" >/dev/null 2>&1 || true; done
  [[ -n "${REGISTRY_FILE:-}" ]] && rm -f "$REGISTRY_FILE" || true
  exit "$code"
}
trap cleanup EXIT

free_ports() {
  /usr/bin/python3 - "$1" << 'PY'
import socket, sys
need = int(sys.argv[1]); ports = []; socks = []
for _ in range(need):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); ports.append(s.getsockname()[1]); socks.append(s)
for s in socks: s.close()
print(' '.join(map(str, ports)))
PY
}
read -r BROKER_PORT BROKER_HTTPS_PORT GW_PORT GWB_PORT BASE_PORT SSH_MULTI SSH_REVERSE SSH_RSAONLY SSH_SSHRSA SSH_ECDSAONLY SSH_EDRSA \
  < <(free_ports 11)
CONTAINERS=()
AGENT_PIDS=()

# --- receipts: exactly what is under test -----------------------------------
{
  echo "run: $RUNID"
  echo "web commit: $WEB_COMMIT (branch gateway-browser-integrated; includes crypto eb9a6c8 series)"
  echo "core pin commit: $CORE_COMMIT (pinned sibling; published-core check documented in the progress file)"
  echo "gateway commit: $GW_COMMIT ($(git -C "$GATEWAY_REPO" log -1 --format=%s | head -c 80)...)"
  echo "ports: broker-http=$BROKER_PORT broker-https=$BROKER_HTTPS_PORT gateway=$GW_PORT legacy=$GWB_PORT preview=$BASE_PORT sshd=$SSH_MULTI,$SSH_REVERSE,$SSH_RSAONLY,$SSH_SSHRSA,$SSH_ECDSAONLY,$SSH_EDRSA"
} > "$WORK/receipt.env"
/usr/local/go/bin/go version > "$WORK/go-version.txt" 2>&1

# --- 1. the Go gateway archive + home agent from the PINNED source ----------
mkdir -p "$WORK/bin"
(cd "$GATEWAY_REPO" && /usr/local/go/bin/go build -trimpath -o "$WORK/bin/relay" . && /usr/local/go/bin/go build -trimpath -o "$WORK/bin/pocketshell-link" ./cmd/pocketshell-link)
sha256sum "$WORK/bin/relay" "$WORK/bin/pocketshell-link" > "$WORK/gateway-binaries.sha256"

# --- 2. the broker fixture (owned, local; the authorizer stand-in) ----------
# Plain-http listener for the GATEWAY's JWKS fetch (its shipped
# -broker-allow-insecure-dev lab flag) and a TLS listener for the BROWSER's
# exchange: the production guard in gatewayToken.ts mints ONLY from an https
# account-service origin, so the fixture serves TLS with an owned
# self-signed cert. The ISSUER pinned into tokens is the https origin.
/usr/bin/python3 tests/e2e/gateway_fixture_broker.py "$BROKER_PORT" "$WORK/broker.jsonl" "$BROKER_HTTPS_PORT" > "$WORK/broker.log" 2>&1 &
BROKER_PID=$!
BROKER_ISSUER="https://127.0.0.1:$BROKER_HTTPS_PORT"
for _ in $(seq 1 40); do
  curl -sk -o "$WORK/jwks.json" "https://127.0.0.1:$BROKER_HTTPS_PORT/gateway/jwks" && grep -q '"kty"' "$WORK/jwks.json" && break
  sleep 0.25
done
grep -q '"kty": "RSA"' "$WORK/jwks.json" || { echo "broker JWKS never came up"; exit 1; }

# --- 3. the sshd fixture fleet (six host-key modes, helper image) -----------
COMPOSE="docker compose -f $DESKTOP_REPO/tests-docker/docker-compose.yml"
$COMPOSE build ssh tmux helper >/dev/null 2>&1 || true
docker image inspect pocketshell-test:helper >/dev/null || { echo "helper image missing"; exit 1; }

# The run's SSH user keys (all owned, ephemeral): plain Ed25519, RSA (SHA2),
# passphrase-encrypted Ed25519 — plus the fleet's committed plain key.
KEY_PASSPHRASE='e2e-key-passphrase'
ssh-keygen -t ed25519 -N '' -C "$RUNID-plain" -f "$WORK/key_plain" -q
ssh-keygen -t rsa -b 2048 -N '' -C "$RUNID-rsa" -f "$WORK/key_rsa" -q
ssh-keygen -t ed25519 -N "$KEY_PASSPHRASE" -C "$RUNID-enc" -f "$WORK/key_enc" -q
chmod 600 "$WORK"/key_plain "$WORK"/key_rsa "$WORK"/key_enc
cat "$DESKTOP_REPO/tests-docker/test_key.pub" "$WORK/key_plain.pub" "$WORK/key_rsa.pub" "$WORK/key_enc.pub" > "$WORK/authorized_keys"

mode_config() { # name hostkeys... — writes $WORK/mode/<name>/sshd_config
  local name="$1"; shift
  mkdir -p "$WORK/mode/$name"
  {
    echo "Port 22"
    for hk in "$@"; do echo "HostKey /etc/ssh/ssh_host_${hk}_key"; done
    if [[ "${name}" == "sshrsa" ]]; then echo "HostKeyAlgorithms ssh-rsa"; fi
    cat << 'CFG'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp internal-sftp
LogLevel VERBOSE
CFG
  } > "$WORK/mode/$name/sshd_config"
  for hk in ed25519 rsa ecdsa; do
    if [[ " $* " == *" $hk "* ]]; then
      ssh-keygen -t "$hk" -N '' -f "$WORK/mode/$name/ssh_host_${hk}_key" -q
    fi
  done
}

start_mode() { # name port
  local name="$1" port="$2"
  local cname="$RUNID-$name"
  local args=()
  args+=(-v "$WORK/mode/$name/sshd_config:/etc/ssh/sshd_config:ro")
  for hk in ed25519 rsa ecdsa; do
    [[ -f "$WORK/mode/$name/ssh_host_${hk}_key" ]] || continue
    args+=(-v "$WORK/mode/$name/ssh_host_${hk}_key:/etc/ssh/ssh_host_${hk}_key:ro")
    args+=(-v "$WORK/mode/$name/ssh_host_${hk}_key.pub:/etc/ssh/ssh_host_${hk}_key.pub:ro")
  done
  docker run -d --rm --name "$cname" -p "127.0.0.1:$port:22" "${args[@]}" pocketshell-test:helper > /dev/null
  CONTAINERS+=("$cname")
  # The readiness probe APPENDS ssh-rsa to the client's accepted host keys:
  # the sshrsa mode's sshd offers ONLY the legacy ssh-rsa algorithm, which a
  # default OpenSSH >=8.8 client does not propose (the browser and the home
  # agent both list it explicitly; this probe must meet them there).
  for _ in $(seq 1 60); do
    if ssh -i "$DESKTOP_REPO/tests-docker/test_key" -p "$port" -o BatchMode=yes -o StrictHostKeyChecking=no \
      -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa \
      -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 testuser@127.0.0.1 true 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  ssh -i "$DESKTOP_REPO/tests-docker/test_key" -p "$port" -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa \
    -o UserKnownHostsFile=/dev/null testuser@127.0.0.1 true 2>/dev/null || {
    echo "mode $name sshd never came up on :$port"; docker logs "$cname" 2>&1 | tail -6; exit 1
  }
  # -i is LOAD-BEARING: without it docker exec does not forward stdin, the
  # append reads EOF and silently writes NOTHING (exit 0) — the browser then
  # dials with a key the server has never seen.
  docker exec -i "$cname" sh -c 'cat >> /home/testuser/.ssh/authorized_keys && chmod 600 /home/testuser/.ssh/authorized_keys' < "$WORK/authorized_keys"
  # Post-conditions: every run key MUST be found in the container now.
  while read -r line; do
    fp="$(echo "$line" | awk '{print $2}')"
    docker exec "$cname" grep -qF "$(echo "$line" | awk '{print $1" "$2}')" /home/testuser/.ssh/authorized_keys || {
      echo "authorized_keys append missing a run key ($fp) in $cname"; exit 1
    }
  done < "$WORK/authorized_keys"
  docker exec "$cname" sh -lc 'mkdir -p ~testuser/git/osc-demo && chown -R testuser:testuser ~testuser/git'
}

mode_config multi ed25519 rsa ecdsa
mode_config reverse ecdsa rsa ed25519
mode_config rsaonly rsa
mode_config sshrsa rsa
mode_config ecdsaonly ecdsa
mode_config edrsa ed25519 rsa
start_mode multi "$SSH_MULTI"
start_mode reverse "$SSH_REVERSE"
start_mode rsaonly "$SSH_RSAONLY"
start_mode sshrsa "$SSH_SSHRSA"
start_mode ecdsaonly "$SSH_ECDSAONLY"
start_mode edrsa "$SSH_EDRSA"

# Out-of-band fingerprints — the pairing source the browser pins (the gateway
# is never the trust anchor).
fp_of() { ssh-keygen -lf "$1" | awk '{print $2}'; }
line_of() { awk '{print $1" "$2}' "$1"; }
{
  echo "multi ed25519 $(fp_of "$WORK/mode/multi/ssh_host_ed25519_key.pub") $(line_of "$WORK/mode/multi/ssh_host_ed25519_key.pub")"
  echo "multi ecdsa $(fp_of "$WORK/mode/multi/ssh_host_ecdsa_key.pub") $(line_of "$WORK/mode/multi/ssh_host_ecdsa_key.pub")"
  echo "reverse ed25519 $(fp_of "$WORK/mode/reverse/ssh_host_ed25519_key.pub") $(line_of "$WORK/mode/reverse/ssh_host_ed25519_key.pub")"
  echo "rsaonly rsa $(fp_of "$WORK/mode/rsaonly/ssh_host_rsa_key.pub") $(line_of "$WORK/mode/rsaonly/ssh_host_rsa_key.pub")"
  echo "sshrsa rsa $(fp_of "$WORK/mode/sshrsa/ssh_host_rsa_key.pub") $(line_of "$WORK/mode/sshrsa/ssh_host_rsa_key.pub")"
  echo "ecdsaonly ecdsa $(fp_of "$WORK/mode/ecdsaonly/ssh_host_ecdsa_key.pub") $(line_of "$WORK/mode/ecdsaonly/ssh_host_ecdsa_key.pub")"
  echo "edrsa ed25519 $(fp_of "$WORK/mode/edrsa/ssh_host_ed25519_key.pub") $(line_of "$WORK/mode/edrsa/ssh_host_ed25519_key.pub")"
} > "$WORK/hostkeys.txt"

# --- 4. the gateway instances ------------------------------------------------
REGISTRY_FILE="/var/lib/pocketshell-relay/${RUNID}-registry.json"
rm -f "$REGISTRY_FILE"
"$WORK/bin/relay" -listen "127.0.0.1:$GW_PORT" -registry "$REGISTRY_FILE" \
  -broker-issuer "$BROKER_ISSUER" \
  -broker-jwks "http://127.0.0.1:$BROKER_PORT/gateway/jwks" \
  -broker-allow-insecure-dev \
  -allow e2e-gateway@pocketshell.test \
  -origins "http://127.0.0.1:$BASE_PORT" > "$WORK/gateway-a.log" 2>&1 &
GWA_PID=$!
# The LEGACY direct relay under its documented DEV posture (no registry; the
# fixture sign-in cannot pass a real Google JWKS check — see header).
"$WORK/bin/relay" -listen "127.0.0.1:$GWB_PORT" \
  -dev-allow-any-token -dev-allow-private-hosts \
  -allow e2e-gateway@pocketshell.test \
  -origins "http://127.0.0.1:$BASE_PORT" > "$WORK/gateway-b.log" 2>&1 &
GWB_PID=$!
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$GW_PORT/healthz" | grep -q '"registry":"enabled"'; then break; fi
  sleep 0.25
done
curl -sf "http://127.0.0.1:$GW_PORT/healthz" | grep -q '"registry":"enabled"' || { echo "gateway A registry never enabled"; tail -5 "$WORK/gateway-a.log"; exit 1; }
curl -sf "http://127.0.0.1:$GWB_PORT/healthz" | grep -q '"registry":"disabled"' || { echo "gateway B wrong posture"; exit 1; }

# --- 5. enroll + run the home agents per dial-able mode ----------------------
mint_token() {
  curl -sf -X POST "http://127.0.0.1:$BROKER_PORT/gateway/token" \
    -H "Authorization: Bearer $(/usr/bin/python3 -c "import sys; sys.path.insert(0, 'tests/e2e'); from gateway_fixture_broker import GOOGLE_TOKEN; print(GOOGLE_TOKEN)")" |
    /usr/bin/python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])'
}

expect_enroll() { # device sshhost expectkeyfile  — enrollment MUST succeed
  local device="$1" sshhost="$2" keyfile="$3"
  local dir="$WORK/agent-$device"
  mkdir -p "$dir"
  local token; token="$(mint_token)"
  "$WORK/bin/pocketshell-link" enroll --token-stdin \
    --server "http://127.0.0.1:$GW_PORT" --insecure-dev \
    --dev-broker-issuer "$BROKER_ISSUER" \
    --device-id "$device" --ssh-host "$sshhost" --config-dir "$dir" \
    --expect-host-key "$(fp_of "$keyfile")" <<< "$token" > "$WORK/enroll-$device.log" 2>&1
  grep -q "host key matches --expect-host-key" "$WORK/enroll-$device.log"
  grep -q "^enrolled" "$WORK/enroll-$device.log"
  "$WORK/bin/pocketshell-link" run --server "http://127.0.0.1:$GW_PORT" --insecure-dev --config-dir "$dir" \
    > "$WORK/agent-$device.log" 2>&1 &
  local pid=$!
  AGENT_PIDS+=("$pid")
  for _ in $(seq 1 40); do
    grep -q "host connected device=$device" "$WORK/gateway-a.log" 2>/dev/null && return 0
    sleep 0.5
  done
  echo "agent $device never connected"; tail -5 "$WORK/agent-$device.log"; return 1
}

expect_enroll gwmulti "127.0.0.1:$SSH_MULTI" "$WORK/mode/multi/ssh_host_ed25519_key.pub"
expect_enroll gwreverse "127.0.0.1:$SSH_REVERSE" "$WORK/mode/reverse/ssh_host_ed25519_key.pub"
expect_enroll gwrsa "127.0.0.1:$SSH_RSAONLY" "$WORK/mode/rsaonly/ssh_host_rsa_key.pub"
expect_enroll gwsshrsa "127.0.0.1:$SSH_SSHRSA" "$WORK/mode/sshrsa/ssh_host_rsa_key.pub"
expect_enroll gwedrsa "127.0.0.1:$SSH_EDRSA" "$WORK/mode/edrsa/ssh_host_ed25519_key.pub"

# The ECDSA-only mode must REFUSE enrollment honestly, BEFORE any HTTP
# request, pinning nothing (negative mode 5).
mkdir -p "$WORK/agent-gwecdsa"
if "$WORK/bin/pocketshell-link" enroll --token-stdin \
    --server "http://127.0.0.1:$GW_PORT" --insecure-dev \
    --dev-broker-issuer "$BROKER_ISSUER" \
    --device-id gwecdsa --ssh-host "127.0.0.1:$SSH_ECDSAONLY" --config-dir "$WORK/agent-gwecdsa" \
    <<< "$(mint_token)" > "$WORK/enroll-gwecdsa.log" 2>&1; then
  echo "ECDSA-only enrollment unexpectedly SUCCEEDED"; exit 1
fi
grep -q "offers none of the enrollment host key algorithms" "$WORK/enroll-gwecdsa.log" || {
  echo "ECDSA-only enrollment failed for the wrong reason:"; cat "$WORK/enroll-gwecdsa.log"; exit 1
}
# The refusal is pre-HTTP: the probe runs before any request, so the ONLY
# broker request on record from this leg is nothing — the enroll refused
# before its token would have been validated... the token IS validated
# locally first; assert the refusal left no enrolled device behind.
if [[ -f "$WORK/agent-gwecdsa/config.json" || -f "$WORK/agent-gwecdsa/device.key" ]]; then
  echo "ECDSA-only refusal wrote agent state anyway"; ls -la "$WORK/agent-gwecdsa"; exit 1
fi

# --- 6. the production browser bundle ----------------------------------------
npx vue-tsc --noEmit
npx vite build --outDir "$WORK/dist" --emptyOutDir > "$WORK/vite-build.log" 2>&1
node_modules/.bin/vite preview --outDir "$WORK/dist" --port "$BASE_PORT" --strictPort > "$WORK/preview.log" 2>&1 &
PREVIEW_PID=$!
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$BASE_PORT/" && break
  sleep 0.2
done

# --- 7. the browser + wire proof ---------------------------------------------
cat > "$WORK/fixtures.json" << EOF
{
  "runId": "$RUNID",
  "googleEmail": "e2e-gateway@pocketshell.test",
  "keyPassphrase": "$KEY_PASSPHRASE",
  "brokerUrl": "$BROKER_ISSUER",
  "gatewayUrl": "ws://127.0.0.1:$GW_PORT",
  "legacyUrl": "ws://127.0.0.1:$GWB_PORT",
  "syncUrl": "https://sync.e2e.test",
  "directHost": "127.0.0.1",
  "directPort": $SSH_MULTI,
  "gatewayRestart": "$WORK/gateway-restart.sh",
  "gatewayRegistry": "$REGISTRY_FILE",
  "modes": {
    "multi":    {"device": "gwmulti",   "port": $SSH_MULTI,    "userKey": "key_plain"},
    "reverse":  {"device": "gwreverse", "port": $SSH_REVERSE,  "userKey": "key_enc"},
    "rsaonly":  {"device": "gwrsa",     "port": $SSH_RSAONLY,  "userKey": "key_rsa"},
    "sshrsa":   {"device": "gwsshrsa",  "port": $SSH_SSHRSA,   "userKey": "key_plain"},
    "edrsa":    {"device": "gwedrsa",   "port": $SSH_EDRSA,    "userKey": "key_plain"}
  }
}
EOF
# The advisory-tamper leg restarts gateway A over the SAME registry state
# after the harness edits the device record's advertised ssh_host_key.
cat > "$WORK/gateway-restart.sh" << EOF
#!/bin/bash
kill -9 "$GWA_PID" 2>/dev/null
sleep 1
nohup "$WORK/bin/relay" -listen "127.0.0.1:$GW_PORT" -registry "$REGISTRY_FILE" \
  -broker-issuer "$BROKER_ISSUER" \
  -broker-jwks "http://127.0.0.1:$BROKER_PORT/gateway/jwks" \
  -broker-allow-insecure-dev \
  -allow e2e-gateway@pocketshell.test \
  -origins "http://127.0.0.1:$BASE_PORT" >> "$WORK/gateway-a.log" 2>&1 &
echo \$! > "$WORK/gateway-a.pid"
for _ in \$(seq 1 40); do
  curl -sf "http://127.0.0.1:$GW_PORT/healthz" | grep -q '"registry":"enabled"' && exit 0
  sleep 0.25
done
echo "gateway A never came back"; exit 1
EOF
chmod +x "$WORK/gateway-restart.sh"

/usr/bin/python3 -u tests/e2e/e2e_gateway_prod.py \
  "http://127.0.0.1:$BASE_PORT" "$WORK" "$WORK/fixtures.json"
status=$?

# --- 8. receipts --------------------------------------------------------------
docker images --format "{{.Repository}}:{{.Tag}} {{.ID}}" | grep '^pocketshell-test:helper' >> "$WORK/receipt.env" || true
docker inspect --format '{{.Name}} {{.Image}} {{.Config.Image}}' "${CONTAINERS[@]}" > "$WORK/containers.txt" || true
echo "artifacts in $WORK"
exit "$status"
