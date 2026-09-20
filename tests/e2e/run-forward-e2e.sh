#!/usr/bin/env bash
# End-to-end test for the /fwd/ browser-only port forwarder: the app's
# forwarder (src/forward/) opens SSH direct-tcpip channels through the local
# dev relay (relay/dev-relay.mjs) to the REAL sshd fixture
# (tests-docker/pocketshell-test:ssh, AllowTcpForwarding yes), which dials a
# far-side HTTP server running INSIDE the container on :8000. A pass proves
# the whole chain in a real browser build: service worker intercept → app-tab
# forwarder → browser ssh2 → dumb relay → sshd direct-tcpip → far side; the
# rewriting, guidance pages, and the ciphertext-only relay wire.
#
# Usage: tests/e2e/run-forward-e2e.sh
# Requires: docker, /usr/bin/python3 with playwright.
set -euo pipefail
cd "$(dirname "$0")/../.."

ELECTRON_REPO="${ELECTRON_REPO:-$HOME/git/pocketshell-electron}"
COMPOSE="docker compose -f $ELECTRON_REPO/tests-docker/docker-compose.yml"

WORK="$(mktemp -d /tmp/ps-web-forward-e2e.XXXXXX)"
echo "forward e2e workdir: $WORK"

free_port() {
  /usr/bin/python3 - <<PY
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0))
print(s.getsockname()[1]); s.close()
PY
}

# --- 1. the sshd fixture ------------------------------------------------------
$COMPOSE build ssh >/dev/null
CNAME="ps-web-forward-e2e-$$"
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
  ssh-keygen -t ed25519 -N ' ' -C pocketshell-web-forward-e2e -f "$WORK/key_real" -q
  chmod 600 "$WORK/key_real"
  echo "id_hetzner not found — using a generated one-space-passphrase key"
fi

ssh-keygen -y -f "$WORK/key_real" > "$WORK/key_real.pub"
docker exec -i "$CNAME" sh -c 'cat >> /home/testuser/.ssh/authorized_keys && chmod 600 /home/testuser/.ssh/authorized_keys' < "$WORK/key_real.pub"

# Readiness gate, same as run-direct-e2e.sh.
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

# --- 2. the far side: an HTTP server inside the container on :8000 ------------
docker exec -i "$CNAME" sh -c 'mkdir -p /www && cat > /www/server.py' <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

INDEX = (b'<!doctype html><html><head><title>PS-FWD-APP</title>'
         b'<link rel="stylesheet" href="/style.css"></head>'
         b'<body><h1>PS-FWD-OK</h1>'
         b'<a id="sub" href="/sub.html">go sub</a>'
         b'<a id="rel" href="rel.html">go rel</a></body></html>')

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _send(self, status, ctype, body, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/headers.json':
            self._send(200, 'application/json', json.dumps(dict(self.headers)).encode())
        elif p == '/redirect':
            self._send(302, 'text/plain', b'', [('Location', '/landing')])
        elif p == '/landing':
            self._send(200, 'text/html', b'<html><body>PS-FWD-LAND-OK</body></html>', [('Set-Cookie', 'far=1')])
        elif p == '/chunked':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            for part in (b'for', b'ward', b'-end'):
                self.wfile.write(hex(len(part))[2:].encode() + b'\r\n' + part + b'\r\n')
            self.wfile.write(b'0\r\n\r\n')
        elif p == '/sub.html':
            self._send(200, 'text/html', b'<html><body>PS-FWD-SUB-OK</body></html>')
        elif p == '/rel.html':
            self._send(200, 'text/html', b'<html><body>PS-FWD-REL-OK</body></html>')
        else:
            self._send(200, 'text/html', INDEX)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        self._send(200, 'application/octet-stream', self.rfile.read(n))

    def log_message(self, *a):
        pass

HTTPServer(('127.0.0.1', 8000), H).serve_forever()
PY
docker exec -d "$CNAME" python3 /www/server.py
for _ in $(seq 1 40); do
  if docker exec "$CNAME" python3 -c "import urllib.request; assert b'PS-FWD-OK' in urllib.request.urlopen('http://127.0.0.1:8000/', timeout=2).read()" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
docker exec "$CNAME" python3 -c "import urllib.request; assert b'PS-FWD-OK' in urllib.request.urlopen('http://127.0.0.1:8000/', timeout=2).read()" \
  || { echo "far-side server never came up in the fixture"; exit 1; }

# --- 3. relay + real dist + preview --------------------------------------------
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

# --- 4. the browser flow --------------------------------------------------------
/usr/bin/python3 tests/e2e/e2e_forward.py \
  "http://localhost:$BASE_PORT" "$WORK" "$FIXTURE_PORT" "$RELAY_PORT"
status=$?

echo "artifacts in $WORK (relay log: $WORK/relay.log)"
exit "$status"
