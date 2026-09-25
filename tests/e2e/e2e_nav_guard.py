"""End-to-end: the beforeunload nav guard (src/platform/navGuard.ts).

The browser's Ctrl+W is a reserved chord — the page cannot intercept it, so
the guard's whole job is to turn a tab close (via that chord, a reload, or
the close button) into the browser's own leave dialog while a workspace is
open, and to stay quiet while the app sits at the host picker. Nothing stubs
the dialog: Chromium raises it for real against the built dist, and this
script asserts on the dialog event Playwright receives.

Two pages, one browser context:
  page A — sign-in fakes, stops at the shared picker (connection state
           'idle'): closing the tab must NOT raise the dialog.
  page B — adds a host whose TCP target is a SILENT fixture (this script's
           own asyncio listener behind the dev relay: it accepts the
           connection and never sends an SSH banner, so the dial holds in
           'connecting' — the browser-side ssh2 client sits waiting for a
           version string that never comes): closing the tab MUST raise the
           dialog, type 'beforeunload'.

Usage: /usr/bin/python3 tests/e2e/e2e_nav_guard.py <base-url> <workdir> <silent-port> <relay-port>
"""

import asyncio
import base64
import json
import sys
import time

from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/')
SILENT_PORT = int(sys.argv[3])
RELAY_PORT = int(sys.argv[4])
KEY_PATH = sys.argv[5]
KEY_PASSPHRASE = ' '

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
    # `sub` is mandatory here: the passphrase vault is keyed by it, and a
    # sub-less token makes `ensureHostsUnlocked`'s memo check match its
    # unassigned null (undefined === undefined) and crash. Real Google
    # id_tokens always carry sub; the fake has to honour that contract.
    return f"{b64url({'alg': 'none'})}.{b64url({'sub': 'e2e-user', 'email': 'e2e@pocketshell.test', 'exp': 4102444800})}.x"


class FakeSync:
    """Opaque data in, same out — the account's slots each take an envelope
    and hand it back. Nothing here matters to the guard; the stub only keeps
    the sync client from erroring the page."""

    def __init__(self):
        self.version: dict[str, int] = {}
        self.data: dict[str, str | None] = {}

    async def handle(self, route):
        req = route.request
        if req.method == 'GET' and '/settings/' in req.url:
            slot = req.url.rsplit('/settings/', 1)[1]
            if self.data.get(slot) is None:
                await route.fulfill(status=404, content_type='application/json', body='')
            else:
                await route.fulfill(
                    content_type='application/json',
                    body=json.dumps({'slot': slot, 'version': self.version[slot], 'data': self.data[slot]}),
                )
        elif req.method == 'PUT' and '/settings/' in req.url:
            slot = req.url.rsplit('/settings/', 1)[1]
            parsed = json.loads(req.post_data or '{}')
            self.data[slot] = parsed.get('data')
            self.version[slot] = self.version.get(slot, 0) + 1
            await route.fulfill(content_type='application/json', body=json.dumps({'version': self.version[slot]}))
        elif req.method == 'GET' and req.url.endswith('/me'):
            await route.fulfill(content_type='application/json', body='{"sub":"e2e","email":"e2e@pocketshell.test"}')
        else:
            await route.fulfill(status=404, content_type='application/json', body='{}')


async def stub_page(page, sync: FakeSync) -> None:
    await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=CONFIG_STUB))
    await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=GIS_STUB))
    await page.route('**/sync.e2e.test/**', sync.handle)


async def silent_fixture(port: int):
    """Accept TCP and say nothing: the SSH client's banner wait is the timer
    that holds the connection store in 'connecting' while the tab closes."""
    async def hold(reader, writer):
        try:
            await asyncio.sleep(120)
        finally:
            writer.close()
    return await asyncio.start_server(hold, '127.0.0.1', port)


async def main() -> int:
    sync = FakeSync()
    fixture = await silent_fixture(SILENT_PORT)

    failures: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={'width': 1280, 'height': 800})

        async def signed_in_page(dialogs: list[str]):
            page = await context.new_page()
            # Record every dialog and accept it (accept = leave) so a close
            # can complete; the ASSERTIONS decide whether a dialog belonged
            # on this page at all.
            page.on('dialog', lambda d: (dialogs.append(f'{d.type}: {d.message}'), asyncio.ensure_future(d.accept())))
            await stub_page(page, sync)
            await page.goto(BASE + '/', wait_until='networkidle')
            await page.evaluate(f"window.__gsiInit.callback({{credential: '{fake_jwt()}'}})")
            await page.wait_for_selector('.picker header', timeout=20_000)
            return page

        # --- page A: idle at the picker. Closing is free. -------------------
        dialogs_a: list[str] = []
        page_a = await signed_in_page(dialogs_a)
        await page_a.close(run_before_unload=True)
        if dialogs_a:
            failures.append(f'idle picker raised a leave dialog: {dialogs_a}')

        # --- page B: a dial in flight. Closing must ask. --------------------
        dialogs_b: list[str] = []
        page_b = await signed_in_page(dialogs_b)
        console_b: list[str] = []
        page_b.on('console', lambda m: console_b.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
        page_b.on('pageerror', lambda e: console_b.append(f'pageerror: {e}'))
        # The web's own host surface still owns add-host (the shared picker
        # owns CONNECTING).
        await page_b.goto(BASE + '/app', wait_until='networkidle')

        async def dump(where: str) -> str:
            keys = await page_b.evaluate("() => Object.keys(localStorage)")
            return json.dumps({'where': where, 'url': page_b.url, 'console': console_b[-8:], 'ls': keys, 'body': (await page_b.locator('body').inner_text())[:400]}, indent=1)

        # The host surface sits behind the sync unlock (fresh context, fresh
        # browser-held key). Any passphrase works: the account's slots are
        # empty fakes, so this provisions a brand-new one.
        try:
            await page_b.wait_for_selector('button:has-text("Add host"), input[type=password]', timeout=10_000)
            if await page_b.locator('input[type=password]').count():
                await page_b.fill('input[type=password]', 'e2e-sync-pass-entence')
                # Vault the passphrase: the picker runs in a SECOND page load,
                # and only the vault survives that.
                await page_b.locator('.unlock-remember input[type=checkbox]').check()
                await page_b.click('button:has-text("Unlock")')
        except Exception:
            print('FAIL: /app never showed the unlock card or the host surface:', await dump('/app after load'))
            return 1
        try:
            await page_b.wait_for_selector('button:has-text("Add host")', timeout=15_000)
        except Exception:
            print('FAIL: /app never showed the host surface after unlock:', await dump('/app after unlock'))
            return 1
        await page_b.click('button:has-text("Add host")')
        await page_b.fill('input[placeholder="Name (e.g. prod-box)"]', 'guardbox')
        await page_b.fill('input[placeholder="Hostname"]', '127.0.0.1')
        await page_b.fill('input[placeholder="Port"]', str(SILENT_PORT))
        await page_b.fill('input[placeholder="User (optional)"]', 'testuser')
        await page_b.click('button:has-text("Save")')
        try:
            await page_b.wait_for_selector('text=Saved guardbox', timeout=15_000)
        except Exception:
            print('FAIL: host save did not confirm:', await dump('after Save'))
            return 1

        # The picker refuses to dial a keyless host — attach the key while
        # still on the hosts screen.
        await page_b.locator('.host-row', has_text='guardbox').get_by_role('button', name='Key…').click()
        await page_b.set_input_files('input[aria-label="Private key file"]', KEY_PATH)
        await page_b.fill('input[aria-label="Key passphrase"]', KEY_PASSPHRASE)
        await page_b.locator('details.keybox', has_text='Private key for guardbox').get_by_role('button', name='Save').click()
        try:
            await page_b.wait_for_selector('text=Key for guardbox stored encrypted', timeout=15_000)
        except Exception:
            print('FAIL: key save did not confirm:', await dump('after key Save'))
            return 1

        await page_b.goto(BASE + '/', wait_until='networkidle')
        console_b.clear()
        # Mount-time load failed? Try the picker's own reload before judging:
        # a reload that succeeds means a boot race, not a broken read.
        try:
            await page_b.locator('button[aria-label="Reload hosts"]').click(timeout=3_000)
            await page_b.wait_for_timeout(2_000)
        except Exception:
            pass
        row = page_b.locator('.host-row', has_text='guardbox')
        try:
            await row.wait_for(state='visible', timeout=15_000)
            await row.click()
            await page_b.wait_for_selector('.auto-banner', timeout=15_000)
            banner = (await page_b.locator('.auto-banner').inner_text()).strip()
            if 'Connecting to' not in banner:
                print('FAIL: banner does not show a dial in flight:', repr(banner))
                return 1
        except Exception as e:
            print('FAIL: could not start the dial:', e, await dump('picker with guardbox'))
            return 1

        await page_b.close(run_before_unload=True)
        deadline = time.monotonic() + 10
        while not dialogs_b and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        if not dialogs_b:
            failures.append('closing a dial in flight raised NO leave dialog')
        elif not any(t.startswith('beforeunload') for t in dialogs_b):
            failures.append(f'expected a beforeunload dialog, got: {dialogs_b}')

        await browser.close()
    fixture.close()

    if failures:
        for f in failures:
            print(f'FAIL: {f}')
        return 1
    print('PASS: idle close stays silent; a dial in flight raises the beforeunload dialog')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
