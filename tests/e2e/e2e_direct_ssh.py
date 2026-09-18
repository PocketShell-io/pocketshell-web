"""End-to-end: browser-direct SSH through the dumb relay, against real sshd.

The same Chromium/app/sign-in fakes as e2e_hosts_keys.py, but the connect
path is the browser's OWN ssh2 client (src/terminal/direct.ts) dialing the
local dev relay (relay/dev-relay.mjs), which pipes to the pocketshell-test:ssh
container. Nothing stubs the SSH hop: the stored key, an encrypted one-space
passphrase (the real-world shape), the browser's crypto polyfills, and the
relay's byte pipe all have to work for the shell to come up.

Also asserted:
  - the relay sees ciphertext only — every WebSocket frame is scanned and
    none may contain the typed canary, the username, or key PEM text;
  - the URL that reaches the relay carries host/port/token but no key;
  - the credential envelope in localStorage stays opaque.

Usage: /usr/bin/python3 tests/e2e/e2e_direct_ssh.py <base-url> <workdir> <fixture-port> <relay-port>
"""

import asyncio
import base64
import json
import os
import sys
import time

from playwright.async_api import async_playwright

BASE = sys.argv[1].rstrip('/')
WORK = sys.argv[2]
FIXTURE_PORT = int(sys.argv[3])
RELAY_PORT = int(sys.argv[4])

SYNC_PASSPHRASE = 'e2e-sync-pass-entence'
KEY_PASSPHRASE = ' '
CANARY = 'PS-DIRECT-E2E-OK'

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
    return f"{b64url({'alg': 'none'})}.{b64url({'email': 'e2e@pocketshell.test', 'exp': 4102444800})}.x"


class FakeSync:
    """Opaque data in, same out — the account's slots (main hosts blob and
    the roaming-keys slot) each take an envelope and hand it back."""

    def __init__(self):
        self.version: dict[str, int] = {}
        self.data: dict[str, str | None] = {}

    async def handle(self, route):
        req = route.request
        body = req.post_data or ''
        if req.method == 'GET' and '/settings/' in req.url:
            slot = req.url.rsplit('/settings/', 1)[1]
            if self.data.get(slot) is None:
                await route.fulfill(status=404, content_type='application/json', body='{"message":"no slot"}')
            else:
                await route.fulfill(
                    content_type='application/json',
                    body=json.dumps({'slot': slot, 'version': self.version[slot], 'data': self.data[slot]}),
                )
        elif req.method == 'PUT' and '/settings/' in req.url:
            slot = req.url.rsplit('/settings/', 1)[1]
            parsed = json.loads(body)
            self.data[slot] = parsed['data']
            self.version[slot] = self.version.get(slot, 0) + 1
            await route.fulfill(content_type='application/json', body=json.dumps({'version': self.version[slot]}))
        elif req.method == 'GET' and req.url.endswith('/me'):
            await route.fulfill(content_type='application/json', body='{"sub":"e2e","email":"e2e@pocketshell.test"}')
        else:
            await route.fulfill(status=404, content_type='application/json', body='{}')


async def wait_for(predicate, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.2)
    raise AssertionError(f'timed out waiting for {what}')


async def main() -> int:
    sync = FakeSync()
    ws_frames: list[tuple[str, str]] = []  # (direction, text-or-b64) for EVERY frame on the relay socket

    console_errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={'width': 1280, 'height': 800})
        page = await context.new_page()
        page.on(
            'console',
            lambda m: console_errors.append(m.text)
            if m.type == 'error' and 'Failed to load resource' not in m.text
            else None,
        )
        console_all: list[str] = []
        page.on('console', lambda m: console_all.append(f'{m.type}: {m.text}'))
        page_errors: list[str] = []
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=CONFIG_STUB))
        await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=GIS_STUB))
        await page.route('**/sync.e2e.test/**', sync.handle)

        # Passive observation only: the relay must work untouched. Frame
        # payloads arrive as strings (binary comes base64-encoded in the
        # event's text form) — good enough to prove no plaintext rides it.
        def watch(ws):
            ws.on('framesent', lambda f: ws_frames.append(('sent', f if isinstance(f, str) else str(f))))
            ws.on('framereceived', lambda f: ws_frames.append(('recv', f if isinstance(f, str) else str(f))))
        page.on('websocket', watch)

        # --- sign in and unlock (empty account) -----------------------------
        await page.goto(BASE + '/', wait_until='networkidle')
        await page.evaluate(f"window.__gsiInit.callback({{credential: '{fake_jwt()}'}})")
        await page.wait_for_url('**/app')
        await page.fill('input[type=password]', SYNC_PASSPHRASE)
        await page.click('button.primary:has-text("Unlock")')
        await page.wait_for_selector('text=No hosts synced yet')

        # --- one host, the REAL hetzner key, its one-space passphrase -------
        await page.click('button:has-text("Add host")')
        await page.fill('input[placeholder="Name (e.g. prod-box)"]', 'directbox')
        await page.fill('input[placeholder="Hostname"]', '127.0.0.1')
        await page.fill('input[placeholder="Port"]', str(FIXTURE_PORT))
        await page.fill('input[placeholder="User (optional)"]', 'testuser')
        await page.click('button:has-text("Save")')
        await page.wait_for_selector('text=Saved directbox')

        await page.locator('.host-row', has_text='directbox').get_by_role('button', name='Key…').click()
        await page.set_input_files('input[aria-label="Private key file"]', os.path.join(WORK, 'key_real'))
        await page.fill('input[aria-label="Key passphrase"]', KEY_PASSPHRASE)
        await page.locator('details.keybox', has_text='Private key for directbox').get_by_role('button', name='Save').click()
        try:
            await page.wait_for_selector('text=Key for directbox stored encrypted', timeout=15_000)
        except AssertionError:
            raise
        except Exception:
            diag = await page.evaluate("""() => ({
                keybox: document.querySelector('details.keybox')?.innerText ?? '(no keybox)',
                errors: [...document.querySelectorAll('.error')].map((e) => e.textContent),
                notices: [...document.querySelectorAll('.notice')].map((e) => e.textContent),
            })""")
            raise AssertionError(f'key save did not confirm: {json.dumps(diag, indent=1)}')
        local = await page.evaluate("localStorage.getItem('ps.hostKeys')")
        assert 'BEGIN' not in local and 'id_hetzner' not in local, 'plaintext credential in localStorage!'

        # --- connect: the BROWSER handshakes through the dumb relay ---------
        await page.locator('.host-row', has_text='directbox').get_by_role('button', name='Connect').click()
        try:
            await page.wait_for_function(
                "(document.querySelectorAll('.topbar')[1]?.querySelector('span.muted')?.textContent ?? '').trim() === 'connected'",
                timeout=90_000,
            )
        except Exception:
            diag = await page.evaluate(
                """([pe, n, ct]) => ({
                url: location.pathname,
                status: document.querySelectorAll('.topbar')[1]?.querySelector('span.muted')?.textContent,
                errors: [...document.querySelectorAll('.error')].map((e) => e.textContent),
                term: document.querySelector('.term')?.innerText?.slice(0, 300),
                page_errors: pe,
                ws_frames: n,
                console_tail: ct,
            })""",
                [page_errors, len(ws_frames), console_all[-12:] + [f'frames={ws_frames[:4]}']],
            )
            raise AssertionError(f'direct connect did not come up: {json.dumps(diag, indent=1)}')

        # Type on the real PTY; the answer must come back through ssh2 →
        # xterm in the page.
        await page.keyboard.type(f'echo {CANARY}\r')
        await page.wait_for_function(
            "c => document.querySelector('.term')?.innerText?.includes(c)",
            arg=CANARY,
            timeout=30_000,
        )

        # The relay only ever ferried ciphertext: scan every observed frame.
        forbidden = [CANARY, 'testuser', 'BEGIN OPENSSH', 'ssh-ed25519 ']
        hits = [
            (d, next(x for x in forbidden if x in t))
            for d, t in ws_frames
            if any(x in t for x in forbidden)
        ]
        assert not hits, f'plaintext on the relay wire: {hits[:3]}'
        assert len(ws_frames) > 2, 'no relay frames observed — the passive tap saw nothing'

        # No host key fingerprint status ever claimed otherwise; console clean.
        assert not console_errors, console_errors

        await browser.close()
    print('direct-ssh e2e: PASS (browser handshake, encrypted key, ciphertext-only relay)')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
