"""End-to-end: config import + key upload + real terminal + gateway dial.

Drives the built app in Chromium with five network fakes, everything else
real (see run-e2e.sh):

  /config.js + GIS    stubbed exactly like .tmp/auth-review-capture.py does
                      for visual captures — a fake button that signs in via
                      the app's own callback.
  sync.e2e.test       a fake settings store: it records every body and only
                      ever accepts/re-serves opaque envelopes. The test then
                      decrypts the captured envelopes with the sync passphrase
                      (cryptography is a test-side dependency, like the
                      desktop app's node:crypto) to prove what LEFT the
                      browser and that it was ciphertext until it left — both
                      slots: the host list (`main`) AND the roaming key
                      envelope (`keys`).
  gateway-broker.e2e.test
                      the trusted account service's POST /gateway/token, as
                      the real contract behaves: EMPTY body, the Google
                      sign-in ONLY in the Authorization header, and a
                      short-lived scoped routing token back.
  direct.e2e.test      the browser-direct transport, end to end: a dumb
                       WebSocket<->TCP pipe (what relay/ deploys). The
                       browser runs its own ssh2 client and speaks REAL SSH
                       to the pocketshell-test:helper container through the
                       pipe; nothing about the final hop is stubbed. A wrong
                       key or passphrase fails the handshake and the route
                       never reaches the host workspace, which is the pass
                       marker. Because the pipe is dumb, the test can prove
                       the transport's core property: the private key, its
                       passphrase and the config canary appear in no byte OR
                       TEXT FRAME the browser ever puts on this wire.
  gateway.e2e.test     the gateway PROTOCOL shape — auth frame, ready frame,
                       then opaque binary — with the fixture's real sshd
                       behind it. This is NOT the Go production gateway: it
                       is the wire contract the browser must speak, enough to
                       run a real browser dial (broker exchange -> auth frame
                       with ONLY the scoped token -> ready -> real SSH
                       session) end to end. Production-gateway claims are
                       made elsewhere or not at all.

The OSC 52 clipboard leg rides a REAL terminal: the folder-first workspace's
"Start a session here" -> Shell -> the shipping TerminalView xterm with its
registered OSC 52 handler, driven through the fixture's PTY (an aplexer
session on the helper fixture, which relays the escape verbatim — probed).

Usage: /usr/bin/python3 tests/e2e/e2e_hosts_keys.py <base-url> <workdir> <fixture-port> <container> <key-pub-path>
"""

import asyncio
import base64
import json
import os
import subprocess
import sys
import time

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/')
WORK = sys.argv[2]
FIXTURE_PORT = int(sys.argv[3])
CONTAINER = sys.argv[4]
KEY_PUB_PATH = sys.argv[5]

SYNC_PASSPHRASE = 'e2e-sync-pass-entence'
KEY_PASSPHRASE = 'e2e-key-passphrase'
CANARY = 'e2e-canary-7f3k4m'
OSC52_MARKER = 'e2e-osc52-yank-qk9w2m'
CLIPBOARD_SENTINEL = 'pre-yank-clipboard-sentinel'
GW_TOKEN = 'e2e-gw-routing-token.scoped.jwt'
GW_DEVICE = 'dev-e2e'
GW_SERVER = 'wss://gateway.e2e.test'

CONFIG_STUB = (
    "window.POCKETSHELL_WEB = { syncApiUrl: 'https://sync.e2e.test', "
    "googleClientId: 'stub.apps.googleusercontent.com', wsUrl: 'wss://bridge.e2e.test/link', "
    "directWsUrl: 'wss://direct.e2e.test/pipe', syncApiBase: 'https://gateway-broker.e2e.test' };"
)

GIS_STUB = """
window.google = { accounts: { id: {
  initialize(o) { window.__gsiInit = o; },
  renderButton(el) {
    const b = document.createElement('button');
    b.id = 'gsi-fake'; b.textContent = 'Sign in with Google';
    el.appendChild(b);
  },
  prompt() {},
} } };
"""


def b64url(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b'=').decode()


def fake_jwt() -> str:
    return f"{b64url({'alg': 'none'})}.{b64url({'email': 'e2e@pocketshell.test', 'exp': 4102444800})}.x"


# The sign-in IS this JWT — the custody scan follows THIS exact string: it may
# ride the Authorization header to the account surfaces (sync + broker) and
# nothing else: no relay frame, no gateway frame, no other URL.
GOOGLE_TOKEN = fake_jwt()

# The credential/canary set the wire-custody oracle scans for — the SAME set
# on BOTH surfaces (a private key riding a text frame is exactly the leak a
# binary-only scan misses). The OSC 52 marker is deliberately NOT in it: that
# string is terminal payload the test itself puts on the wire (typed into the
# PTY), not a credential.
SECRETS_AS_TEXT = [CANARY, KEY_PASSPHRASE, GOOGLE_TOKEN, 'BEGIN OPENSSH PRIVATE KEY']
SECRETS_AS_BYTES = [s.encode() for s in SECRETS_AS_TEXT]


def decrypt_envelope(envelope: str, passphrase: str) -> str:
    """The desktop's SyncCrypto, test-side: same envelope, python runtime."""
    fields = json.loads(envelope)
    assert fields['v'] == 1 and fields['kdf'] == 'pbkdf2-sha256', fields
    key = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=base64.b64decode(fields['salt']),
        iterations=fields['iter'],
    ).derive(passphrase.encode())
    plain = AESGCM(key).decrypt(base64.b64decode(fields['iv']), base64.b64decode(fields['ct']), None)
    return plain.decode()


def assert_wire_custody(binary: bytes, texts: list[str], where: str) -> None:
    """The wire-custody oracle, shared by the live assertions and the offline
    negative control: NO secret/canary may appear in ANY recorded frame —
    binary or text, scanned against the SAME full set. Text frames are the
    point: an SSH transport speaks binary, so a credential riding a text
    frame is a protocol anomaly the old binary-only scan would have recorded
    and ignored."""
    joined = '\n'.join(texts)
    for secret in SECRETS_AS_TEXT:
        assert secret not in joined, f'{where}: {secret[:24]}… reached a TEXT frame'
    for secret in SECRETS_AS_BYTES:
        assert secret not in binary, f'{where}: {secret[:24]!r} reached the binary wire'


def custody_negative_control() -> None:
    """Offline selftest: the oracle must REJECT a deliberately injected
    credential in every surface it claims to scan. If this ever stops
    failing-on-poison, the live custody assertions are decoration."""
    for poisoned in (
        {'binary': b'', 'texts': [f'{"x" * 40}BEGIN OPENSSH PRIVATE KEY{"y" * 40}']},
        {'binary': b'\x00\x01' + KEY_PASSPHRASE.encode(), 'texts': []},
        {'binary': b'', 'texts': [f'auth token {GOOGLE_TOKEN}']},
        {'binary': CANARY.encode(), 'texts': []},
    ):
        threw = False
        try:
            assert_wire_custody(poisoned['binary'], poisoned['texts'], 'negative-control')
        except AssertionError:
            threw = True
        assert threw, f'custody oracle FAILED to reject an injected credential: {poisoned}'


class FakeSync:
    """The settings API as the real one behaves: PER-SLOT opaque blobs, each
    with its own version — `main` (the host list) and `keys` (the roaming
    credential envelope) are independent slots, so one slot's writes never
    advance the other's base version."""

    def __init__(self):
        self.versions = {'main': 0, 'keys': 0}
        self.data = {'main': None, 'keys': None}
        self.put_bodies: list[dict] = []
        self.all_bodies: list[tuple[str, str, str]] = []

    def _slot(self, url: str) -> str | None:
        for name in ('main', 'keys'):
            if url.endswith(f'/settings/{name}'):
                return name
        return None

    async def handle(self, route):
        req = route.request
        body = req.post_data or ''
        self.all_bodies.append((req.method, req.url, body))
        if req.url.endswith('/me'):
            await route.fulfill(content_type='application/json', body='{"sub":"e2e","email":"e2e@pocketshell.test"}')
            return
        slot = self._slot(req.url)
        if slot is None:
            await route.fulfill(status=404, content_type='application/json', body='{}')
            return
        if req.method == 'GET':
            if self.data[slot] is None:
                await route.fulfill(status=404, content_type='application/json', body='{"message":"no slot"}')
            else:
                await route.fulfill(
                    content_type='application/json',
                    body=json.dumps({'slot': slot, 'version': self.versions[slot], 'data': self.data[slot]}),
                )
        elif req.method == 'PUT':
            parsed = json.loads(body)
            assert parsed['version'] == self.versions[slot], (
                f'{slot} base version {parsed["version"]} != {self.versions[slot]}'
            )
            self.put_bodies.append(parsed)
            self.data[slot] = parsed['data']
            self.versions[slot] += 1
            await route.fulfill(content_type='application/json', body=json.dumps({'version': self.versions[slot]}))
        else:
            await route.fulfill(status=404, content_type='application/json', body='{}')


class _TcpPipe:
    """One WebSocket<->TCP ferry: browser bytes to the fixture, fixture bytes
    back, both directions recorded for the custody oracle."""

    def __init__(self, fixture_port: int):
        self.relayed = b""
        self.browser_text: list[str] = []
        self.from_server = b""
        self._writer = None
        self._reader = None
        self._pending: list[bytes] = []
        self._connect = asyncio.ensure_future(asyncio.open_connection("127.0.0.1", fixture_port))

        def _ready(task):
            try:
                self._reader, self._writer = task.result()
                for chunk in self._pending:
                    self._writer.write(chunk)
                self._pending.clear()
            except Exception as e:  # noqa: BLE001 - a dead ferry must name itself in the receipt
                print(f'--- pipe: TCP CONNECT FAILED: {e!r}')

        self._connect.add_done_callback(_ready)

    def to_server(self, payload: bytes) -> None:
        if self._writer is None:
            # First browser bytes arrive before the TCP dial resolves; park
            # them and flush once it does (the SSH banner waits either way).
            self._pending.append(payload)
            return
        self._writer.write(payload)

    async def pump_to(self, ws):
        try:
            await self._connect
            while True:
                chunk = await self._reader.read(4096)
                if not chunk:
                    break
                self.from_server += chunk
                ws.send(bytes(chunk))  # WebSocketRoute.send is sync
        except (ConnectionError, OSError, asyncio.CancelledError):
            pass

    def close(self) -> None:
        if self._writer is not None:
            self._writer.close()


class FakeRelay:
    """The browser-direct transport, end to end: a dumb WebSocket<->TCP pipe
    — exactly what relay/ deploys. The browser runs its own ssh2 client and
    speaks REAL SSH straight at the fixture's sshd; this side only ferries
    opaque bytes between the WebSocket and 127.0.0.1:<fixture-port> and is
    deliberately positioned to PROVE it can never read the credentials: the
    private key, its passphrase and the config canary must appear in no byte
    AND no text frame the browser ever puts on this wire."""

    def __init__(self, fixture_port: int):
        self.fixture_port = fixture_port
        self.dials = 0
        self.urls: list[str] = []
        self.pipes: list[_TcpPipe] = []

    async def handle(self, ws):
        self.dials += 1
        self.urls.append(ws.url)
        pipe = _TcpPipe(self.fixture_port)
        self.pipes.append(pipe)

        def on_message(payload) -> None:
            if isinstance(payload, str):
                # The SSH transport speaks binary; any text frame is protocol
                # noise — recorded HERE and SCANNED by the custody oracle
                # with the same weight as the binary bytes.
                pipe.browser_text.append(payload)
                return
            pipe.relayed += payload
            pipe.to_server(payload)

        ws.on_message(on_message)
        pump_task = asyncio.ensure_future(pipe.pump_to(ws))

        def on_close() -> None:
            pipe.close()
            pump_task.cancel()

        ws.on_close(on_close)

    def every_relayed_byte(self) -> bytes:
        return b"".join(p.relayed for p in self.pipes)

    def every_text_frame(self) -> list[str]:
        return [t for p in self.pipes for t in p.browser_text]


class FakeGateway:
    """The gateway WIRE CONTRACT, not the production server: the browser's
    gatewayDuplex dials /api/v1/hosts/{device}/ssh, sends ONE TEXT auth frame
    (the scoped BROKER token — never the raw Google sign-in, never key
    material), and after this side answers `ready` the socket is ordered
    binary only, ferried to the fixture's real sshd. Everything recorded is
    fed to the custody oracle; the auth frame is additionally asserted to
    carry EXACTLY the expected routing token."""

    def __init__(self, fixture_port: int, device_id: str, host_key_line: str):
        self.fixture_port = fixture_port
        self.device_id = device_id
        self.host_key_line = host_key_line
        self.dials = 0
        self.urls: list[str] = []
        self.auth_frames: list[dict] = []
        self.text_after_ready: list[str] = []
        self.pipes: list[_TcpPipe] = []
        self.ready_sent = 0

    async def handle(self, ws):
        # Playwright dispatches WebSocket message events only AFTER this
        # handler returns, so awaiting the auth frame IN the handler would
        # deadlock against its own delivery (the direct relay's handler
        # returns immediately, which is why it never shows this). Register
        # everything, return, and run the handshake in a spawned task.
        self.dials += 1
        self.urls.append(ws.url)
        pipe = _TcpPipe(self.fixture_port)
        self.pipes.append(pipe)
        first_text: asyncio.Future = asyncio.get_running_loop().create_future()

        def on_message(payload) -> None:
            if isinstance(payload, str):
                if first_text.done() or first_text.cancelled():
                    self.text_after_ready.append(payload)
                    return
                first_text.set_result(payload)
                return
            pipe.relayed += payload
            pipe.to_server(payload)

        ws.on_message(on_message)

        async def handshake():
            try:
                raw = await asyncio.wait_for(first_text, 15)
            except asyncio.TimeoutError:
                return
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                frame = {'type': 'unreadable', 'raw': raw}
            self.auth_frames.append(frame)
            if frame.get('type') != 'auth' or frame.get('device_id') != self.device_id:
                return
            self.ready_sent += 1
            ws.send(json.dumps({'type': 'ready', 'v': 1, 'device_id': self.device_id, 'ssh_host_key': self.host_key_line}))
            pump_task = asyncio.ensure_future(pipe.pump_to(ws))

            def on_close() -> None:
                pipe.close()
                pump_task.cancel()

            ws.on_close(on_close)

        asyncio.ensure_future(handshake())

    def every_relayed_byte(self) -> bytes:
        return b"".join(p.relayed for p in self.pipes)

    def every_text_frame(self) -> list[str]:
        return [t for p in self.pipes for t in p.browser_text] + [json.dumps(f) for f in self.text_after_ready]


async def handle_broker(route):
    """POST /gateway/token under the real contract: EMPTY body, the Google
    sign-in ONLY as the Authorization bearer, a scoped short-lived token back."""
    req = route.request
    assert req.method == 'POST' and req.url.endswith('/gateway/token'), (req.method, req.url)
    assert (req.post_data or '') == '', 'the broker exchange must send an empty body'
    authz = (await req.header_value('authorization')) or ''
    assert authz == f'Bearer {GOOGLE_TOKEN}', f'broker saw an unexpected Authorization: {authz[:40]}…'
    await route.fulfill(
        content_type='application/json',
        body=json.dumps({'token': GW_TOKEN, 'token_type': 'Bearer', 'expires_in': 240, 'expires_at': int(time.time()) + 240}),
    )


async def wait_for(predicate, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            ok = predicate()
            if asyncio.iscoroutine(ok) or hasattr(ok, '__await__'):
                ok = await ok
        except Exception as e:  # noqa: BLE001 - probe errors are just "not yet"
            ok = False
            last = e
        if ok:
            return
        await asyncio.sleep(0.3)
    raise AssertionError(f'timed out waiting for {what} (last: {last})')


async def clipboard_equals(page, expected: str, timeout: float = 12.0) -> None:
    async def read() -> bool:
        return await page.evaluate('navigator.clipboard.readText()') == expected

    await wait_for(read, timeout, f'clipboard to become {expected!r}')


# Failure diagnostics: the flow's page + console errors, dumped when the run
# dies mid-flow so a stalled selector names what the app was actually showing.
PAGE = None
CONSOLE_ERRORS: list[str] = []


async def dump_diagnostics() -> None:
    try:
        print(f'--- failure diagnostics: url={PAGE.url}')
        print('--- console errors ---')
        for e in CONSOLE_ERRORS:
            print(f'  {e}')
        shot = os.path.abspath('e2e-failure.png')
        await PAGE.screenshot(path=shot)
        print(f'--- screenshot: {shot}')
        text = await PAGE.inner_text('body')
        print('--- visible text (first 1500 chars) ---')
        print(text[:1500])
    except Exception as e:  # noqa: BLE001 - diagnostics must never mask the error
        print(f'(diagnostics unavailable: {e})')


async def unlock_on_app(page) -> None:
    await page.goto(BASE + '/app', wait_until='networkidle')
    await page.fill('input[type=password]', SYNC_PASSPHRASE)
    await page.click('button.primary:has-text("Unlock")')


async def connect_from_host_list(page, name: str) -> None:
    await page.locator('.host-row', has_text=name).get_by_role('button', name='Connect').click()
    try:
        await page.wait_for_url(f'**/host/{name}', timeout=30_000)
    except Exception:
        # A failed or stalled dial: surface what the connection store says so
        # the receipt names the refusal, not just the timeout.
        await page.wait_for_timeout(2_000)
        print(f'--- dial to {name} did not navigate; connection store: {await connection_state(page)}')
        raise


async def connection_state(page) -> dict:
    return await page.evaluate(
        "(() => { const app = document.querySelector('#app').__vue_app__;"
        'const p = app.config.globalProperties.$pinia;'
        "const c = p.state.value.connection || {};"
        "return { error: c.error ?? null, state: c.state ?? null }; })()"
    )


async def main() -> int:
    global PAGE
    custody_negative_control()
    print('custody negative control: injected credentials are rejected by the oracle')

    sync = FakeSync()
    relay = FakeRelay(FIXTURE_PORT)
    host_key_line = open(os.path.join(WORK, 'host_key.pub')).read().strip()
    gateway = FakeGateway(FIXTURE_PORT, GW_DEVICE, host_key_line)
    http_surfaces: list[tuple[str, str]] = []
    console_errors: list[str] = []

    def on_request(req):
        http_surfaces.append((req.method, req.url))

    pw = await async_playwright().start()
    browser = await pw.chromium.launch()
    # Clipboard grants let the test both write (OSC 52 handler) and read
    # back what a yank landed in — navigator.clipboard, real Chromium.
    context = await browser.new_context(
        viewport={'width': 1280, 'height': 800},
        permissions=['clipboard-read', 'clipboard-write'],
    )
    page = await context.new_page()
    PAGE = page
    try:
        page.on(
            'console',
            # Resource 404s from the fake API are the protocol working
            # (first pull is a legitimate 404); anything else is a bug.
            lambda m: (console_errors.append(m.text), CONSOLE_ERRORS.append(m.text))
            if m.type == 'error' and 'Failed to load resource' not in m.text
            else None,
        )
        page.on('request', on_request)
        await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=CONFIG_STUB))
        await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=GIS_STUB))
        await page.route('**/sync.e2e.test/**', sync.handle)
        await page.route('**/gateway-broker.e2e.test/**', handle_broker)
        await page.route_web_socket('**/direct.e2e.test/**', relay.handle)
        await page.route_web_socket('**/gateway.e2e.test/**', gateway.handle)

        # --- sign in and unlock (empty account) -----------------------------
        await page.goto(BASE + '/', wait_until='networkidle')
        await page.evaluate(f"window.__gsiInit.callback({{credential: '{GOOGLE_TOKEN}'}})")
        # Sign-in lands on the shared host picker (route /); host prep —
        # unlock, keys, import — lives one hop away on /app.
        await page.goto(BASE + '/app', wait_until='networkidle')
        await page.fill('input[type=password]', SYNC_PASSPHRASE)
        await page.click('button.primary:has-text("Unlock")')
        await page.wait_for_selector('text=No hosts synced yet')

        # --- manual host + key file upload ----------------------------------
        await page.click('button:has-text("Add host")')
        await page.fill('input[placeholder="Name (e.g. prod-box)"]', 'manualbox')
        await page.fill('input[placeholder="Hostname"]', '127.0.0.1')
        await page.fill('input[placeholder="Port"]', str(FIXTURE_PORT))
        await page.fill('input[placeholder="User (optional)"]', 'testuser')
        await page.click('button:has-text("Save")')
        await page.wait_for_selector('text=Saved manualbox')

        await page.locator('.host-row', has_text='manualbox').get_by_role('button', name='Key…').click()
        await page.set_input_files('input[aria-label="Private key file"]', os.path.join(WORK, 'key_plain'))
        await page.fill('input[aria-label="Key passphrase"]', '')
        await page.locator('details.keybox', has_text='Private key for manualbox').get_by_role('button', name='Save').click()
        await page.wait_for_selector('text=Key for manualbox stored encrypted')
        # The credential envelope is in localStorage; it must be opaque.
        local = await page.evaluate("localStorage.getItem('ps.hostKeys')")
        assert 'BEGIN' not in local and KEY_PASSPHRASE not in local, 'plaintext credential in localStorage!'

        # --- connect manualbox: the browser's own ssh2 dials the REAL sshd --
        await connect_from_host_list(page, 'manualbox')

        # Back to host prep: a full navigation resets the in-memory stores —
        # so it means unlocking again, and the connection itself was never
        # the unlock's cargo.
        await unlock_on_app(page)
        await page.wait_for_selector('button:has-text("Import config")')

        # --- import from SSH config -----------------------------------------
        # keylesstest shares dockertest's AND manualbox's endpoint ON PURPOSE:
        # this is the original selection-collision counterexample. The old
        # endpoint-first resolution resolved a keylesstest dial to manualbox's
        # record and borrowed its key; the fixed resolution must refuse the
        # ambiguity (or select the exact record) instead.
        await page.click('button:has-text("Import config")')
        await page.set_input_files('input[aria-label="SSH config file"]', os.path.join(WORK, 'import.config'))
        await page.click('button:has-text("Parse hosts")')
        await page.wait_for_selector('.import-row')
        rows = await page.locator('.import-row').all_inner_texts()
        assert any('dockertest' in r for r in rows), rows
        assert any('already synced' in r for r in rows), rows
        assert any('pattern' in r and 'skipped' in r for r in await page.locator('.import-hint').all_inner_texts()), rows
        # New hosts pre-checked, the synced one not re-ticked by default.
        assert await page.locator('.import-row', has_text='dockertest').locator('input[type=checkbox]').is_checked()
        assert await page.locator('.import-row', has_text='keylesstest').locator('input[type=checkbox]').is_checked()
        assert not await page.locator('.import-row', has_text='manualbox').locator('input[type=checkbox]').is_checked()
        await page.click('button:has-text("Import 2 hosts")')

        # --- missing credentials step → upload the ENCRYPTED key ------------
        await page.wait_for_selector('text=2 imported hosts have')
        await page.locator('.import-row', has_text='dockertest').get_by_role('button', name='Add key…').click()
        await page.set_input_files('input[aria-label="Private key file"]', os.path.join(WORK, 'key_enc'))
        await page.fill('input[aria-label="Key passphrase"]', KEY_PASSPHRASE)
        await page.locator('details.keybox', has_text='Private key for dockertest').get_by_role('button', name='Save').click()
        await page.wait_for_selector('text=Key for dockertest stored encrypted')
        # Saving the one key re-opens the credentials step for the host that
        # still lacks one; Done leaves the flow.
        await page.wait_for_selector('button:has-text("Done for now")')
        assert 'keylesstest' in await page.locator('.import-list').inner_text()
        assert 'dockertest' not in await page.locator('.import-list').inner_text()
        await page.click('button:has-text("Done for now")')
        await page.wait_for_selector('text=Imported 2 hosts')

        # --- the selection collision: keylesstest must NOT borrow a sibling's
        # key. The refusal must SURFACE (a deterministic acknowledgment, not
        # an inert click) and open no relay socket, navigate nowhere.
        dials_before = relay.dials
        await page.locator('.host-row', has_text='keylesstest').get_by_role('button', name='Connect').click()
        await wait_for(
            lambda: page.evaluate(
                "(() => { const app = document.querySelector('#app').__vue_app__;"
                'const p = app.config.globalProperties.$pinia;'
                "return (p.state.value.connection || {}).error || ''; })()"
            ),
            10,
            'the keyless/ambiguous refusal to surface in the connection store',
        )
        surfaced = await connection_state(page)
        assert surfaced['error'], f'no refusal surfaced: {surfaced}'
        print(f"keyless-collision refusal surfaced: {surfaced['error'][:100]}")
        await page.wait_for_timeout(2_000)
        assert relay.dials == dials_before, 'a refused dial must not open a relay socket'
        assert '/host/' not in page.url, 'a refused dial must not navigate to the host'
        assert surfaced['state'] == 'idle', f'the dial must settle as idle, saw {surfaced["state"]}'

        # --- connect the imported host: its OWN key must travel and work ----
        await connect_from_host_list(page, 'dockertest')

        # --- OSC 52 through a REAL terminal ---------------------------------
        # The folder ~/git/osc-demo exists on the fixture but holds no
        # sessions, so no panel row can reach it yet; the harness enters it
        # the way a deep link does — through the app's own router — which
        # lands the folder-first workspace on its empty state.
        await page.evaluate(
            "(() => { const app = document.querySelector('#app').__vue_app__;"
            "return app.config.globalProperties.$router.push("
            "{ name: 'folder', params: { name: 'dockertest', folder: '~/git/osc-demo' } }); })()"
        )
        await page.wait_for_selector('button:has-text("Start a session here")', timeout=20_000)
        await page.click('button:has-text("Start a session here")')
        await page.wait_for_selector('text=New session', timeout=10_000)
        # The dialog defaults to an agent; pick the plain shell.
        await page.get_by_role('tab', name='Shell').click()
        await page.get_by_role('button', name='Create session').click()
        # A real PTY attached through the shipping TerminalView: the xterm
        # whose parser carries the registered OSC 52 handler.
        await page.wait_for_selector('.xterm-screen', timeout=30_000)
        await page.wait_for_timeout(2_000)  # let the aplexer attach settle

        # Pre-existing clipboard content: the SET must overwrite it, the
        # refused CLEAR must leave the yanked marker in place.
        await page.evaluate(f"navigator.clipboard.writeText({CLIPBOARD_SENTINEL!r})")
        await clipboard_equals(page, CLIPBOARD_SENTINEL)

        payload = base64.b64encode(OSC52_MARKER.encode()).decode()
        await page.locator('.xterm-screen').first.click()
        await page.keyboard.type(f"printf '\\033]52;c;{payload}\\a'")
        await page.keyboard.press('Enter')
        await clipboard_equals(page, OSC52_MARKER)
        print('OSC 52 SET: remote yank reached the browser clipboard through the real terminal')

        # A remote must not be able to BLANK the clipboard: the empty-payload
        # sequence is refused by the shipping handler.
        await page.keyboard.type("printf '\\033]52;c;\\a'")
        await page.keyboard.press('Enter')
        await page.wait_for_timeout(2_000)
        await clipboard_equals(page, OSC52_MARKER)
        print('OSC 52 CLEAR: empty-payload refusal kept the yanked marker')

        # --- kill the sibling key, reload, redial ---------------------------
        # With key_plain (manualbox's credential) deleted from authorized_keys,
        # a dockertest dial can only succeed on dockertest's OWN restored key:
        # the old endpoint-first borrow would now authenticate with the dead
        # key and fail — the reload redial is the selection + key-restore
        # proof in one.
        pubkey = open(KEY_PUB_PATH).read().strip()
        subprocess.run(
            [
                'docker', 'exec', CONTAINER, 'sh', '-c',
                f"grep -vF '{pubkey}' /home/testuser/.ssh/authorized_keys"
                ' > /home/testuser/.ssh/authorized_keys.tmp'
                ' && mv /home/testuser/.ssh/authorized_keys.tmp /home/testuser/.ssh/authorized_keys',
            ],
            check=True,
        )
        probe = subprocess.run(
            ['docker', 'exec', CONTAINER, 'sh', '-c', f"grep -cF '{pubkey}' /home/testuser/.ssh/authorized_keys || true"],
            capture_output=True, text=True,
        )
        assert probe.stdout.strip() == '0', 'fixture key removal did not take effect'

        await page.reload()
        # The reload lands on the host workspace with fresh stores; route back
        # to host prep and unlock again. The unlock's keys-slot merge is
        # asynchronous (PBKDF2 twice + the account pull) while the host ROWS
        # render from the main slot as soon as it lands — so the harness waits
        # for the merged credential map the same way a user's first click
        # naturally lands after it.
        await unlock_on_app(page)
        await page.wait_for_selector('.host-row')
        await wait_for(
            lambda: page.evaluate(
                "(() => { const app = document.querySelector('#app').__vue_app__;"
                'const p = app.config.globalProperties.$pinia;'
                "const h = p.state.value.hosts || {};"
                "return (h.secretHosts ?? []).includes('dockertest'); })()"
            ),
            20,
            'the restored keys envelope to finish merging into the session',
        )
        names = await page.locator('.host-row .name').all_inner_texts()
        assert sorted(names) == ['dockertest', 'keylesstest', 'manualbox'], names
        await connect_from_host_list(page, 'dockertest')

        # --- the gateway dial -----------------------------------------------
        # A full browser gateway acceptance over the PROTOCOL fixture: add a
        # gateway host, pair it out of band (the fixture's real ED25519
        # fingerprint), attach its key, connect — broker exchange, auth frame
        # with ONLY the scoped token, ready, real SSH end to end.
        await unlock_on_app(page)
        await page.click('button:has-text("Add host")')
        await page.fill('input[placeholder="Name (e.g. prod-box)"]', 'gwbox')
        await page.fill('input[placeholder="Hostname"]', 'gw.e2e.test')
        await page.fill('input[placeholder="Port"]', '22')
        await page.fill('input[placeholder="User (optional)"]', 'testuser')
        await page.fill('#hf-gw-device', GW_DEVICE)
        await page.fill('#hf-gw-url', GW_SERVER)
        await page.click('button:has-text("Save")')
        await page.wait_for_selector('text=Saved gwbox')

        await page.locator('.host-row', has_text='gwbox').get_by_role('button', name='Key…').click()
        await page.set_input_files('input[aria-label="Private key file"]', os.path.join(WORK, 'key_enc'))
        await page.fill('input[aria-label="Key passphrase"]', KEY_PASSPHRASE)
        await page.locator('details.keybox', has_text='Private key for gwbox').get_by_role('button', name='Save').click()
        await page.wait_for_selector('text=Key for gwbox stored encrypted')

        fingerprint = subprocess.run(
            ['docker', 'exec', CONTAINER, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub'],
            capture_output=True, text=True, check=True,
        ).stdout.split()[1]
        await page.locator('.host-row', has_text='gwbox').get_by_role('button', name='Pair…').click()
        await page.fill('input[aria-label="Host key fingerprint"]', fingerprint)
        await page.click('button:has-text("Save fingerprint")')
        await page.wait_for_selector('text=gwbox is paired')

        await connect_from_host_list(page, 'gwbox')
    except BaseException:
        await dump_diagnostics()
        raise
    finally:
        await context.close()
        await browser.close()
        await pw.stop()

    # --- wire-level assertions ----------------------------------------------
    # 0. The custody oracle's surfaces: HTTP requests (all of them), relay
    #    frames (binary AND text), gateway frames (binary AND text), socket
    #    URLs. The negative control above proved the oracle bites.
    #
    # The Google sign-in's accepted surfaces, per the documented credential
    # boundary: the Authorization header to the account surfaces (sync +
    # broker) and — legacy, until that transport migrates — the DIRECT
    # relay's query string, which that relay itself authorizes. The GATEWAY
    # carries none of it (its admission is the broker-scoped routing token,
    # asserted at the auth frame below), and no key/canary material rides
    # ANY surface.
    allow_google_in_url = ('direct.e2e.test', 'sync.e2e.test', 'gateway-broker.e2e.test')
    for method, url in http_surfaces:
        for secret in SECRETS_AS_TEXT:
            if secret == GOOGLE_TOKEN:
                continue  # token-bearing URLs are checked per-host below
            assert secret not in url, f'{secret[:24]}… appeared in a request URL: {method} {url}'
        if GOOGLE_TOKEN in url:
            assert any(host in url for host in allow_google_in_url), (
                f'the Google sign-in reached a non-account surface: {method} {url}'
            )
    assert_wire_custody(relay.every_relayed_byte(), relay.every_text_frame(), 'direct-relay')
    assert_wire_custody(gateway.every_relayed_byte(), gateway.every_text_frame(), 'gateway')
    for url in gateway.urls:
        for secret in SECRETS_AS_TEXT:
            assert secret not in url, f'{secret[:24]}… appeared in a gateway WebSocket URL'
    for url in relay.urls:
        for secret in SECRETS_AS_TEXT:
            if secret == GOOGLE_TOKEN:
                continue  # the documented legacy boundary: this relay authorizes the query token
            assert secret not in url, f'{secret[:24]}… appeared in a relay WebSocket URL'

    # 1. The canary comment and all key material never rode ANY HTTP request.
    for method, url, body in sync.all_bodies:
        assert CANARY not in body, f'config text left the browser via {method} {url}'
        assert 'BEGIN OPENSSH PRIVATE KEY' not in body, f'key material left via {method} {url}'
        assert KEY_PASSPHRASE not in body, f'key passphrase left via {method} {url}'
        assert GOOGLE_TOKEN not in body, f'the Google sign-in left in a body via {method} {url}'
    # 2. Every sync PUT carried exactly the envelope fields — ciphertext only.
    for put in sync.put_bodies:
        assert set(put.keys()) == {'data', 'version'}
        envelope = json.loads(put['data'])
        assert set(envelope.keys()) == {'v', 'kdf', 'iter', 'salt', 'iv', 'ct'}, envelope.keys()
    # 3. What left is decryptable with the passphrase and carries the merged
    #    list — host list AND the roaming key envelope (the key-slot restore
    #    proof: the redial below only works if THIS payload came back).
    final_hosts = json.loads(decrypt_envelope(sync.data['main'], SYNC_PASSPHRASE))['hosts']
    assert [h['name'] for h in final_hosts] == ['manualbox', 'dockertest', 'keylesstest', 'gwbox'], final_hosts
    assert final_hosts[1]['identityFile'] == '~/.ssh/key_enc'
    keys_payload = json.loads(decrypt_envelope(sync.data['keys'], SYNC_PASSPHRASE))['secrets']
    for name in ('manualbox', 'dockertest', 'gwbox'):
        assert name in keys_payload and keys_payload[name], f'{name} missing from the keys envelope'
    key_enc_body = open(os.path.join(WORK, 'key_enc')).read()
    restored_pem = keys_payload['dockertest'].get('privateKeyPem', '')
    assert 'OPENSSH PRIVATE KEY' in restored_pem, 'dockertest key envelope entry is not a private key'
    assert restored_pem.strip() == key_enc_body.strip(), 'dockertest key not restored verbatim'
    assert keys_payload['dockertest'].get('keyPassphrase') == KEY_PASSPHRASE
    # 4. Browser-direct custody + REAL sessions: exactly three dials, each a
    #    real SSH session the fixture accepted (navigation only happened
    #    after ssh2's `ready`), every byte and text frame custody-scanned.
    assert relay.dials == 3, f'expected exactly the three successful direct dials, saw {relay.dials}'
    assert all(
        len(p.relayed) > 0 and len(p.from_server) > 0 for p in relay.pipes
    ), 'a relay pipe saw no real SSH traffic'
    # 5. Gateway dial: exactly one, admitted by the broker exchange, carrying
    #    ONLY the scoped routing token in its auth frame — the Google sign-in
    #    appears on no gateway surface (already asserted globally, restated at
    #    the frame level), and a real SSH session ran behind `ready`.
    assert gateway.dials == 1, f'expected exactly one gateway dial, saw {gateway.dials}'
    assert any('/api/v1/hosts/dev-e2e/ssh' in u for u in gateway.urls), gateway.urls
    assert len(gateway.auth_frames) == 1 and gateway.auth_frames[0].get('type') == 'auth', gateway.auth_frames
    assert gateway.auth_frames[0]['token'] == GW_TOKEN, 'auth frame did not carry the broker-scoped token'
    assert gateway.ready_sent == 1
    assert gateway.text_after_ready == [], f'text frames after ready: {gateway.text_after_ready}'
    assert all(
        len(p.relayed) > 0 and len(p.from_server) > 0 for p in gateway.pipes
    ), 'the gateway pipe saw no real SSH traffic'
    assert len(console_errors) == 0, console_errors

    print('E2E PASS: import + key + selection + OSC 52 + gateway verified against the real sshd fixture')
    print(
        f'  sync PUTs: {len(sync.put_bodies)} envelopes; direct dials: {relay.dials}'
        f' (browser-direct, custody-scanned: binary + text + URLs);'
        f' gateway dials: {gateway.dials} (protocol fixture, real sshd behind it)'
    )
    return 0


if __name__ == '__main__':
    try:
        code = asyncio.run(main())
    except BaseException:
        if PAGE is not None:
            asyncio.run(dump_diagnostics())
        raise
    raise SystemExit(code)
