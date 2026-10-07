"""End-to-end: config import + key upload, against the real docker sshd.

Drives the built app in Chromium with three network fakes, everything else
real (see run-e2e.sh):

  /config.js + GIS    stubbed exactly like .tmp/auth-review-capture.py does
                      for visual captures — a fake button that signs in via
                      the app's own callback.
  sync.e2e.test       a fake settings store: it records every body and only
                      ever accepts/re-serves opaque envelopes. The test then
                      decrypts the captured envelopes with the sync passphrase
                      (cryptography is a test-side dependency, like the
                      desktop app's node:crypto) to prove what LEFT the
                      browser and that it was ciphertext until it left.
  direct.e2e.test      the browser-direct transport, end to end: a dumb
                       WebSocket<->TCP pipe (what relay/ deploys). The
                       browser runs its own ssh2 client and speaks REAL SSH
                       to the pocketshell-test:ssh container through the
                       pipe; nothing about the final hop is stubbed. A wrong
                       key or passphrase fails the handshake and the route
                       never reaches the host workspace, which is the pass
                       marker. Because the pipe is dumb, the test can prove
                       the transport's core property: the private key, its
                       passphrase and the config canary appear in no byte
                       the browser puts on the wire.
                       The old OSC 52 clipboard leg needs a live xterm,
                       which the folder-first workspace redesign moved out
                       of this flow's reach (tests/osc52.test.ts pins the
                       custody; re-wiring it is the named follow-up).

Usage: /usr/bin/python3 tests/e2e/e2e_hosts_keys.py <base-url> <workdir> <fixture-port>
"""

import asyncio
import base64
import json
import os
import sys
import time

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/')
WORK = sys.argv[2]
FIXTURE_PORT = int(sys.argv[3])

SYNC_PASSPHRASE = 'e2e-sync-pass-entence'
KEY_PASSPHRASE = 'e2e-key-passphrase'
CANARY = 'e2e-canary-7f3k4m'

CONFIG_STUB = (
    "window.POCKETSHELL_WEB = { syncApiUrl: 'https://sync.e2e.test', "
    "googleClientId: 'stub.apps.googleusercontent.com', wsUrl: 'wss://bridge.e2e.test/link', "
    "directWsUrl: 'wss://direct.e2e.test/pipe' };"
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


class FakeRelay:
    """The browser-direct transport, end to end: a dumb WebSocket<->TCP pipe
    — exactly what relay/ deploys. The browser runs its own ssh2 client and
    speaks REAL SSH straight at the fixture's sshd; this side only ferries
    opaque bytes between the WebSocket and 127.0.0.1:<fixture-port> and is
    deliberately positioned to PROVE it can never read the credentials: the
    private key, its passphrase and the config canary must appear in no byte
    the browser ever puts on this wire."""

    def __init__(self, fixture_port: int):
        self.fixture_port = fixture_port
        self.dials = 0
        self.pipes: list["_RelayPipe"] = []

    async def handle(self, ws):
        self.dials += 1
        pipe = _RelayPipe(self.fixture_port)
        self.pipes.append(pipe)

        def on_message(payload) -> None:
            if isinstance(payload, str):
                # The SSH transport speaks binary; any text frame is protocol
                # noise worth keeping visible in the custody dump.
                pipe.browser_text.append(payload)
                return
            pipe.relayed += payload
            pipe.to_server(payload)

        ws.on_message(on_message)

        async def pump():
            try:
                await pipe._connect
                while True:
                    chunk = await pipe._reader.read(4096)
                    if not chunk:
                        break
                    pipe.from_server += chunk
                    ws.send(bytes(chunk))
            except (ConnectionError, OSError):
                pass

        pump_task = asyncio.ensure_future(pump())

        def on_close() -> None:
            pipe.close()
            pump_task.cancel()

        ws.on_close(on_close)

    def every_relayed_byte(self) -> bytes:
        return b"".join(p.relayed for p in self.pipes)


class _RelayPipe:
    """One dial: the browser's WebSocket piped to the fixture's TCP sshd."""

    def __init__(self, fixture_port: int):
        self.relayed = b""
        self.browser_text: list[str] = []
        self.from_server = b""
        self._writer = None
        self._reader = None
        self._pending: list[bytes] = []
        self._connect = asyncio.ensure_future(asyncio.open_connection("127.0.0.1", fixture_port))

        def _ready(task):
            self._reader, self._writer = task.result()
            for chunk in self._pending:
                self._writer.write(chunk)
            self._pending.clear()

        self._connect.add_done_callback(_ready)

    def to_server(self, payload: bytes) -> None:
        if self._writer is None:
            # First browser bytes arrive before the TCP dial resolves; park
            # them and flush once it does (the SSH banner waits either way).
            self._pending.append(payload)
            return
        self._writer.write(payload)

    def close(self) -> None:
        if self._writer is not None:
            self._writer.close()


async def wait_for(predicate, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.2)
    raise AssertionError(f'timed out waiting for {what}')


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


async def main() -> int:
    global PAGE
    sync = FakeSync()
    relay = FakeRelay(FIXTURE_PORT)
    console_errors: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        # Clipboard grants let the test both write (OSC 52 handler) and read
        # back what a yank landed in — navigator.clipboard, real Chromium.
        context = await browser.new_context(
            viewport={'width': 1280, 'height': 800},
            permissions=['clipboard-read', 'clipboard-write'],
        )
        page = await context.new_page()
        PAGE = page
        page.on(
            'console',
            # Resource 404s from the fake API are the protocol working
            # (first pull is a legitimate 404); anything else is a bug.
            lambda m: (console_errors.append(m.text), CONSOLE_ERRORS.append(m.text))
            if m.type == 'error' and 'Failed to load resource' not in m.text
            else None,
        )
        await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=CONFIG_STUB))
        await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=GIS_STUB))
        await page.route('**/sync.e2e.test/**', sync.handle)
        await page.route_web_socket('**/direct.e2e.test/**', relay.handle)

        # --- sign in and unlock (empty account) -----------------------------
        await page.goto(BASE + '/', wait_until='networkidle')
        await page.evaluate(f"window.__gsiInit.callback({{credential: '{fake_jwt()}'}})")
        # Sign-in now lands on the shared host picker (route /); host prep —
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

        # --- connect: the browser's own ssh2 dials the REAL container -------
        await page.locator('.host-row', has_text='manualbox').get_by_role('button', name='Connect').click()
        # A successful dial navigates to the host's workspace only after the
        # browser's ssh2 reported `ready` — the real sshd accepted the
        # uploaded key, or the route never moves.
        await page.wait_for_url('**/host/manualbox', timeout=30_000)
        # Back to host prep: a full navigation (a fresh app open, as a user
        # would do it) resets the in-memory stores — so it means unlocking
        # again, and the connection itself was never the unlock's cargo.
        await page.goto(BASE + '/app', wait_until='networkidle')
        await page.fill('input[type=password]', SYNC_PASSPHRASE)
        await page.click('button.primary:has-text("Unlock")')
        await page.wait_for_selector('button:has-text("Import config")')

        # --- import from SSH config -----------------------------------------
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

        # A host without a stored key must refuse to connect (client-side guard):
        # the refusal surfaces in the shared connection store, not as a
        # navigation — nothing dials and no relay socket opens.
        dials_before = relay.dials
        await page.locator('.host-row', has_text='keylesstest').get_by_role('button', name='Connect').click()
        await page.wait_for_timeout(3_000)
        assert relay.dials == dials_before, 'a keyless host must not open a relay socket'
        assert '/host/' not in page.url, 'a refused dial must not navigate to the host'

        # --- connect the imported host: passphrase must travel and work ----
        await page.locator('.host-row', has_text='dockertest').get_by_role('button', name='Connect').click()
        await page.wait_for_url('**/host/dockertest', timeout=30_000)

        # The OSC 52 workspace leg (a live xterm turning a remote yank into
        # a clipboard write) needs the folder-first session flow, which
        # the workspace redesign landed without this harness following. The
        # OSC 52 custody itself stays pinned by tests/osc52.test.ts; re-wiring
        # this leg is the named follow-up.

        # --- reload: everything comes back (account envelope + local one) ---
        await page.reload()
        # The reload lands on the host workspace with fresh stores; route back
        # to host prep and unlock again.
        await page.goto(BASE + '/app', wait_until='networkidle')
        await page.fill('input[type=password]', SYNC_PASSPHRASE)
        await page.click('button.primary:has-text("Unlock")')
        await page.wait_for_selector('.host-row')
        names = await page.locator('.host-row .name').all_inner_texts()
        assert sorted(names) == ['dockertest', 'keylesstest', 'manualbox'], names
        await context.close()
        await browser.close()    # --- wire-level assertions ----------------------------------------------
    # 1. The canary comment and all key material never rode ANY HTTP request.
    for method, url, body in sync.all_bodies:
        assert CANARY not in body, f'config text left the browser via {method} {url}'
        assert 'BEGIN OPENSSH PRIVATE KEY' not in body, f'key material left via {method} {url}'
        assert KEY_PASSPHRASE not in body, f'key passphrase left via {method} {url}'
    # 2. Every sync PUT carried exactly the envelope fields — ciphertext only.
    for put in sync.put_bodies:
        assert set(put.keys()) == {'data', 'version'}
        envelope = json.loads(put['data'])
        assert set(envelope.keys()) == {'v', 'kdf', 'iter', 'salt', 'iv', 'ct'}, envelope.keys()
    # 3. What left is decryptable with the passphrase and carries the merged list.
    final_hosts = json.loads(decrypt_envelope(sync.data['main'], SYNC_PASSPHRASE))['hosts']
    assert [h['name'] for h in final_hosts] == ['manualbox', 'dockertest', 'keylesstest'], final_hosts
    assert final_hosts[1]['identityFile'] == '~/.ssh/key_enc'
    # 4. Browser-direct custody: the relay is a dumb byte pipe, and the two
    #    successful dials each carried a REAL SSH session the fixture's sshd
    #    accepted (each navigation only happened after ssh2's `ready`). The
    #    private key, its passphrase and the config canary appear in NO byte
    #    the browser ever put on the wire — the browser-direct property the
    #    old bridge's connect frame could never claim.
    assert relay.dials == 2, f'expected exactly the two successful dials, saw {relay.dials}'
    relayed = relay.every_relayed_byte()
    assert b'BEGIN OPENSSH PRIVATE KEY' not in relayed, 'private key bytes reached the relay wire'
    assert KEY_PASSPHRASE.encode() not in relayed, 'key passphrase reached the relay wire'
    assert CANARY.encode() not in relayed, 'config canary reached the relay wire'
    assert all(
        len(p.relayed) > 0 and len(p.from_server) > 0 for p in relay.pipes
    ), 'a relay pipe saw no real SSH traffic'
    assert len(console_errors) == 0, console_errors

    print('E2E PASS: import + key + passphrase verified against the real sshd fixture')
    print(f"  sync PUTs: {len(sync.put_bodies)} envelopes; relay dials: {relay.dials} (browser-direct, custody-scanned)")
    return 0


if __name__ == '__main__':
    try:
        code = asyncio.run(main())
    except BaseException:
        if PAGE is not None:
            asyncio.run(dump_diagnostics())
        raise
    raise SystemExit(code)
