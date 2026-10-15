"""End-to-end: key vault + config import + connect, against the real docker sshd.

Drives the built app in Chromium with two network fakes, everything else
real (see run-e2e.sh):

  /config.js + GIS    stubbed exactly like .tmp/auth-review-capture.py does
                      for visual captures — a fake button that signs in via
                      the app's own callback.
  sync.e2e.test       a fake settings store, per slot, with the real API's
                      versioning: it records every body and only ever
                      accepts/re-serves opaque data. The test decrypts the
                      host-list envelope with the passphrase (cryptography is
                      a test-side dependency) and checks the vault slots are
                      ciphertext-shaped.

The SSH hop is real: the browser dials through the dumb dev relay to the
pocketshell-test:ssh container, so the key sshd accepts (its VERBOSE log
names the fingerprint) is the one the vault decrypted in the tab, including
a passphrase-protected key that is stored decrypted inside the vault.

Usage: /usr/bin/python3 tests/e2e/e2e_hosts_keys.py <base-url> <workdir> <fixture-port> <relay-port> <container>
"""

import asyncio
import base64
import json
import os
import sys
import time

import subprocess
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/')
WORK = sys.argv[2]
FIXTURE_PORT = int(sys.argv[3])
RELAY_PORT = int(sys.argv[4])
CONTAINER = sys.argv[5]

VAULT_PASSPHRASE = 'e2e-vault-pass-entence'
KEY_PASSPHRASE = 'e2e-key-passphrase'
CANARY = 'e2e-canary-7f3k4m'


CONFIG_STUB = (
    "window.POCKETSHELL_WEB = { syncApiUrl: 'https://sync.e2e.test', "
    "googleClientId: 'stub.apps.googleusercontent.com', wsUrl: '', "
    f"directWsUrl: 'ws://127.0.0.1:{RELAY_PORT}' }};"
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
    return f"{b64url({'alg': 'none'})}.{b64url({'sub': 'e2e', 'email': 'e2e@pocketshell.test', 'exp': 4102444800})}.x"


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
    """The settings API as the real one behaves, per slot: opaque data in,
    same out, versioned, 409 on a stale base, 404 when absent. The phase-2
    /vault/* routes are absent (404), as before their deploy."""

    def __init__(self):
        self.slots: dict[str, dict] = {}
        self.put_bodies: list[tuple[str, dict]] = []
        self.all_bodies: list[tuple[str, str, str]] = []

    @property
    def data(self) -> str | None:
        main = self.slots.get('main')
        return main['data'] if main else None

    async def handle(self, route):
        req = route.request
        body = req.post_data or ''
        self.all_bodies.append((req.method, req.url, body))
        path = req.url.split('sync.e2e.test', 1)[1].split('?', 1)[0]
        if path.startswith('/settings/'):
            slot = path[len('/settings/'):]
            cur = self.slots.get(slot)
            if req.method == 'GET':
                if cur is None:
                    await route.fulfill(status=404, content_type='application/json', body='{"message":"no slot"}')
                else:
                    await route.fulfill(content_type='application/json', body=json.dumps({'slot': slot, **cur}))
            elif req.method == 'PUT':
                parsed = json.loads(body)
                have = cur['version'] if cur else 0
                if parsed['version'] != have:
                    await route.fulfill(status=409, content_type='application/json', body=json.dumps({'currentVersion': have}))
                    return
                self.put_bodies.append((slot, parsed))
                self.slots[slot] = {'version': have + 1, 'data': parsed['data']}
                await route.fulfill(content_type='application/json', body=json.dumps({'version': have + 1}))
            elif req.method == 'DELETE':
                self.slots.pop(slot, None)
                await route.fulfill(status=204, body='')
            else:
                await route.fulfill(status=405, body='')
        elif req.method == 'GET' and path == '/settings':
            rows = [{'slot': k, 'version': v['version'], 'size': len(v['data']), 'updatedAt': ''} for k, v in self.slots.items()]
            await route.fulfill(content_type='application/json', body=json.dumps(rows))
        elif req.method == 'GET' and path == '/me':
            await route.fulfill(content_type='application/json', body='{"sub":"e2e","email":"e2e@pocketshell.test"}')
        else:
            await route.fulfill(status=404, content_type='application/json', body='{"message":"Not Found"}')


def fingerprint_of(private_key_path: str) -> str:
    """SHA256:… of a key, as sshd's VERBOSE log prints it."""
    pub = subprocess.run(['ssh-keygen', '-y', '-P', KEY_PASSPHRASE if private_key_path.endswith('key_enc') else '', '-f', private_key_path],
                         check=True, capture_output=True, text=True).stdout
    out = subprocess.run(['ssh-keygen', '-l', '-E', 'sha256', '-f', '-'], input=pub, check=True, capture_output=True, text=True).stdout
    return out.split()[1]


def sshd_accepted(fingerprint: str) -> bool:
    logs = subprocess.run(['docker', 'logs', CONTAINER], capture_output=True, text=True)
    return any('Accepted publickey for testuser' in line and fingerprint in line
               for line in (logs.stdout + logs.stderr).splitlines())


async def wait_for(predicate, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.2)
    raise AssertionError(f'timed out waiting for {what}')


async def main() -> int:
    sync = FakeSync()
    console_errors: list[str] = []
    relay_frames: list[str] = []
    plain_fp = fingerprint_of(os.path.join(WORK, 'key_plain'))
    enc_fp = fingerprint_of(os.path.join(WORK, 'key_enc'))

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={'width': 1280, 'height': 800})
        page = await context.new_page()
        page.on(
            'console',
            # Resource 404s from the fake API are the protocol working
            # (first pull is a legitimate 404); anything else is a bug.
            lambda m: console_errors.append(m.text)
            if m.type == 'error' and 'Failed to load resource' not in m.text
            else None,
        )

        def watch(ws):
            ws.on('framesent', lambda f: relay_frames.append(f if isinstance(f, str) else str(f)))
            ws.on('framereceived', lambda f: relay_frames.append(f if isinstance(f, str) else str(f)))
        page.on('websocket', watch)
        await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=CONFIG_STUB))
        await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=GIS_STUB))
        await page.route('**/sync.e2e.test/**', sync.handle)

        async def back_to_hosts():
            await page.goto(BASE + '/app', wait_until='networkidle')
            await page.wait_for_selector('button:has-text("Import config")', timeout=30000)

        # --- sign in, create the vault (empty account) ----------------------
        await page.goto(BASE + '/', wait_until='networkidle')
        await page.evaluate(f"window.__gsiInit.callback({{credential: '{fake_jwt()}'}})")
        # The home is the shared picker now; host preparation lives at /app.
        await page.wait_for_function("!location.pathname.startsWith('/login')")
        await page.goto(BASE + '/app', wait_until='networkidle')
        # A brand-new account: create the vault (its passphrase also encrypts
        # the host list), remembered on this device so the full page loads
        # below reopen it silently.
        await page.wait_for_selector('text=Create your vault passphrase')
        await page.fill('#setup-new', VAULT_PASSPHRASE)
        await page.fill('#setup-again', VAULT_PASSPHRASE)
        await page.check('text=I understand that a forgotten passphrase')
        await page.check('input[name="setup-remember"][value="remember"]')
        await page.click('button:has-text("Create vault")')
        await page.wait_for_selector('text=No hosts synced yet', timeout=30000)

        # --- manual host + key file upload into the vault ---------------------
        await page.click('button:has-text("Add host")')
        await page.fill('input[placeholder="Name (e.g. prod-box)"]', 'manualbox')
        await page.fill('input[placeholder="Hostname"]', '127.0.0.1')
        await page.fill('input[placeholder="Port"]', str(FIXTURE_PORT))
        await page.fill('input[placeholder="User (optional)"]', 'testuser')
        await page.click('button:has-text("Save")')
        await page.wait_for_selector('text=Saved manualbox')

        await page.locator('.host-row', has_text='manualbox').get_by_role('button', name='Key…').click()
        box = page.locator('details.keybox', has_text='Key for manualbox')
        await page.set_input_files('input[aria-label="Private key file"]', os.path.join(WORK, 'key_plain'))
        await box.get_by_role('button', name='Add to vault').click()
        await box.locator('#kf-entry').wait_for()
        await box.get_by_role('button', name='Save').click()
        await page.wait_for_selector('text=Saved the vault key choice for manualbox')
        # Nothing about the key may sit in browser storage.
        storage = await page.evaluate("JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage))")
        assert 'BEGIN' not in storage and KEY_PASSPHRASE not in storage and VAULT_PASSPHRASE not in storage, 'plaintext in web storage!'

        # --- connect: the browser dials sshd with the vault key -------------
        await page.locator('.host-row', has_text='manualbox').get_by_role('button', name='Connect').click()
        await wait_for(lambda: sshd_accepted(plain_fp), 60, 'sshd accepting the uploaded vault key')
        await back_to_hosts()

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
        box = page.locator('details.keybox', has_text='Key for dockertest')
        await box.get_by_role('tab', name='Upload a key').click()
        await page.set_input_files('input[aria-label="Private key file"]', os.path.join(WORK, 'key_enc'))
        await box.get_by_role('button', name='Add to vault').click()
        # Encrypted: its own passphrase is asked once; the vault keeps it decrypted.
        await box.locator('#kf-kpass').fill(KEY_PASSPHRASE)
        await box.get_by_role('button', name='Add to vault').click()
        await box.locator('#kf-entry').wait_for()
        await box.get_by_role('button', name='Save').click()
        # Saving the one key re-opens the credentials step for the host that
        # still lacks one; Done leaves the flow.
        await page.wait_for_selector('button:has-text("Done for now")')
        assert 'keylesstest' in await page.locator('.import-list').inner_text()
        assert 'dockertest' not in await page.locator('.import-list').inner_text()
        await page.click('button:has-text("Done for now")')
        await page.wait_for_selector('text=Imported 2 hosts')

        # A host without a vault key refuses to connect (client-side guard).
        await page.locator('.host-row', has_text='keylesstest').get_by_role('button', name='Connect').click()
        try:
            await page.wait_for_selector('text=No vault key is assigned to this host yet')
        except Exception:
            await page.screenshot(path=os.path.join(WORK, 'keyless.png'), full_page=True)
            body = await page.evaluate('document.body.innerText')
            raise AssertionError(f'keyless connect: no vault-key refusal shown; page text: {body[:1500]}')
        await back_to_hosts()

        # --- connect the imported host: no key passphrase needed any more ---
        await page.locator('.host-row', has_text='dockertest').get_by_role('button', name='Connect').click()
        await wait_for(lambda: sshd_accepted(enc_fp), 60, 'sshd accepting the decrypted vault copy of the encrypted key')
        await back_to_hosts()

        # --- forget the device: the typed unlock opens keys AND hosts --------
        await page.evaluate("localStorage.removeItem('ps.vaultDek.e2e')")
        await page.goto(BASE + '/app', wait_until='networkidle')
        await page.wait_for_selector('text=Unlock your vault')
        await page.fill('#hv-pass', VAULT_PASSPHRASE)
        await page.click('button.primary:has-text("Unlock")')
        await page.wait_for_selector('.host-row', timeout=30000)
        names = await page.locator('.host-row .name').all_inner_texts()
        assert sorted(names) == ['dockertest', 'keylesstest', 'manualbox'], names
        await context.close()
        await browser.close()

    # --- wire-level assertions ----------------------------------------------
    # 1. The canary comment and all key material never rode ANY HTTP request.
    for method, url, body in sync.all_bodies:
        assert CANARY not in body, f'config text left the browser via {method} {url}'
        assert 'PRIVATE KEY' not in body, f'key material left via {method} {url}'
        assert KEY_PASSPHRASE not in body, f'key passphrase left via {method} {url}'
        assert VAULT_PASSPHRASE not in body, f'vault passphrase left via {method} {url}'
    # 2. Every sync PUT carried ciphertext only: the host list envelope, the
    #    vault header, or a sealed key blob.
    for slot, put in sync.put_bodies:
        assert set(put.keys()) == {'data', 'version'}
        doc = json.loads(put['data'])
        if slot == 'main':
            assert set(doc.keys()) == {'v', 'kdf', 'iter', 'salt', 'iv', 'ct'}, doc.keys()
        elif slot == 'vault':
            assert {'v', 'vaultId', 'kdf', 'wrappedDek', 'check', 'index', 'epoch'} <= set(doc.keys()), doc.keys()
            assert doc['kdf']['alg'] == 'argon2id'
        else:
            assert slot.startswith('vk-'), slot
            assert {'v', 'vaultId', 'keyId', 'n', 'ct'} <= set(doc.keys()), doc.keys()
    assert sum(1 for k in sync.slots if k.startswith('vk-')) == 2, sync.slots.keys()
    # 3. What left is decryptable with the passphrase and carries the merged list.
    final_hosts = json.loads(decrypt_envelope(sync.data, VAULT_PASSPHRASE))['hosts']
    assert [h['name'] for h in final_hosts] == ['manualbox', 'dockertest', 'keylesstest'], final_hosts
    assert final_hosts[1]['identityFile'] == '~/.ssh/key_enc'
    # 4. The relay only ever ferried ciphertext.
    assert relay_frames, 'no relay frames observed'
    for frame in relay_frames:
        assert 'PRIVATE KEY' not in frame and CANARY not in frame, 'plaintext on the relay wire'
    assert len(console_errors) == 0, console_errors

    print('E2E PASS: vault setup + remember + import + vault keys (incl. a decrypted encrypted key) + vault unlock verified against the real sshd fixture')
    print(f"  sync PUTs: {len(sync.put_bodies)}; vault slots: {sorted(k for k in sync.slots if k != 'main')}; relay frames: {len(relay_frames)}")
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
