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
  bridge.e2e.test     the bridge PROPER: it takes the `connect` frame's key
                      (and passphrase, when the key is encrypted) and opens a
                      REAL SSH session to the pocketshell-test:ssh container
                      with paramiko. If the browser sent the wrong key or a
                      wrong passphrase, this ssh handshake fails and the test
                      fails — nothing about the final hop is stubbed.

Usage: /usr/bin/python3 tests/e2e/e2e_hosts_keys.py <base-url> <workdir> <fixture-port>
"""

import asyncio
import base64
import json
import os
import stat
import sys
import tempfile
import time

import paramiko
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
    "googleClientId: 'stub.apps.googleusercontent.com', wsUrl: 'wss://bridge.e2e.test/link' };"
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
    """The account slot as the real API behaves: opaque data in, same out."""

    def __init__(self):
        self.version = 0
        self.data: str | None = None
        self.put_bodies: list[dict] = []
        self.all_bodies: list[tuple[str, str, str]] = []

    async def handle(self, route):
        req = route.request
        body = req.post_data or ''
        self.all_bodies.append((req.method, req.url, body))
        if req.method == 'GET' and req.url.endswith('/settings/main'):
            if self.data is None:
                await route.fulfill(status=404, content_type='application/json', body='{"message":"no slot"}')
            else:
                await route.fulfill(
                    content_type='application/json',
                    body=json.dumps({'slot': 'main', 'version': self.version, 'data': self.data}),
                )
        elif req.method == 'PUT' and req.url.endswith('/settings/main'):
            parsed = json.loads(body)
            assert parsed['version'] == self.version, f'base version {parsed["version"]} != {self.version}'
            self.put_bodies.append(parsed)
            self.data = parsed['data']
            self.version += 1
            await route.fulfill(content_type='application/json', body=json.dumps({'version': self.version}))
        elif req.method == 'GET' and req.url.endswith('/me'):
            await route.fulfill(content_type='application/json', body='{"sub":"e2e","email":"e2e@pocketshell.test"}')
        else:
            await route.fulfill(status=404, content_type='application/json', body='{}')


class FakeBridge:
    """Takes the connect frame's credentials at face value and really dials."""

    def __init__(self, fixture_port: int):
        self.fixture_port = fixture_port
        self.connect_frames: list[dict] = []
        self.ws_data_frames = 0
        self.ssh_outputs: dict[str, str] = {}
        self.ssh_errors: dict[str, str] = {}

    async def handle(self, ws):
        async def run_ssh(frame: dict, tag: str):
            def blocking():
                auth = frame['auth']
                fd, path = tempfile.mkstemp(suffix='.pem')
                with os.fdopen(fd, 'w') as f:
                    f.write(auth['privateKey'])
                os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
                try:
                    client = paramiko.SSHClient()
                    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                    client.connect(
                        '127.0.0.1',
                        port=self.fixture_port,
                        username=frame['username'],
                        key_filename=path,
                        passphrase=auth.get('passphrase'),
                        look_for_keys=False,
                        allow_agent=False,
                        timeout=20,
                        banner_timeout=20,
                    )
                    _, out, err = client.exec_command('echo PS-E2E-$(id -un)-OK')
                    text = out.read().decode() + err.read().decode()
                    client.close()
                    return text, None
                except Exception as e:  # noqa: BLE001 - the test reports it
                    return None, str(e)
                finally:
                    os.unlink(path)

            text, error = await asyncio.to_thread(blocking)
            if text is None:
                self.ssh_errors[tag] = error or 'unknown'
                ws.send(json.dumps({'type': 'error', 'message': 'ssh connect failed'}))
                return
            self.ssh_outputs[tag] = text
            ws.send(json.dumps({'type': 'data', 'data': base64.b64encode(text.encode()).decode()}))

        def on_frame(payload) -> None:
            if not isinstance(payload, str):
                return
            frame = json.loads(payload)
            if frame['type'] == 'connect':
                tag = f"conn{len(self.connect_frames)}"
                frame['_tag'] = tag
                self.connect_frames.append(frame)
                ws.send(json.dumps({'type': 'connected'}))
                asyncio.ensure_future(run_ssh(frame, tag))
            elif frame['type'] == 'ping':
                ws.send(json.dumps({'type': 'pong'}))
            elif frame['type'] == 'data':
                self.ws_data_frames += 1

        ws.on_message(on_frame)


async def wait_for(predicate, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.2)
    raise AssertionError(f'timed out waiting for {what}')


async def main() -> int:
    sync = FakeSync()
    bridge = FakeBridge(FIXTURE_PORT)
    console_errors: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1280, 'height': 800})
        page.on(
            'console',
            # Resource 404s from the fake API are the protocol working
            # (first pull is a legitimate 404); anything else is a bug.
            lambda m: console_errors.append(m.text)
            if m.type == 'error' and 'Failed to load resource' not in m.text
            else None,
        )
        await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=CONFIG_STUB))
        await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=GIS_STUB))
        await page.route('**/sync.e2e.test/**', sync.handle)
        await page.route_web_socket('**/bridge.e2e.test/**', bridge.handle)

        # --- sign in and unlock (empty account) -----------------------------
        await page.goto(BASE + '/', wait_until='networkidle')
        await page.evaluate(f"window.__gsiInit.callback({{credential: '{fake_jwt()}'}})")
        await page.wait_for_url('**/app')
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
        await page.wait_for_selector('text=Key for manualbox stored in this browser.')
        # The credential envelope is in localStorage; it must be opaque.
        local = await page.evaluate("localStorage.getItem('ps.hostKeys')")
        assert 'BEGIN' not in local and KEY_PASSPHRASE not in local, 'plaintext credential in localStorage!'

        # --- connect: the fake bridge dials the REAL container --------------
        await page.locator('.host-row', has_text='manualbox').get_by_role('button', name='Connect').click()
        await wait_for(
            lambda: any('PS-E2E-testuser-OK' in v for v in bridge.ssh_outputs.values()),
            30,
            'ssh session on the fixture using the uploaded key',
        )
        term_status = page.locator('.topbar').nth(1).locator('span.muted')
        await page.wait_for_function("document.querySelectorAll('.topbar')[1]?.querySelector('span.muted')?.textContent === 'connected'")
        assert (await term_status.inner_text()) == 'connected'
        await page.locator('.topbar').nth(1).get_by_role('button', name='← Hosts').click()
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
        await page.wait_for_selector('text=Key for dockertest stored in this browser.')
        # Saving the one key re-opens the credentials step for the host that
        # still lacks one; Done leaves the flow.
        await page.wait_for_selector('button:has-text("Done for now")')
        assert 'keylesstest' in await page.locator('.import-list').inner_text()
        assert 'dockertest' not in await page.locator('.import-list').inner_text()
        await page.click('button:has-text("Done for now")')
        await page.wait_for_selector('text=Imported 2 hosts')

        # A host without a stored key must refuse to connect (client-side guard).
        await page.locator('.host-row', has_text='keylesstest').get_by_role('button', name='Connect').click()
        await page.wait_for_selector('text=No key attached for this host yet')
        await page.locator('.topbar').nth(1).get_by_role('button', name='← Hosts').click()
        await page.wait_for_selector('button:has-text("Import config")')

        # --- connect the imported host: passphrase must travel and work ----
        await page.locator('.host-row', has_text='dockertest').get_by_role('button', name='Connect').click()
        await wait_for(
            lambda: any('PS-E2E-testuser-OK' in v for v in bridge.ssh_outputs.values()) and len(bridge.ssh_outputs) >= 2,
            30,
            'ssh session using the passphrase-protected key',
        )
        await page.wait_for_function("document.querySelectorAll('.topbar')[1]?.querySelector('span.muted')?.textContent === 'connected'")

        # --- reload: everything comes back (account envelope + local one) ---
        await page.reload()
        # The reload lands on /term with a fresh store; the term topbar is
        # rendered even for an unknown host, so route back and unlock again.
        await page.click('button:has-text("← Hosts")')
        await page.fill('input[type=password]', SYNC_PASSPHRASE)
        await page.click('button.primary:has-text("Unlock")')
        await page.wait_for_selector('.host-row')
        names = await page.locator('.host-row .name').all_inner_texts()
        assert sorted(names) == ['dockertest', 'keylesstest', 'manualbox'], names
        await browser.close()

    # --- wire-level assertions ----------------------------------------------
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
    final_hosts = json.loads(decrypt_envelope(sync.data, SYNC_PASSPHRASE))['hosts']
    assert [h['name'] for h in final_hosts] == ['manualbox', 'dockertest', 'keylesstest'], final_hosts
    assert final_hosts[1]['identityFile'] == '~/.ssh/key_enc'
    # 4. The bridge got exactly two connects, each with the right secret, and
    #    both opened real SSH sessions on the fixture.
    assert len(bridge.connect_frames) == 2, bridge.connect_frames
    plain_text = open(os.path.join(WORK, 'key_plain')).read().strip()
    enc_text = open(os.path.join(WORK, 'key_enc')).read().strip()
    first = bridge.connect_frames[0]
    assert first['host'] == '127.0.0.1' and first['port'] == FIXTURE_PORT and first['username'] == 'testuser'
    assert first['auth'] == {'kind': 'key', 'privateKey': plain_text}, 'connect frame 1: unexpected auth'
    second = bridge.connect_frames[1]
    assert second['auth']['privateKey'] == enc_text
    assert second['auth'].get('passphrase') == KEY_PASSPHRASE, 'connect frame 2: passphrase missing'
    assert all('PS-E2E-testuser-OK' in v for v in bridge.ssh_outputs.values()), bridge.ssh_outputs
    assert bridge.ssh_errors == {}, bridge.ssh_errors
    assert len(console_errors) == 0, console_errors

    print('E2E PASS: import + key + passphrase verified against the real sshd fixture')
    print(f"  sync PUTs: {len(sync.put_bodies)} envelopes; ssh sessions: {len(bridge.ssh_outputs)}")
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
