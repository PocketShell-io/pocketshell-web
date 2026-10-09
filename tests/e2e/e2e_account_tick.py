"""End-to-end: the shared sync tick rule on the web's /account (pocketshell#3072).

The web's local host list is the synced account itself, so EVERY account host
overlaps a local one — exactly the case the old shared rule skipped: the page
showed "In account · remove on sync" on every host the user had not ticked by
hand, and an untouched Sync now cut the account down to the ticked ones.

Flow, in real Chromium against the built dist:
  sign in (GIS stub) → /app unlock (passphrase remembered) → /account:
    every host reads "In account", ticked, no "remove on sync"   [shot 1]
  Sync now, untouched → the account (decrypted here) still holds all three [shot 2]
  untick `fixture` → its row reads "In account · remove on sync"  [shot 3]
  Sync now → the account holds hetzner and nas                     [shot 4]

Faked: Google sign-in and the sync API (slots in memory). The envelopes are
real: the seed is encrypted here with the web's own envelope format and every
upload is decrypted here to read what the account holds.

Usage: /usr/bin/python3 tests/e2e/e2e_account_tick.py <base-url> <screenshot-dir>
"""

import asyncio
import base64
import json
import os
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/')
SHOTS = sys.argv[2]
PASSPHRASE = 'e2e-sync-pass-entence'

CONFIG_STUB = (
    "window.POCKETSHELL_WEB = { syncApiUrl: 'https://sync.e2e.test', "
    "googleClientId: 'stub.apps.googleusercontent.com', wsUrl: '', directWsUrl: '' };"
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

ACCOUNT = [
    {'name': 'hetzner', 'hostname': 'hetzner.example.net', 'port': 22, 'user': 'alexey'},
    {'name': 'fixture', 'hostname': 'fixture.other.machine', 'port': 22, 'user': 'alexey'},
    {'name': 'nas', 'hostname': 'nas.example.net', 'port': 22, 'user': 'alexey'},
]


def b64url(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b'=').decode()


def fake_jwt() -> str:
    return f"{b64url({'alg': 'none'})}.{b64url({'sub': 'e2e-user', 'email': 'e2e@pocketshell.test', 'exp': 4102444800})}.x"


def derive(passphrase: str, salt: bytes, iterations: int) -> bytes:
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(passphrase.encode())


def encrypt_envelope(plaintext: str, passphrase: str, iterations: int = 1000) -> str:
    salt, iv = os.urandom(16), os.urandom(12)
    ct = AESGCM(derive(passphrase, salt, iterations)).encrypt(iv, plaintext.encode(), None)
    return json.dumps({'v': 1, 'kdf': 'pbkdf2-sha256', 'iter': iterations,
                       'salt': base64.b64encode(salt).decode(), 'iv': base64.b64encode(iv).decode(),
                       'ct': base64.b64encode(ct).decode()})


def decrypt_envelope(envelope: str, passphrase: str) -> str:
    f = json.loads(envelope)
    key = derive(passphrase, base64.b64decode(f['salt']), f['iter'])
    return AESGCM(key).decrypt(base64.b64decode(f['iv']), base64.b64decode(f['ct']), None).decode()


class FakeSync:
    """The account API as it behaves: opaque envelopes per slot, versioned, 409 on a stale base."""

    def __init__(self):
        self.version = {'main': 4}
        self.data = {'main': encrypt_envelope(json.dumps({'hosts': ACCOUNT}), PASSPHRASE)}

    def names(self) -> list[str]:
        return [h['name'] for h in json.loads(decrypt_envelope(self.data['main'], PASSPHRASE))['hosts']]

    async def handle(self, route):
        req = route.request
        if '/settings/' in req.url:
            slot = req.url.rsplit('/settings/', 1)[1]
            if req.method == 'GET':
                if self.data.get(slot) is None:
                    await route.fulfill(status=404, content_type='application/json', body='')
                else:
                    await route.fulfill(content_type='application/json', body=json.dumps(
                        {'slot': slot, 'version': self.version[slot], 'data': self.data[slot]}))
                return
            if req.method == 'PUT':
                body = json.loads(req.post_data or '{}')
                current = self.version.get(slot, 0)
                if body.get('version') != current:
                    await route.fulfill(status=409, content_type='application/json',
                                        body=json.dumps({'currentVersion': current}))
                    return
                self.data[slot] = body.get('data')
                self.version[slot] = current + 1
                await route.fulfill(content_type='application/json', body=json.dumps({'version': self.version[slot]}))
                return
        if req.url.endswith('/me'):
            await route.fulfill(content_type='application/json', body='{"sub":"e2e-user","email":"e2e@pocketshell.test"}')
            return
        await route.fulfill(status=404, content_type='application/json', body='{}')


async def main() -> int:
    os.makedirs(SHOTS, exist_ok=True)
    sync = FakeSync()
    failures: list[str] = []

    def check(ok: bool, what: str) -> None:
        print(('PASS: ' if ok else 'FAIL: ') + what)
        if not ok:
            failures.append(what)

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={'width': 760, 'height': 1000})
        page = await context.new_page()
        await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=CONFIG_STUB))
        await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=GIS_STUB))
        await page.route('**/sync.e2e.test/**', sync.handle)

        await page.goto(BASE + '/', wait_until='networkidle')
        await page.evaluate(f"window.__gsiInit.callback({{credential: '{fake_jwt()}'}})")
        await page.goto(BASE + '/app', wait_until='networkidle')
        await page.fill('input[type=password]', PASSPHRASE)
        await page.locator('.unlock-remember input[type=checkbox]').check()
        await page.click('button.primary:has-text("Unlock")')
        await page.wait_for_selector('.host-row:has-text("hetzner")', timeout=20_000)
        # The vault write follows the unlock; /account is a fresh page load
        # whose list comes from the vault's silent unlock.
        await page.wait_for_function("() => localStorage.getItem('ps.passVault.e2e-user') !== null", timeout=20_000)

        await page.goto(BASE + '/account', wait_until='networkidle')
        rows = page.locator('.account-host-row')

        def row(alias: str):
            return rows.filter(has=page.locator('.host-alias', has_text=alias))

        try:
            await row('nas').locator('.status-chip', has_text='In account').wait_for(timeout=20_000)
        except Exception:
            await page.screenshot(path=os.path.join(SHOTS, 'web-FAIL-account.png'), full_page=True)
            print('FAIL: /account never listed nas as "In account":', page.url, (await page.locator('body').inner_text())[:1500])
            return 1
        for alias in ('hetzner', 'fixture', 'nas'):
            chip = (await row(alias).locator('.status-chip').inner_text()).strip()
            check(chip == 'In account', f'{alias} reads "In account" after the account loaded (got {chip!r})')
            check(await row(alias).locator('input[type=checkbox]').is_checked(), f'{alias} is ticked')
        check(await page.get_by_text('remove on sync').count() == 0, 'no row reads "remove on sync"')
        await page.screenshot(path=os.path.join(SHOTS, 'web-1-account-loaded.png'), full_page=True)

        await page.fill('.passphrase-field input', PASSPHRASE)
        await page.get_by_role('button', name='Sync now').click()
        await page.locator('.account-message', has_text='Synced').wait_for(timeout=20_000)
        check(sorted(sync.names()) == ['fixture', 'hetzner', 'nas'], f'untouched Sync now keeps every host (account: {sync.names()})')
        await page.screenshot(path=os.path.join(SHOTS, 'web-2-after-untouched-sync-now.png'), full_page=True)

        await row('fixture').locator('input[type=checkbox]').uncheck()
        chip = (await row('fixture').locator('.status-chip').inner_text()).strip()
        check(chip == 'In account · remove on sync', f'an explicit untick reads "remove on sync" (got {chip!r})')
        await page.screenshot(path=os.path.join(SHOTS, 'web-3-after-explicit-untick.png'), full_page=True)
        await page.get_by_role('button', name='Sync now').click()
        await page.wait_for_function("() => document.querySelector('.account-message')?.textContent.includes('2 hosts')", timeout=20_000)
        check(sorted(sync.names()) == ['hetzner', 'nas'], f'the untick removed fixture (account: {sync.names()})')
        await page.screenshot(path=os.path.join(SHOTS, 'web-4-after-untick-sync-now.png'), full_page=True)
        await browser.close()

    print('RESULT:', 'FAILED' if failures else 'PASSED', f'({len(failures)} failures)')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
