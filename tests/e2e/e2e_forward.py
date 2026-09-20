"""End-to-end: the /fwd/ browser-only port forwarder, whole chain.

Same browser/app/sign-in fakes as e2e_direct_ssh.py, then the forward phase:
a real service worker (public/sw.js) intercepts /fwd/<host>:<port>/… in a
second tab, hands each request to the app tab's forwarder, which opens SSH
`direct-tcpip` channels through the dev relay to the REAL sshd fixture, which
dials a far-side HTTP server inside the container. Asserted along the way:
  - the far page renders in the browser through the tunnel (status 200);
  - <base> injection and root-relative rewriting keep links inside /fwd/;
  - the rewritten fetch patch actually reroutes runtime fetch()/XHR paths;
  - POST bodies survive; HEAD resolves; redirects stay in scope; cookies
    from the far side never reach the app origin;
  - reload keeps working (worker already controlling on the second load);
  - unknown host → 404 guidance; dead far port → 502;
  - the relay wire carries ciphertext only — the forwarded canaries must
    not appear in any frame even though the app fetched pages containing
    them through the tunnel.

Usage: /usr/bin/python3 tests/e2e/e2e_forward.py <base-url> <workdir> <fixture-port> <relay-port>
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

FAR_PORT = 8000
DEAD_PORT = 19999
HOST_NAME = 'directbox'

SYNC_PASSPHRASE = 'e2e-sync-pass-entence'
KEY_PASSPHRASE = ' '
CANARY = 'PS-FWD-TERM-OK'

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
    """Opaque data in, same out — the account's slots each take an envelope
    and hand it back."""

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
    ws_frames: list[tuple[str, str]] = []  # every frame on the app tab's relay sockets

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
        page.on('pageerror', lambda e: console_errors.append(f'pageerror: {e}'))
        await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=CONFIG_STUB))
        await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=GIS_STUB))
        await page.route('**/sync.e2e.test/**', sync.handle)

        def watch(ws):
            ws.on('framesent', lambda f: ws_frames.append(('sent', f if isinstance(f, str) else str(f))))
            ws.on('framereceived', lambda f: ws_frames.append(('recv', f if isinstance(f, str) else str(f))))
        page.on('websocket', watch)

        # --- sign in, unlock, one host, the real key ------------------------
        await page.goto(BASE + '/', wait_until='networkidle')
        await page.evaluate(f"window.__gsiInit.callback({{credential: '{fake_jwt()}'}})")
        await page.wait_for_url('**/app')
        await page.fill('input[type=password]', SYNC_PASSPHRASE)
        await page.click('button.primary:has-text("Unlock")')
        await page.wait_for_selector('text=No hosts synced yet')

        await page.click('button:has-text("Add host")')
        await page.fill('input[placeholder="Name (e.g. prod-box)"]', HOST_NAME)
        await page.fill('input[placeholder="Hostname"]', '127.0.0.1')
        await page.fill('input[placeholder="Port"]', str(FIXTURE_PORT))
        await page.fill('input[placeholder="User (optional)"]', 'testuser')
        await page.click('button:has-text("Save")')
        await page.wait_for_selector(f'text=Saved {HOST_NAME}')

        await page.locator('.host-row', has_text=HOST_NAME).get_by_role('button', name='Key…').click()
        await page.set_input_files('input[aria-label="Private key file"]', os.path.join(WORK, 'key_real'))
        await page.fill('input[aria-label="Key passphrase"]', KEY_PASSPHRASE)
        await page.locator('details.keybox', has_text=f'Private key for {HOST_NAME}').get_by_role('button', name='Save').click()
        await page.wait_for_selector(f'text=Key for {HOST_NAME} stored encrypted', timeout=15_000)

        # A live terminal proves the plain SSH chain before /fwd/ rides it.
        await page.locator('.host-row', has_text=HOST_NAME).get_by_role('button', name='Connect').click()
        await page.wait_for_function(
            "(document.querySelectorAll('.topbar')[1]?.querySelector('span.muted')?.textContent ?? '').trim() === 'connected'",
            timeout=90_000,
        )
        # The xterm mounts a tick after the status flips; focus it before typing.
        await page.wait_for_selector('.xterm', timeout=30_000)
        await page.locator('.xterm').first.click()
        await page.keyboard.type(f'echo {CANARY}\r')
        await page.wait_for_function(
            "c => document.querySelector('.xterm-rows')?.innerText?.includes(c)", arg=CANARY, timeout=30_000
        )

        # --- the service worker must be controlling before /fwd/ works -----
        await page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=30_000)

        # --- the forwarded app, in a second tab ----------------------------
        fwd = await context.new_page()
        fwd.on('pageerror', lambda e: console_errors.append(f'fwd pageerror: {e}'))
        url = f'{BASE}/fwd/{HOST_NAME}:{FAR_PORT}/'
        resp = await fwd.goto(url, wait_until='domcontentloaded')
        assert resp is not None and resp.status == 200, f'forwarded page status {resp and resp.status}'
        await fwd.wait_for_selector('text=PS-FWD-OK', timeout=30_000)

        # <base> points into the scope; root-relative links were rewritten.
        base_uri = await fwd.evaluate('document.baseURI')
        assert base_uri.endswith(f'/fwd/{HOST_NAME}:{FAR_PORT}/'), f'baseURI {base_uri}'
        sub_href = await fwd.evaluate("document.querySelector('#sub').getAttribute('href')")
        assert sub_href == f'/fwd/{HOST_NAME}:{FAR_PORT}/sub.html', f'sub link not rewritten: {sub_href}'

        # The runtime fetch patch reroutes a root-relative fetch/XHR path.
        ctype = await fwd.evaluate("fetch('/sub.html').then((r) => r.headers.get('content-type'))")
        assert ctype and ctype.startswith('text/html'), f'fetch content-type {ctype}'
        headers = await fwd.evaluate("fetch('/headers.json').then((r) => r.json())")
        assert 'cookie' not in headers, f'cookies crossed the tunnel: {headers}'
        assert headers.get('connection') == 'close', headers
        assert headers.get('accept-encoding') == 'gzip', headers
        assert headers.get('host') == f'127.0.0.1:{FAR_PORT}', headers
        head_status = await fwd.evaluate("fetch('/sub.html', { method: 'HEAD' }).then((r) => r.status)")
        assert head_status == 200, f'HEAD status {head_status}'
        echoed = await fwd.evaluate("fetch('/echo', { method: 'POST', body: 'ps-e2e-body' }).then((r) => r.text())")
        assert echoed == 'ps-e2e-body', f'POST body mangled: {echoed!r}'
        chunked = await fwd.evaluate("fetch('/chunked').then((r) => r.text())")
        assert chunked == 'forward-end', f'chunked body mangled: {chunked!r}'

        # A far-side redirect is rewritten back into the scope, followed by
        # the BROWSER, and its Set-Cookie never reaches this origin.
        landed = await fwd.evaluate("fetch('/redirect', { redirect: 'follow' }).then((r) => r.text())")
        assert 'PS-FWD-LAND-OK' in landed, f'redirect did not land in scope: {landed!r}'
        far_cookies = [c['name'] for c in await context.cookies(BASE)]
        assert 'far' not in far_cookies, f'far-side cookie leaked: {far_cookies}'

        # Navigation through rewritten links: click-through works and the
        # worker answers each new document from the same SSH connection.
        await fwd.click('#sub')
        await fwd.wait_for_selector('text=PS-FWD-SUB-OK', timeout=30_000)
        await fwd.go_back(wait_until='domcontentloaded')
        await fwd.click('#rel')
        await fwd.wait_for_selector('text=PS-FWD-REL-OK', timeout=30_000)

        # Second full load of the forwarded root: the worker is already
        # controlling, no re-registration dance.
        resp = await fwd.goto(url, wait_until='domcontentloaded')
        assert resp is not None and resp.status == 200, f'reload status {resp and resp.status}'
        await fwd.wait_for_selector('text=PS-FWD-OK', timeout=30_000)

        # Guidance paths: unknown host, and a port nothing listens on.
        resp = await fwd.goto(f'{BASE}/fwd/nosuchhost:{FAR_PORT}/', wait_until='domcontentloaded')
        assert resp is not None and resp.status == 404, f'unknown host status {resp and resp.status}'
        assert 'No host named' in await fwd.inner_text('body')
        resp = await fwd.goto(f'{BASE}/fwd/{HOST_NAME}:{DEAD_PORT}/', wait_until='domcontentloaded')
        assert resp is not None and resp.status == 502, f'dead port status {resp and resp.status}'

        # The app tab is unharmed: still connected through its own session.
        status = await page.evaluate(
            "(document.querySelectorAll('.topbar')[1]?.querySelector('span.muted')?.textContent ?? '').trim()"
        )
        assert status == 'connected', f'app tab status after forward phase: {status}'

        # The relay only ever ferried ciphertext — terminal AND forwarded
        # traffic. The far pages contain canaries; none may appear in frames.
        forbidden = [CANARY, 'PS-FWD-OK', 'PS-FWD-SUB-OK', 'PS-FWD-REL-OK', 'PS-FWD-LAND-OK',
                     'testuser', 'BEGIN OPENSSH', 'ssh-ed25519 ']
        hits = [
            (d, next(x for x in forbidden if x in t))
            for d, t in ws_frames
            if any(x in t for x in forbidden)
        ]
        assert not hits, f'plaintext on the relay wire: {hits[:3]}'
        assert len(ws_frames) > 2, 'no relay frames observed — the passive tap saw nothing'
        assert not console_errors, console_errors

        await browser.close()
    print('forward e2e: PASS (SW shuttle, direct-tcpip tunnel, rewriting, guidance, ciphertext-only)')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
