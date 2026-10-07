"""Combined gateway proof — the shipping browser against the REAL Go gateway.

What this harness proves, over REAL production paths end to end:

  - The browser is the ACTUAL production Vite bundle served by vite preview
    (normal UI and runtime config; the real connection.ts / webApi / pin-store
    dial paths — no transport adapters, no test sockets, no fallbacks).
  - The gateway is the Go binary built from the pinned accepted
    pocketshell-gateway source, running its SHIPPING auth posture for the new
    API: registry enabled, the scoped broker JWT verified by the PRODUCTION
    routingauth verifier against the local broker fixture's JWKS. Zero dev-auth
    flags on that instance.
  - The home agent is the real pocketshell-link (enrolled with a broker token
    through the production identity API, running with its loopback sshd).

Legs:
  direct       the browser's browser-direct transport over the SAME Go
               binary's legacy relay endpoint under its DOCUMENTED DEV
               posture (-dev-allow-any-token: the legacy wire carries the
               sign-in in its query — a documented boundary this harness
               pins; no live Google authorizer exists in a lab).
  gw-multi     host keys Ed25519+RSA+ECDSA: enrollment pinned Ed25519 (the
               browser's first-preference algorithm); user key plain
               Ed25519; full PTY + exec + OSC 52 markers. THE definitive
               default multi-key negotiation: exact out-of-band pin.
  gw-reverse   host keys ECDSA+RSA+Ed25519 (reverse order): still Ed25519;
               user key PASSPHRASE-ENCRYPTED Ed25519; PTY marker.
  gw-rsaonly   RSA-only host key: pairs and dials; user key RSA — the sshd
               log's Accepted-publickey line documents the ACTUAL userauth
               signature algorithm the browser negotiated (rsa-sha2-512/256).
  gw-sshrsa    legacy ssh-rsa-ONLY host key: the documented compat tail;
               plain Ed25519 user key.
  gw-edrsa     Ed25519+RSA: plain Ed25519 user key; later re-dialed AFTER
               the gateway's registry record is tampered to advertise a
               WRONG ssh_host_key — the ready advisory must be powerless:
               the out-of-band pin decides, and the dial must still succeed.
  gw-ecdsaonly ECDSA-only host key: enrollment already REFUSED — asserted
               against the orchestrator's OWN fixtures (zero broker requests
               on record, no registry device record, no agent state); no
               device exists here.

Negatives (each with its exact refusal surfaced and zero side effects):
  keyless gateway host        — refused before ANY socket (precondition).
  wrong pairing fingerprint   — a DIFFERENT VALID host key's fp: refused at
                              key exchange, zero userauth on the host, and
                              the gateway's ready advisory had said the RIGHT
                              key — the pin, not the advisory, refused it.
  ECDSA user key              — the shipping guard refuses before any socket.
  broker exchange failure     — the dial fails with NO fallback: no gateway
                              socket, no Google token anywhere on it.
  gateway verifier negatives  — the production routingauth verifier must
                              refuse wrong-issuer / wrong-audience / missing-
                              scope / wrong-scope / expired / garbage /
                              Google-shaped tokens with ONE uniform denial,
                              unknown and revoked devices with the uniform
                              device denial (revocation performed through
                              the production identity API).

Custody: EVERY WebSocket frame the browser puts on ANY transport — binary
AND text, sent AND received — is captured read-only (page.on('websocket')
events; no route interception anywhere) and scanned against the full owned
secret set (three private keys, the key passphrase, the config canary, the
fixture Google sign-in). The final custody pass runs ONCE, after ALL THREE
browser contexts are closed (main, broken-broker, tampered-advisory): every
socket of every store, every late frame, every captured HTTP request of all
three contexts — fail-closed (a failed request capture refuses the run).
The gateway auth frames are additionally pinned to the transport's exact
wire contract (the FIRST frame sent is ONE text auth — exactly
type/v/token/device_id, its device the dialed URL's device; every other
sent frame binary; at most the one ready advisory) and their tokens are
RS256-SIGNATURE-VERIFIED against the fixture broker's OWNED key with the
exact production claim contract — never the Google sign-in. An offline
negative-control suite injects each secret into each surface and must see
the oracle reject it: URL placements, captured HTTP shapes, wire frames,
auth frames, token signatures, the live capture path, the CLEAR-ack
matcher and the zero-auth oracle.

Usage: e2e_gateway_prod.py <base-url> <workdir> <fixtures-json>
"""

import asyncio
import base64
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gateway_fixture_broker import GOOGLE_TOKEN, KEY as BROKER_KEY, load_signing_key  # noqa: E402

from playwright.async_api import async_playwright  # noqa: E402

BASE = sys.argv[1].rstrip('/')
WORK = sys.argv[2]
FIX = json.load(open(sys.argv[3]))

SYNC_PASSPHRASE = 'e2e-sync-pass-entence'
CANARY = 'e2e-canary-gw-7f3k4m'
OSC52_MARKER = 'e2e-osc52-yank-qk9w2m'
CLIPBOARD_SENTINEL = 'pre-yank-clipboard-sentinel'
PTY_MARK = 'pty-live-m4kqz9'

KEY_PASSPHRASE = FIX['keyPassphrase']
GOOGLE_EMAIL = FIX['googleEmail']
BROKER_URL = FIX['brokerUrl']
GATEWAY_URL = FIX['gatewayUrl']
LEGACY_URL = FIX['legacyUrl']
SYNC_URL = FIX['syncUrl']

# The broker fixture's signing key (persisted by the running broker at
# startup) — the harness adopts it so auth-frame tokens can be VERIFIED and
# verifier-negative variants carry the live kid.
load_signing_key(os.path.join(WORK, 'broker-signing-key.pem'))

import gateway_fixture_broker as gateway_broker  # noqa: E402

gateway_broker.ISSUER = BROKER_URL  # tokens minted in-process carry the live issuer

# GW_E2E_OFFLINE_CONTROLS_ONLY=1 runs ONLY the offline controls (no browser,
# no network, no Docker) and exits 0 — the static calibration surface.
OFFLINE_ONLY = os.environ.get('GW_E2E_OFFLINE_CONTROLS_ONLY') == '1'

SECRETS_AS_TEXT = [
    CANARY,
    KEY_PASSPHRASE,
    GOOGLE_TOKEN,
    'BEGIN OPENSSH PRIVATE KEY',
    'BEGIN RSA PRIVATE KEY',
]
SECRETS_AS_BYTES = [s.encode() for s in SECRETS_AS_TEXT]

SECRET_LABELS = [
    (CANARY, 'the config canary'),
    (KEY_PASSPHRASE, 'the key passphrase'),
    (GOOGLE_TOKEN, 'the Google sign-in'),
    ('BEGIN OPENSSH PRIVATE KEY', 'an OpenSSH private-key marker'),
    ('BEGIN RSA PRIVATE KEY', 'an RSA private-key marker'),
]


def _b64_pad(segment: str) -> str:
    return segment + '=' * (-len(segment) % 4)


def safe_url(url: str) -> str:
    """A credential-safe rendering for FAILURE DIAGNOSTICS ONLY: scheme/host
    and the effective port are kept, every path segment, query value and the
    fragment are REPLACED by counts — a rejected URL is named, never echoed
    (the legacy relay's dial URL carries the sign-in in its query). This is
    the prod-harness counterpart of the accepted harness's safe_url."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return '<unparseable url>'
    host = parts.hostname or ''
    port = f':{parts.port}' if parts.port is not None else ''
    path_n = len([s for s in parts.path.split('/') if s])
    names = [n for n, _ in __import__('urllib.parse', fromlist=['parse_qsl']).parse_qsl(parts.query, keep_blank_values=True)]
    extra = f'; query fields: {len(names)} ({", ".join(n[:8] for n in names)})' if names else ''
    frag = '; fragment present' if parts.fragment else ''
    userinfo = '; USERINFO PRESENT' if parts.username is not None else ''
    return f'{parts.scheme}://{host}{port} (path: {path_n} segments{extra}{frag}{userinfo})'


# --- fixture surfaces, as STRUCTURED rules (the accepted URL/header/body
# --- custody policy shape, configured for THIS run's known-owned prod-fixture
# --- variants; nothing is allowlisted by hostname substring, and no surface
# --- outside these rules may carry ANY credential) ---------------------------
#
#   sync + broker (account surfaces)
#       the EXACT https origins the fixture config pins (SYNC_URL /
#       BROKER_URL — scheme, host, effective port), exact supported paths,
#       allowed methods, NO query/fragment/userinfo, and the sign-in ONLY as
#       the exact `Authorization: Bearer <sign-in>`; every header value and
#       every body scanned against the FULL secret set on every request.
#   gateway
#       EXACTLY ws://<GATEWAY_URL netloc>/api/v1/hosts/<known device>/ssh —
#       no query, no fragment, no userinfo, and NONE of the sign-in anywhere
#       (its admission is the broker-scoped routing token, asserted on the
#       auth FRAME and verified against the fixture key).
#   legacy direct relay (documented dev boundary)
#       EXACTLY ws://<LEGACY_URL netloc>/pipe with the live dial's query
#       shape — host/port/token, each exactly once, the sign-in as the ONE
#       token field's value and NOWHERE else in the URL.
#   app origin + GIS stub
#       the preview origin and the stubbed asset paths carry no credential
#       anywhere. ANY other origin is refused — the harness configured every
#       surface this run knows.

ACCOUNT_HTTP_SURFACES = (
    (urlsplit(SYNC_URL), '/me', ('GET',)),
    (urlsplit(SYNC_URL), '/settings', ('GET',)),
    (urlsplit(SYNC_URL), '/settings/main', ('GET', 'PUT', 'DELETE')),
    (urlsplit(SYNC_URL), '/settings/keys', ('GET', 'PUT', 'DELETE')),
    (urlsplit(BROKER_URL), '/gateway/token', ('POST',)),
)
KNOWN_DEVICES = frozenset(m['device'] for m in FIX['modes'].values())  # the run's enrolled gateway devices


def effective_port(parts) -> int:
    return parts.port if parts.port is not None else (443 if parts.scheme in ('https', 'wss') else 80)


def _same_origin(a, b) -> bool:
    return (a.scheme, (a.hostname or '').lower(), effective_port(a)) == (b.scheme, (b.hostname or '').lower(), effective_port(b))


def _scan_material(parts, url: str, legacy: bool) -> list:
    """Every part of the URL that must be credential-free (raw AND
    single-pass decoded), with the ONE legacy exception flagged."""
    from urllib.parse import parse_qsl, unquote

    material = [('the raw URL', url, legacy), ('the host', unquote(parts.hostname or ''), False)]
    if parts.username is not None:
        material.append(('userinfo user', unquote(parts.username), False))
    if parts.password is not None:
        material.append(('userinfo password', unquote(parts.password), False))
    material.append(('the path', unquote(parts.path), False))
    if parts.query:
        material.append(('the query string', unquote(parts.query), legacy))
        for i, (name, value) in enumerate(parse_qsl(parts.query, keep_blank_values=True), 1):
            material.append((f'the value of query field {i} ({name[:8]})', value, legacy and name == 'token'))
            material.append((f'the name of query field {i} ({name[:8]})', name, False))
    if parts.fragment:
        material.append(('the fragment', unquote(parts.fragment), False))
    return material


def assert_url_custody_prod(url: str, where: str) -> None:
    """The ONE URL policy for the live HTTP request URLs and the recorded
    WebSocket dial URLs: EXACT scheme + host + effective-port + path/query
    contracts per surface (a same-host wrong-scheme or wrong-port URL is NOT
    the surface — it refuses); the legacy relay's ONE query-token placement;
    everywhere else the FULL secret set must appear in NO part of the URL,
    raw or decoded."""
    parts = urlsplit(url)
    host = (parts.hostname or '').lower()
    legacy = _same_origin(parts, urlsplit(LEGACY_URL))
    gateway = _same_origin(parts, urlsplit(GATEWAY_URL))
    account = next(((o, p, m) for o, p, m in ACCOUNT_HTTP_SURFACES
                    if (o.hostname or '').lower() == host and effective_port(o) == effective_port(parts)), None)
    app = _same_origin(parts, urlsplit(BASE))

    if legacy:
        # The documented direct relay: EXACTLY /pipe with the dial's three
        # query fields, each exactly once, token = the sign-in.
        from urllib.parse import parse_qsl

        if parts.path != '/pipe':
            raise AssertionError(f'{where}: the legacy relay dial path is not /pipe ({safe_url(url)})')
        fields = parse_qsl(parts.query, keep_blank_values=True)
        names = [n for n, _ in fields]
        if sorted(names) != ['host', 'port', 'token'] or len(names) != 3:
            raise AssertionError(f'{where}: legacy relay query is not exactly host/port/token once each ({safe_url(url)})')
        values = dict(fields)
        if values['token'] != GOOGLE_TOKEN:
            raise AssertionError(f'{where}: the legacy relay token field is not the exact sign-in ({safe_url(url)})')
        if parts.fragment or parts.username is not None:
            raise AssertionError(f'{where}: legacy relay URL carries fragment/userinfo ({safe_url(url)})')
    elif gateway:
        ok_path = any(
            parts.path == f'/api/v1/hosts/{d}/ssh' for d in KNOWN_DEVICES
        )
        if not ok_path:
            raise AssertionError(f'{where}: gateway dial path is not a known device ssh endpoint ({safe_url(url)})')
        if parts.query or parts.fragment or parts.username is not None:
            raise AssertionError(f'{where}: gateway dial carries query/fragment/userinfo ({safe_url(url)})')
    elif account is not None:
        origin, path, methods = account
        if not _same_origin(parts, origin) or parts.path not in (p for _, p, _ in ACCOUNT_HTTP_SURFACES):
            raise AssertionError(f'{where}: not the exact account surface ({safe_url(url)})')
        if parts.query or parts.fragment or parts.username is not None:
            raise AssertionError(f'{where}: account URL carries query/fragment/userinfo ({safe_url(url)})')
    elif app:
        pass  # the preview origin: no credential anywhere (scanned below)
    elif parts.scheme == 'https' and host == 'accounts.google.com' and effective_port(parts) == 443 \
            and parts.path == '/gsi/client':
        # the stubbed GIS client script: its EXACT https origin + path (any
        # other scheme, port or path is a different surface and refuses
        # below), credential-free
        if parts.query or parts.fragment or parts.username is not None:
            raise AssertionError(f'{where}: the GIS script URL carries query/fragment/userinfo ({safe_url(url)})')
    else:
        raise AssertionError(f'{where}: URL is not one of this run\'s configured surfaces ({safe_url(url)})')

    for what, text, google_allowed in _scan_material(parts, url, legacy):
        for secret, label in SECRET_LABELS:
            if secret == GOOGLE_TOKEN and google_allowed:
                continue  # the legacy relay's ONE token-field copy (rule above)
            assert secret not in text, f'{where}: {label} rode {what} ({safe_url(url)})'


def assert_http_request_custody_prod(method: str, url: str, headers: dict, body: str, where: str,
                                     header_entries: list | None = None) -> None:
    """The ONE captured-HTTP policy for every recorded request: URL rules
    above; account surfaces demand an allowed method and the EXACT Bearer;
    every header value (complete capture + duplicate-preserving array) and
    every body are scanned against the FULL secret set; a second
    Authorization entry is refused."""
    assert_url_custody_prod(url, where)
    parts = urlsplit(url)
    host = (parts.hostname or '').lower()
    surface = next(((o, p, m) for o, p, m in ACCOUNT_HTTP_SURFACES
                    if (o.hostname or '').lower() == host and effective_port(o) == effective_port(parts) and p == parts.path), None)
    authz = next((v for k, v in headers.items() if k.lower() == 'authorization'), '')
    if header_entries is not None:
        authz_entry_values = [v for k, v in header_entries if k.lower() == 'authorization']
        assert len(authz_entry_values) <= 1, (
            f'{where}: {len(authz_entry_values)} Authorization header entries — the exact Bearer must be '
            f'the ONE Authorization header ({safe_url(url)})'
        )
    if surface is not None:
        origin, path, methods = surface
        assert method in methods, (
            f'{where}: method {method} is not supported for {origin.hostname} {path} '
            f'(allowed: {", ".join(methods)}; {safe_url(url)})'
        )
        assert authz == f'Bearer {GOOGLE_TOKEN}', (
            f'{where}: Authorization was not the exact Bearer ({safe_url(url)}; shape {authz.split(" ")[0] if authz else "absent"})'
        )
        if path == '/gateway/token':
            assert (body or '') == '', f'{where}: the broker exchange must send an empty body ({safe_url(url)})'
    else:
        assert GOOGLE_TOKEN not in authz, (
            f'{where}: the Google sign-in rode the Authorization header of a non-account request ({safe_url(url)})'
        )
    for key, value in list(headers.items()) + list(header_entries or []):
        if surface is not None and key.lower() == 'authorization':
            continue  # pinned to the EXACT bearer by the equality above
        for secret, label in SECRET_LABELS:
            assert secret not in key, f'{where}: {label} rode a header NAME ({key[:8]}; {safe_url(url)})'
            assert secret not in value, f'{where}: {label} rode the {key[:8]} header ({safe_url(url)})'
    for secret, label in SECRET_LABELS:
        assert secret not in (body or ''), f'{where}: {label} left the browser in a body ({safe_url(url)})'


def http_custody_negative_control_prod() -> None:
    """The prod policy must REFUSE every poisoned placement and ACCEPT the
    documented honest surfaces — the load-bearing proof that the live scan is
    wired to a policy that bites."""
    G = GOOGLE_TOKEN
    legacy_origin = urlsplit(LEGACY_URL)
    gw_origin = urlsplit(GATEWAY_URL)
    device = sorted(KNOWN_DEVICES)[0] if KNOWN_DEVICES else 'dev'

    honest = [
        ('GET', f'{SYNC_URL}/me', {'Authorization': f'Bearer {G}'}, ''),
        ('PUT', f'{SYNC_URL}/settings/main', {'Authorization': f'Bearer {G}'}, '{"data":"<ciphertext>","version":1}'),
        ('POST', f'{BROKER_URL}/gateway/token', {'Authorization': f'Bearer {G}'}, ''),
        ('GET', f'http://{urlsplit(BASE).netloc}/', {}, ''),
        ('GET', 'https://accounts.google.com/gsi/client', {}, ''),
        ('GET', f'{legacy_origin.scheme}://{legacy_origin.netloc}/pipe?host=127.0.0.1&port=22&token={G}', {}, ''),
        ('GET', f'{gw_origin.scheme}://{gw_origin.netloc}/api/v1/hosts/{device}/ssh', {}, ''),
    ]
    for method, url, headers, body in honest:
        assert_http_request_custody_prod(method, url, headers, body, 'negative-control')

    rejected = [
        # wrong scheme / effective port / path on the legacy exception
        (f'http://{urlsplit(LEGACY_URL).hostname}:444/untrusted?token={G}',),
        # the legacy relay origin on the WRONG SCHEME (plain http) with an
        # otherwise exact dial: a same-host wrong-scheme URL is NOT the surface
        (f'http://{urlsplit(LEGACY_URL).netloc}/pipe?host=127.0.0.1&port=22&token={G}',),
        # the gateway origin on the WRONG SCHEME (http and wss), exact path
        (f'http://{urlsplit(GATEWAY_URL).netloc}/api/v1/hosts/{device}/ssh',),
        (f'wss://{urlsplit(GATEWAY_URL).netloc}/api/v1/hosts/{device}/ssh',),
        # the GIS script on a wrong scheme/port, and with a query
        ('http://accounts.google.com:444/gsi/client',),
        ('https://accounts.google.com:8443/gsi/client',),
        ('https://accounts.google.com/gsi/client?x=1',),
        # the app origin on the wrong scheme
        (f'https://{urlsplit(BASE).netloc}/',),
        # duplicate sign-in copy in the fragment beside the allowed query
        (f'{legacy_origin.scheme}://{legacy_origin.netloc}/pipe?host=127.0.0.1&port=22&token={G}#token={G}',),
        # the sign-in outside the ONE token field (host field)
        (f'{legacy_origin.scheme}://{legacy_origin.netloc}/pipe?host={G}&port=22&token={G}',),
        # extra query field
        (f'{legacy_origin.scheme}://{legacy_origin.netloc}/pipe?host=127.0.0.1&port=22&token={G}&x=1',),
        # account surface on the wrong scheme/port/path
        (f'http://{urlsplit(SYNC_URL).hostname}:444/me',),
        # sign-in in an account URL instead of the header
        (f'{SYNC_URL}/me?token={G}',),
        # the sign-in on a gateway dial URL
        (f'{gw_origin.scheme}://{gw_origin.netloc}/api/v1/hosts/{device}/ssh?token={G}',),
        # unknown device on the gateway
        (f'{gw_origin.scheme}://{gw_origin.netloc}/api/v1/hosts/nosuch/ssh',),
        # credential on an unconfigured origin
        (f'https://evil.test/?q={G}',),
    ]
    for (url,) in rejected:
        threw = False
        try:
            assert_url_custody_prod(url, 'negative-control')
        except AssertionError:
            threw = True
        assert threw, f'the URL policy FAILED to reject: {safe_url(url)}'

    poisoned_requests = [
        ('GET', f'{SYNC_URL}/me', {'Authorization': f'Bearer wrong'}, '', 'wrong bearer on account surface'),
        ('GET', f'{SYNC_URL}/me', {'Authorization': G}, '', 'bearer without scheme'),
        ('DEL', f'{SYNC_URL}/settings/main', {'Authorization': f'Bearer {G}'}, '', 'unsupported method'),
        ('POST', f'{BROKER_URL}/gateway/token', {'Authorization': f'Bearer {G}'}, 'payload', 'non-empty broker body'),
        ('GET', f'http://{urlsplit(BASE).netloc}/', {'Authorization': f'Bearer {G}'}, '', 'sign-in on a non-account request'),
        ('GET', f'http://{urlsplit(BASE).netloc}/', {'X-Config': CANARY}, '', 'canary in a header'),
        ('GET', f'http://{urlsplit(BASE).netloc}/', {'X-Pass': KEY_PASSPHRASE}, '', 'passphrase in a header'),
        ('GET', f'http://{urlsplit(BASE).netloc}/', {}, f'key={CANARY}', 'canary in a body'),
        ('PUT', f'{SYNC_URL}/settings/main', {'Authorization': f'Bearer {G}'}, f'plain {KEY_PASSPHRASE}', 'passphrase in a body'),
    ]
    for method, url, headers, body, what in poisoned_requests:
        threw = False
        try:
            assert_http_request_custody_prod(method, url, headers, body, 'negative-control')
        except AssertionError:
            threw = True
        assert threw, f'the captured-HTTP policy FAILED to reject {what}'

    # duplicate-preserving header array: a SECOND Authorization entry is
    # refused even when both look honest.
    threw = False
    try:
        assert_http_request_custody_prod(
            'GET', f'{SYNC_URL}/me', {'Authorization': f'Bearer {G}'}, '', 'negative-control',
            header_entries=[('Authorization', f'Bearer {G}'), ('Authorization', f'Bearer {G}')])
    except AssertionError:
        threw = True
    assert threw, 'the policy FAILED to reject a duplicate Authorization entry'
    print(f'prod captured-HTTP policy control: {len(honest)} honest surfaces accepted, '
          f'{len(rejected)} URL placements + {len(poisoned_requests) + 1} request shapes rejected')


class _ApiShapedRequest:
    """A request shaped like the INSTALLED async Playwright API: `all_headers`
    and `headers_array` are async METHODS; `post_data`, `method`, `url` are
    properties. The live capture path must work against exactly this shape —
    helper-only dicts prove nothing."""

    def __init__(self, method: str, url: str, headers: dict, entries: list, body: str = '',
                 delay: float = 0.0, fail_all_headers: bool = False, fail_array: bool = False):
        self._method, self._url, self._headers, self._entries, self._body = method, url, headers, entries, body
        self._delay, self._fail_all_headers, self._fail_array = delay, fail_all_headers, fail_array

    async def all_headers(self) -> dict:
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._fail_all_headers:
            raise RuntimeError('request destroyed')
        return dict(self._headers)

    async def headers_array(self) -> list:
        if self._fail_array:
            raise RuntimeError('request destroyed')
        # the installed API returns NameValue dicts, duplicate entries preserved
        return [{'name': n, 'value': v} for n, v in self._entries]

    @property
    def post_data(self):
        return self._body or None

    @property
    def method(self):
        return self._method

    @property
    def url(self):
        return self._url


async def http_capture_control_prod() -> None:
    """The LIVE capture path against ACTUAL async-API-shaped requests: the
    complete header capture (merged view + duplicate-preserving array) must
    survive a delayed resolution, must PRESERVE duplicate header entries, and
    must FAIL CLOSED (raise, never silently lose the merged view) when either
    header view cannot be read — including the property-shaped request the
    old executable bug assumed."""
    bearer = f'Bearer {GOOGLE_TOKEN}'
    entries = [('Authorization', bearer), ('Accept', 'application/json'),
               ('X-Double', 'one'), ('X-Double', 'two')]

    async def captured(req) -> dict:
        return await capture_request(req)

    # 1. honest capture, duplicates preserved end to end
    cap = await captured(_ApiShapedRequest(
        'GET', f'{SYNC_URL}/me', {'Authorization': bearer}, entries))
    doubles = [v for k, v in cap['header_entries'] if k == 'X-Double']
    assert doubles == ['one', 'two'], f'the capture lost duplicate header entries: {cap["header_entries"]}'
    assert cap['headers'] == {'Authorization': bearer}
    assert_http_request_custody_prod(cap['method'], cap['url'], cap['headers'], cap['body'],
                                     'capture-control', header_entries=cap['header_entries'])
    # 2. a DELAYED complete-header resolution still captures in full
    cap = await captured(_ApiShapedRequest(
        'GET', f'{SYNC_URL}/me', {'Authorization': bearer}, entries, delay=0.2))
    assert cap['headers'] == {'Authorization': bearer}, 'the delayed capture lost the merged headers'
    # 3. FAIL CLOSED: a destroyed request (either view) raises — it never
    #    degrades into a headerless dict that would skip the merged scan
    for broken in (
        _ApiShapedRequest('GET', f'{SYNC_URL}/me', {}, entries, fail_all_headers=True),
        _ApiShapedRequest('GET', f'{SYNC_URL}/me', {}, entries, fail_array=True),
    ):
        raised = False
        try:
            await captured(broken)
        except RuntimeError as e:
            raised = 'capture failed' in str(e)
        assert raised, 'a failed complete-header capture did NOT fail closed'
    # 4. the property-shaped request (the old bug's assumption) must NOT
    #    capture — awaiting a non-awaitable fails the capture (fail closed,
    #    naming the underlying TypeError), never a shrunken success
    prop_req = _ApiShapedRequest('GET', f'{SYNC_URL}/me', {'Authorization': bearer}, entries)
    prop_req.headers_array = entries  # a plain list attribute, not a method
    raised = False
    try:
        await captured(prop_req)
    except RuntimeError as e:
        raised = 'TypeError' in str(e)
    assert raised, 'the capture silently accepted a property-shaped headers_array'
    print('prod capture-path control: async-method capture with duplicates + delayed resolution accepted; '
          'destroyed/property-shaped captures fail closed')


def key_body(name: str) -> str:
    return open(os.path.join(WORK, name)).read().strip()


# The owned private keys under proof — the exact bodies (whitespace-
# normalized away) that must appear in NO captured frame.
PRIVATE_KEYS = [key_body(n) for n in ('key_plain', 'key_rsa', 'key_enc')]
for pem in PRIVATE_KEYS:
    assert 'PRIVATE KEY' in pem


def assert_wire_custody(binary: bytes, texts: list, where: str) -> None:
    """NO owned secret may appear in ANY recorded frame — binary or text,
    scanned against the SAME full set on both surfaces."""
    joined = '\n'.join(texts)
    for secret in SECRETS_AS_TEXT:
        assert secret not in joined, f'{where}: {secret[:24]}… reached a TEXT frame'
    for secret in SECRETS_AS_BYTES:
        assert secret not in binary, f'{where}: {secret[:24]!r} reached the binary wire'
    # Full private-key bodies too (the BEGIN-marker check above is the fast
    # path; this is the exact-content check).
    for pem in PRIVATE_KEYS:
        compact = ''.join(pem.split())
        assert compact.encode() not in binary, f'{where}: a full private key reached the binary wire'


def custody_negative_control() -> None:
    for poisoned in (
        {'binary': b'', 'texts': [f'x{PRIVATE_KEYS[0]}y']},
        {'binary': b'\x00\x01' + KEY_PASSPHRASE.encode(), 'texts': []},
        {'binary': b'', 'texts': [f'auth {GOOGLE_TOKEN}']},
        {'binary': CANARY.encode(), 'texts': []},
        {'binary': b'', 'texts': ['---BEGIN RSA PRIVATE KEY---zz']},
    ):
        threw = False
        try:
            assert_wire_custody(poisoned['binary'], poisoned['texts'], 'negative-control')
        except AssertionError:
            threw = True
        assert threw, f'custody oracle FAILED to reject an injected credential: {str(poisoned)[:80]}'


class SocketRecord:
    """One observed WebSocket: url + every frame, READ-ONLY (the browser
    talks to the real endpoints; nothing is intercepted or rewritten)."""

    def __init__(self, url: str):
        self.url = url
        self.sent: list = []  # (is_text, payload)
        self.received: list = []
        self.closed = False

    def all_text(self) -> list:
        return [p for t, p in self.sent if t] + [p for t, p in self.received if t]

    def all_binary(self) -> bytes:
        return b''.join([p for t, p in self.sent if not t] +
                        [p for t, p in self.received if not t])


SOCKETS: list = []


def watch(page, store: list) -> None:
    def on_socket(ws):
        rec = SocketRecord(ws.url)
        store.append(rec)
        ws.on('framesent', lambda p: rec.sent.append((isinstance(p, str), p if isinstance(p, str) else bytes(p))))
        ws.on('framereceived', lambda p: rec.received.append((isinstance(p, str), p if isinstance(p, str) else bytes(p))))
        ws.on('close', lambda *_: setattr(rec, 'closed', True))
    page.on('websocket', on_socket)


def gateway_sockets(store: list) -> list:
    gw_netloc = urlsplit(GATEWAY_URL).netloc
    return [s for s in store if gw_netloc in s.url]


def legacy_sockets(store: list) -> list:
    legacy_netloc = urlsplit(LEGACY_URL).netloc
    return [s for s in store if legacy_netloc in s.url]


def decode_jwt(token: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(_b64_pad(token.split('.')[1])))


def _verify_broker_rs256(token: str, where: str) -> None:
    """ACTUAL signature verification of the auth-frame token against the
    fixture broker's OWNED public key (the key whose RFC 7638 thumbprint the
    running broker serves as kid): RS256 over the exact signing input.
    Decoding claims alone proves nothing — this check bites."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding as asym_padding

    try:
        head_b64, payload_b64, sig_b64 = token.split('.')
    except ValueError:
        raise AssertionError(f'{where}: the auth token is not a three-part JWT')
    signing_input = f'{head_b64}.{payload_b64}'.encode()
    try:
        signature = base64.urlsafe_b64decode(_b64_pad(sig_b64))
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f'{where}: the auth token signature is not base64url: {e}')
    try:
        BROKER_KEY.private.public_key().verify(
            signature, signing_input, asym_padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        raise AssertionError(
            f'{where}: the auth token RS256 signature does NOT verify against the fixture broker key '
            f'(kid {BROKER_KEY.kid[:8]}…)')


def assert_scoped_token(token: str, where: str) -> None:
    """The auth frame's token must be a LIVE broker-scoped credential whose
    RS256 signature VERIFIES against the fixture broker's owned key (the
    same key material the broker's JWKS serves — the header kid is that
    key's RFC 7638 thumbprint, recomputed and pinned here), with the exact
    production claim contract (issuer, audience, scope, email, bounded
    lifetime) — and NEVER the Google sign-in."""
    assert token != GOOGLE_TOKEN, f'{where}: the auth frame carried the raw sign-in'
    header = json.loads(base64.urlsafe_b64decode(_b64_pad(token.split('.')[0])))
    assert header['alg'] == 'RS256' and header['kid'] == BROKER_KEY.kid, header
    _verify_broker_rs256(token, where)
    claims = decode_jwt(token)
    assert claims['iss'] == BROKER_URL and claims['aud'] == 'pocketshell-gateway', claims
    assert claims['scope'] == 'pocketshell.gateway', claims
    now = time.time()
    assert claims['exp'] > now, claims
    assert claims['exp'] - claims['iat'] <= 300, claims  # the production TTL cap
    assert claims.get('nbf', 0) <= now + 60, claims
    assert claims['email'] == GOOGLE_EMAIL, claims
    # kid binding: the verification key's thumbprint IS the token's kid —
    # the key that verifies is exactly the key the broker publishes.
    pub = BROKER_KEY.private.public_key().public_numbers()
    n_b64 = base64.urlsafe_b64encode(pub.n.to_bytes((pub.n.bit_length() + 7) // 8, 'big')).rstrip(b'=').decode()
    e_b64 = base64.urlsafe_b64encode(pub.e.to_bytes((pub.e.bit_length() + 7) // 8, 'big')).rstrip(b'=').decode()
    jwk_canonical = json.dumps({'e': e_b64, 'kty': 'RSA', 'n': n_b64}, separators=(',', ':'), sort_keys=True)
    import hashlib
    thumb = base64.urlsafe_b64encode(hashlib.sha256(jwk_canonical.encode()).digest()).rstrip(b'=').decode()
    assert thumb == header['kid'], 'the fixture broker key thumbprint does not match the token kid'


def scoped_token_verification_control() -> None:
    """The scoped-token verifier must REFUSE every dishonest token through
    the SAME live path: matching claims with a corrupted or foreign-key
    signature, a tampered payload, an expired lifetime, and the raw sign-in
    — and ACCEPT the honest mint."""
    import gateway_fixture_broker as broker_mod

    broker_mod.ISSUER = BROKER_URL
    where = 'token-control'
    good = broker_mod.mint_scoped_token(BROKER_URL)['token']
    assert_scoped_token(good, where)  # honest mint accepted

    # corrupt a REAL signature byte (the last base64 char may be padding bits
    # only — a flip there decodes to the same signature and rightly verifies)
    _h, _p, _s = good.split('.')
    _sig = bytearray(base64.urlsafe_b64decode(_b64_pad(_s)))
    _sig[0] ^= 0xFF
    corrupted = '.'.join([_h, _p, base64.urlsafe_b64encode(bytes(_sig)).rstrip(b'=').decode()])
    foreign = broker_mod.BrokerKey()
    foreign_token = foreign.sign_rs256(
        {'alg': 'RS256', 'typ': 'JWT', 'kid': foreign.kid},
        {**decode_jwt(good)})
    poisoned = [
        ('corrupted signature', corrupted),
        ('tampered payload (claims edited under the honest signature)', '.'.join(
            [good.split('.')[0],
             base64.urlsafe_b64encode(json.dumps(
                 {**decode_jwt(good), 'scope': 'pocketshell.admin'}).encode()).rstrip(b'=').decode(),
             good.split('.')[2]])),
        ('foreign-key signature (valid claims, wrong key)', foreign_token),
        ('expired lifetime (honest signature)', broker_mod.mint_variant('expired')),
        ('the raw Google sign-in', GOOGLE_TOKEN),
    ]
    for what, bad in poisoned:
        threw = False
        try:
            assert_scoped_token(bad, where)
        except AssertionError:
            threw = True
        assert threw, f'the scoped-token verifier FAILED to reject {what}'
    print('prod scoped-token control: honest mint verified; corrupted/tampered/foreign-key/expired/sign-in refused')


def assert_gateway_socket_frames(rec: SocketRecord, where: str) -> None:
    """The COMPLETE wire contract for one recorded gateway socket, from the
    shipping transport's own contract (src/terminal/gatewayDuplex.ts + core
    gatewayTransport.ts): the FIRST frame the browser sends is ONE text auth
    frame — exactly {type, v, token, device_id}, its device the dialed URL's
    device, its token a signature-VERIFIED live scoped broker credential;
    EVERY other sent frame is binary; at most ONE received text frame and it
    is the ready advisory (any text after the handshake is a protocol
    violation the transport itself tears down). Nothing about the scan
    tolerates 'other text frames somewhere'."""
    assert rec.sent, f'{where}: the gateway socket carried no sent frames'
    assert rec.sent[0][0] and isinstance(rec.sent[0][1], str), (
        f'{where}: the first sent frame is not the text auth frame')
    auth = rec.sent[0][1]
    assert auth.startswith('{"type":"auth"'), f'{where}: the first sent frame is not the auth frame'
    sent_texts = [p for t, p in rec.sent if t]
    assert len(sent_texts) == 1, (
        f'{where}: {len(sent_texts)} sent TEXT frames (the contract is exactly the auth frame, binary SSH after)')
    frame = json.loads(auth)
    assert set(frame) == {'type', 'v', 'token', 'device_id'}, (
        f'{where}: the auth frame keys are not exactly type/v/token/device_id: {sorted(frame)}')
    assert frame['v'] == 1 and frame['device_id'], frame
    url_device = urlsplit(rec.url).path.rstrip('/').split('/')[-2]
    assert frame['device_id'] == url_device, (
        f'{where}: the auth frame device {frame["device_id"]!r} is not the dialed device {url_device!r}')
    assert_scoped_token(frame['token'], where)
    readys = [p for t, p in rec.received if t]
    assert len(readys) <= 1, (
        f'{where}: {len(readys)} received TEXT frames (the contract is at most the one ready advisory)')
    for p in readys:
        parsed = json.loads(p)
        assert parsed.get('type') == 'ready', (
            f'{where}: a received TEXT frame is not the ready advisory: {sorted(parsed)}')


def gateway_socket_frame_control() -> None:
    """The SAME frame-contract path fed poisoned recorder contents (the
    poisoned-auth-frame control for THIS fixture): a second otherwise-valid
    auth frame, sign-in text after the auth, a binary frame before the
    auth, a wrong device, an extra key, a corrupted signature and an
    error-type received frame — every one must refuse; the honest shape
    must pass."""
    import gateway_fixture_broker as broker_mod

    device = sorted(KNOWN_DEVICES)[0] if KNOWN_DEVICES else 'dev-e2e'
    url = f'{GATEWAY_URL}/api/v1/hosts/{device}/ssh'
    good_token = broker_mod.mint_scoped_token(BROKER_URL)['token']
    auth = json.dumps({'type': 'auth', 'v': 1, 'token': good_token, 'device_id': device},
                      separators=(',', ':'))
    ready = json.dumps({'type': 'ready', 'v': 1, 'device_id': device,
                        'ssh_host_key': 'ssh-ed25519 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY'}, separators=(',', ':'))

    def honest_record() -> SocketRecord:
        rec = SocketRecord(url)
        rec.sent.append((True, auth))
        rec.sent.append((False, b'\x16\x03\x01ssh-client-bytes'))
        rec.received.append((True, ready))
        rec.received.append((False, b'\x00\x0bssh-server-bytes'))
        return rec

    assert_gateway_socket_frames(honest_record(), 'frame-control')  # the honest shape accepted

    def poisoned_record(build) -> SocketRecord:
        rec = honest_record()
        build(rec)
        return rec

    # a corrupted-SIGNATURE token: flip a real signature byte (the last base64
    # char can be padding bits only — a flip there is the same signature)
    _h, _p, _s = good_token.split('.')
    _sig = bytearray(base64.urlsafe_b64decode(_b64_pad(_s)))
    _sig[0] ^= 0xFF
    bad_token = '.'.join([_h, _p, base64.urlsafe_b64encode(bytes(_sig)).rstrip(b'=').decode()])
    wrong_device = json.dumps({'type': 'auth', 'v': 1, 'token': good_token, 'device_id': 'other-device'},
                              separators=(',', ':'))
    poisoned = [
        ('a second otherwise-valid auth frame',
         lambda r: r.sent.append((True, auth))),
        ('sign-in text after the auth frame',
         lambda r: r.sent.append((True, f'{{"type":"auth","token":"{GOOGLE_TOKEN}"}}'))),
        ('a binary frame before the auth frame',
         lambda r: r.sent.insert(0, (False, b'\x00\x00'))),
        ('an auth frame naming the WRONG device',
         lambda r: r.sent.__setitem__(0, (True, wrong_device))),
        ('an auth frame with an extra key',
         lambda r: r.sent.__setitem__(0, (True, json.dumps(
             {'type': 'auth', 'v': 1, 'token': good_token, 'device_id': device, 'extra': 'x'},
             separators=(',', ':'))))),
        ('an auth frame whose token signature is corrupted',
         lambda r: r.sent.__setitem__(0, (True, json.dumps(
             {'type': 'auth', 'v': 1, 'token': bad_token, 'device_id': device},
             separators=(',', ':'))))),
        ('an error frame received where only the ready advisory may be',
         lambda r: r.received.append((True, json.dumps(
             {'type': 'error', 'v': 1, 'code': 'unauthorized', 'message': 'x'}, separators=(',', ':'))))),
        ('a second ready advisory',
         lambda r: r.received.append((True, ready))),
    ]
    for what, build in poisoned:
        threw = False
        try:
            assert_gateway_socket_frames(poisoned_record(build), 'frame-control')
        except AssertionError:
            threw = True
        assert threw, f'the gateway frame contract FAILED to reject {what}'
    print('prod gateway frame-contract control: honest auth/ready shape accepted; '
          'poisoned auth/text/order/device/key/signature frames refused')


def step(msg: str) -> None:
    print(f'[gw-e2e] {msg}', flush=True)


# --- captured HTTP: EVERY request the pages issue, complete headers included
HTTP_TASKS: list = []


async def capture_request(req) -> dict:
    """Complete capture of one request: method, URL, ALL headers (the
    duplicate-preserving array too — the property view omits
    security/cookie headers), body. The async Playwright Request exposes
    BOTH header views as async METHODS (a property read is not the array and
    must not silently shrink the capture). FAILS CLOSED: any capture error
    propagates to the final gather, which refuses the whole run — a request
    whose complete headers could not be read is a custody hole, never an
    empty dict. Each protocol call is time-bounded so a wedged request
    surfaces as a named failure instead of hanging the final scan."""
    try:
        headers = await asyncio.wait_for(req.all_headers(), 30)
        header_entries = [(h['name'], h['value']) for h in await asyncio.wait_for(req.headers_array(), 30)]
    except Exception as e:  # noqa: BLE001 — re-raised WITH context: fail closed
        raise RuntimeError(f'complete header capture failed for {safe_url(req.url)}: {type(e).__name__}: {e}') from e
    return {
        'method': req.method,
        'url': req.url,
        'headers': headers,
        'header_entries': header_entries,
        'body': req.post_data or '',
    }


def watch_http(context, what: str) -> None:
    def on_request(req):
        HTTP_TASKS.append(asyncio.ensure_future(capture_request(req)))
    context.on('request', on_request)
    print(f'[gw-e2e] HTTP capture armed on {what} context', flush=True)


def clear_ack_reached(terminal_text: str, ack: str) -> bool:
    """True only when the ack appears as a STANDALONE terminal line — the
    command's OUTPUT. The typed command's echo carries the ack token only
    inside shell quotes, so no echoed row can equal the token, and the
    whole-line comparison rejects any row that merely CONTAINS it (the
    accepted harness's matcher, byte-for-byte semantics)."""
    lines = terminal_text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    return any(line.strip() == ack for line in lines)


def clear_ack_negative_control() -> None:
    ack = f'e2e-clear-ack-{os.urandom(4).hex()}'
    for text, what in (
        (f'testuser@fixture:~$ printf ..; echo {ack}\n', 'the echoed command line'),
        (f'earlier output mentioning {ack} mid-sentence\n', 'a row merely containing the token'),
        ('unrelated output\n', 'an unrelated terminal'),
    ):
        assert not clear_ack_reached(text, ack), f'the ack matcher was satisfied by {what}'
    assert clear_ack_reached(f'$ prompt\r\n{ack}\r\nnext', ack), 'the ack matcher missed real command output'


async def wait_for(predicate, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            ok = predicate()
            if asyncio.iscoroutine(ok) or hasattr(ok, '__await__'):
                # Bound EACH attempt: a predicate whose await never resolves
                # (e.g. a clipboard read waiting on focus) must fail the wait
                # with a name, not wedge the whole harness inside one loop
                # iteration past its own deadline.
                ok = await asyncio.wait_for(ok, min(5.0, max(1.0, deadline - time.monotonic())))
        except asyncio.TimeoutError as e:
            ok = False
            last = e
        except Exception as e:  # noqa: BLE001
            ok = False
            last = e
        if ok:
            return
        await asyncio.sleep(0.3)
    raise AssertionError(f'timed out waiting for {what} (last: {last})')


PAGE = None
CONSOLE_ERRORS: list = []


async def dump_diagnostics() -> None:
    """Best-effort, bounded: every diagnostic gets its own try and timeout so
    a wedged page can never swallow the traceback that names the failure."""
    try:
        print(f'--- failure diagnostics: url={safe_url(PAGE.url)}', flush=True)
    except Exception as e:  # noqa: BLE001
        print(f'(no url: {e})', flush=True)
    for e in CONSOLE_ERRORS[-8:]:
        print(f'  console: {e}', flush=True)
    try:
        shot = os.path.join(WORK, 'gw-e2e-failure.png')
        await asyncio.wait_for(PAGE.screenshot(path=shot), 8)
        print(f'--- screenshot: {shot}', flush=True)
    except Exception as e:  # noqa: BLE001
        print(f'(screenshot unavailable: {type(e).__name__}: {e})', flush=True)
    try:
        text = await asyncio.wait_for(PAGE.inner_text('body'), 8)
        print(text[:1200], flush=True)
    except Exception as e:  # noqa: BLE001
        print(f'(body text unavailable: {type(e).__name__}: {e})', flush=True)


async def unlock_on_app(page) -> None:
    """Reach the unlocked host-prep surface. A FRESH navigation (reload,
    full route change) resets the in-memory stores and needs the passphrase;
    an already-unlocked session goes straight to the Add host screen."""
    await page.goto(BASE + '/app', wait_until='networkidle')
    if await page.locator('input[type=password]').count() > 0:
        await page.fill('input[type=password]', SYNC_PASSPHRASE)
        await page.click('button.primary:has-text("Unlock")')
    await page.wait_for_selector('button:has-text("Add host")', timeout=30_000)


async def connection_state(page) -> dict:
    return await page.evaluate(
        "(() => { const app = document.querySelector('#app').__vue_app__;"
        'const p = app.config.globalProperties.$pinia;'
        "const c = p.state.value.connection || {};"
        "return { error: c.error ?? null, state: c.state ?? null }; })()"
    )


async def connect_from_host_list(page, name: str) -> None:
    await page.locator('.host-row', has_text=name).get_by_role('button', name='Connect').click()
    try:
        await page.wait_for_url(f'**/host/{name}', timeout=45_000)
    except Exception:
        await page.wait_for_timeout(2_000)
        print(f'--- dial to {name} did not navigate; connection store: {await connection_state(page)}')
        raise


async def add_host(page, name: str, hostname: str, port: str, user: str,
                   device: str = '', gwurl: str = '') -> None:
    await unlock_on_app(page)
    await page.click('button:has-text("Add host")')
    await page.fill('input[placeholder="Name (e.g. prod-box)"]', name)
    await page.fill('input[placeholder="Hostname"]', hostname)
    await page.fill('input[placeholder="Port"]', port)
    await page.fill('input[placeholder="User (optional)"]', user)
    if device:
        await page.fill('#hf-gw-device', device)
        await page.fill('#hf-gw-url', gwurl)
    await page.click('button:has-text("Save")')
    await page.wait_for_selector(f'text=Saved {name}')


async def attach_key(page, host: str, keyfile: str, passphrase: str) -> None:
    await page.locator('.host-row', has_text=host).get_by_role('button', name='Key…').click()
    await page.set_input_files('input[aria-label="Private key file"]', os.path.join(WORK, keyfile))
    await page.fill('input[aria-label="Key passphrase"]', passphrase)
    await page.locator('details.keybox', has_text=f'Private key for {host}').get_by_role('button', name='Save').click()
    await page.wait_for_selector(f'text=Key for {host} stored encrypted')


async def pair_host(page, host: str, fingerprint: str) -> None:
    await page.locator('.host-row', has_text=host).get_by_role('button', name='Pair…').click()
    await page.fill('input[aria-label="Host key fingerprint"]', fingerprint)
    await page.click('button:has-text("Save fingerprint")')
    await page.wait_for_selector(f'text={host} is paired')


async def session_rows_loaded(page, host: str) -> bool:
    """The workspace's LIVE session list — populated only by the helper EXEC
    probes over the transport (the aplexer `list` channel): the fixture
    seeds exactly two aplexer sessions (main, build)."""
    return await page.evaluate(
        """() => {
          const app = document.querySelector('#app').__vue_app__;
          const p = app.config.globalProperties.$pinia;
          const s = p.state.value.sessions || {};
          const names = (s.sessions ?? []).map(x => x.name ?? x.session?.name);
          return names.includes('main') && names.includes('build');
        }""",
    )


async def pty_markers(page, mark: str) -> None:
    """A REAL PTY through the shipping TerminalView: a typed echo comes back
    through the remote PTY (ordered after the command), and tty(1) names a
    real terminal device — evidence an actual pty was allocated host-side.
    The marker's last character is a SEPARATE shell word in the typed input,
    so the local echo of the input line can never contain the contiguous
    marker, and the matcher demands the marker as a STANDALONE real output
    line (never a row merely containing it)."""
    tail = mark[-1]
    stem = mark[:-1]
    await page.locator('.xterm-screen').first.click()
    await page.keyboard.type(f'echo {stem}"{tail}"')
    await page.keyboard.press('Enter')

    async def typed_marker() -> bool:
        rows = await page.locator('.xterm-rows').first.inner_text()
        return clear_ack_reached(rows, mark)

    await wait_for(typed_marker, 20, f'the PTY echo of {mark} to render as a standalone output line')
    await page.keyboard.type('tty')
    await page.keyboard.press('Enter')
    await wait_for(lambda: _tty_seen(page), 20, 'tty(1) to name a real PTY device')


async def _tty_seen(page) -> bool:
    rows = await page.locator('.xterm-rows').first.inner_text()
    return '/dev/pts/' in rows


async def open_shell_session(page, host: str, folder: str) -> None:
    route = (
        "(() => { const app = document.querySelector('#app').__vue_app__;"
        "return app.config.globalProperties.$router.push("
        "{ name: 'folder', params: { name: '" + host + "', folder: '" + folder + "' } }); })()"
    )
    await page.evaluate(route)
    await page.wait_for_selector('button:has-text("Start a session here")', timeout=30_000)
    await page.click('button:has-text("Start a session here")')
    await page.wait_for_selector('text=New session', timeout=15_000)
    await page.get_by_role('tab', name='Shell').click()
    await page.get_by_role('button', name='Create session').click()
    await page.wait_for_selector('.xterm-screen', timeout=45_000)
    await page.wait_for_timeout(1_500)


async def osc52_leg(page) -> None:
    """The PACKAGED OSC 52 path over a REAL PTY: a remote yank overwrites a
    prior sentinel; the empty-payload clear is REFUSED — asserted against
    ORDERED PTY OUTPUT, never a sleep. The refusal's acknowledgment is a
    RUN-UNIQUE output token typed SPLIT ACROSS SHELL QUOTES (`echo
    'e2e-clear''-ack-…'`), awaited as a STANDALONE real terminal line via
    clear_ack_reached — a stalled or dropped command fails instead of
    passing on echoed input or an already-present row."""
    await page.evaluate(f"navigator.clipboard.writeText({CLIPBOARD_SENTINEL!r})")
    payload = base64.b64encode(OSC52_MARKER.encode()).decode()
    await page.locator('.xterm-screen').first.click()
    await page.keyboard.type(f"printf '\\033]52;c;{payload}\\a'")
    await page.keyboard.press('Enter')

    async def clip_is_marker() -> bool:
        return await page.evaluate('navigator.clipboard.readText()') == OSC52_MARKER

    await wait_for(clip_is_marker, 20, 'the OSC 52 set to reach the browser clipboard')
    # The empty-payload sequence is refused by the shipping handler; the
    # ordered acknowledgment: a run-unique token, its characters split
    # across shell quotes in the TYPED input so no echoed row can equal it.
    ack = f"e2e-clear-ack-{os.urandom(4).hex()}"
    quoted = "'" + ack[:9] + "'" + "'" + ack[9:] + "'"
    await page.keyboard.type(f"printf '\\033]52;c;\\a'; echo {quoted}")
    await page.keyboard.press('Enter')

    async def clear_attempt_ordered() -> bool:
        rows = await page.locator('.xterm-rows').first.inner_text()
        return clear_ack_reached(rows, ack)

    await wait_for(clear_attempt_ordered, 20, 'the standalone post-clear PTY output line')
    assert await page.evaluate('navigator.clipboard.readText()') == OSC52_MARKER, (
        'the empty-payload OSC 52 clear was NOT refused — the yanked marker is gone'
    )


def fp_for(mode: str, keytype: str) -> str:
    for line in open(os.path.join(WORK, 'hostkeys.txt')):
        parts = line.split()
        if parts[0] == mode and parts[1] == keytype:
            return parts[2]
    raise KeyError((mode, keytype))


def sshd_accepted(container: str) -> list:
    """The container's ACTUAL accepted-publickey log lines. An UNREADABLE log
    raises — an empty read is only honest when the log was really read; a
    silent [] must never stand in for zero accepted auth."""
    probe = subprocess.run(
        ['docker', 'exec', container, 'sh', '-c',
         "grep 'Accepted publickey' /var/log/sshd.log 2>/dev/null || journalctl -u sshd 2>/dev/null || true"],
        capture_output=True, text=True,
    )
    if probe.returncode != 0:
        raise AssertionError(
            f'{container}: the sshd log is not readable (docker exec failed: {probe.stderr.strip()[:120]}) — '
            f'the zero-auth oracle refuses an unreadable log')
    if probe.stdout.strip():
        return probe.stdout.strip().splitlines()
    logs = subprocess.run(['docker', 'logs', container], capture_output=True, text=True)
    if logs.returncode != 0:
        raise AssertionError(f'{container}: neither the in-container sshd log nor docker logs are readable')
    return [l for l in (logs.stdout + logs.stderr).splitlines() if 'Accepted publickey' in l]


def zero_auth_snapshot_or_raise(run_id: str, watched: tuple) -> dict:
    """Per-watched-fixture accepted-publickey counts, with a REAL positive
    calibration: every watched server must ALREADY show at least one accepted
    public-key auth (the fleet readiness probe's own SSH login) — proving the
    log read is healthy and actually sees auth, so a broken read can never
    masquerade as zero."""
    snap = {}
    for m in watched:
        lines = sshd_accepted(f'{run_id}-{m}')
        assert lines, (
            f'{m}: the sshd log read is healthy but shows ZERO accepted public-key auth — the readiness '
            f'probe login must already be visible; an empty read cannot stand in for zero')
        snap[m] = len(lines)
    return snap


def assert_zero_added_auth(before: dict, after: dict, watched: tuple) -> None:
    """The calibrated zero-auth oracle: for EVERY watched fixture server the
    accepted-publickey count must be IDENTICAL across the negative legs
    (server-side truth: the negatives die before userauth or before any
    socket). Covers the whole watched set — a missing snapshot entry is a
    failed oracle, not an unchecked server."""
    assert set(before) == set(watched) and set(after) == set(watched), (
        f'the zero-auth snapshots do not cover every watched fixture: before={sorted(before)} '
        f'after={sorted(after)} watched={sorted(watched)}')
    for m in watched:
        assert before[m] == after[m], (
            f'a negative leg produced accepted userauth on {m}: before={before[m]} after={after[m]}')


def zero_auth_oracle_control() -> None:
    """The zero-auth oracle is LOAD-BEARING: an added accepted auth on any
    watched fixture — and a snapshot missing a watched fixture — must both
    be caught."""
    watched = ('multi', 'reverse')
    before = {m: 3 for m in watched}
    assert_zero_added_auth(before, dict(before), watched)  # unchanged accepted
    for m in watched:
        after = dict(before)
        after[m] += 1
        threw = False
        try:
            assert_zero_added_auth(before, after, watched)
        except AssertionError:
            threw = True
        assert threw, f'the zero-auth oracle FAILED to catch an added accepted auth on {m}'
    threw = False
    try:
        assert_zero_added_auth(before, dict(before), ('multi', 'reverse', 'edrsa'))
    except AssertionError:
        threw = True
    assert threw, 'the zero-auth oracle FAILED to require coverage of every watched fixture'
    print('prod zero-auth oracle control: added accepted auth and missing fixture coverage both caught')


async def main() -> int:
    global PAGE
    custody_negative_control()
    print('custody negative control: injected credentials are rejected by the oracle')
    http_custody_negative_control_prod()
    await http_capture_control_prod()
    clear_ack_negative_control()
    scoped_token_verification_control()
    gateway_socket_frame_control()
    zero_auth_oracle_control()
    print('prod captured-HTTP/URL policy control + CLEAR-ack matcher control: poisoned placements rejected, honest surfaces accepted')
    if OFFLINE_ONLY:
        print('offline controls complete (no browser, no network, no Docker)')
        return 0

    # NOTE: the sync fake — a minimal per-slot opaque store (the vault is not
    # the transport under proof; its custody is the web harness's proven leg).
    routes_page = await async_playwright().start()
    browser = await routes_page.chromium.launch()
    try:
        return await run_flow(browser, routes_page)
    except BaseException:
        # Diagnostics on the LIVE loop (asyncio.run will close it once this
        # propagates — a second asyncio.run cannot reach Playwright).
        await dump_diagnostics()
        raise
    finally:
        try:
            await browser.close()
            await routes_page.stop()
        except Exception:  # noqa: BLE001 — teardown must not mask the failure
            pass


async def run_flow(browser, routes_page) -> int:
    global PAGE
    # ignore_https_errors: the broker FIXTURE serves TLS with a run-ephemeral
    # self-signed certificate because the production exchange guard mints
    # only from an https account-service origin. A lab affordance for the
    # fixture origin; no shipped code changes.
    context = await browser.new_context(viewport={'width': 1280, 'height': 800},
                                        ignore_https_errors=True,
                                        permissions=['clipboard-read', 'clipboard-write'])
    watch_http(context, 'main')
    page = await context.new_page()
    PAGE = page
    main_store: list = []
    watch(page, main_store)

    versions = {'main': 0, 'keys': 0}
    data = {'main': None, 'keys': None}

    async def handle_sync(route):
        req = route.request
        url = req.url
        if url.endswith('/me'):
            await route.fulfill(content_type='application/json',
                                body=json.dumps({'sub': 'e2e', 'email': GOOGLE_EMAIL}))
            return
        slot = 'main' if url.endswith('/settings/main') else ('keys' if url.endswith('/settings/keys') else None)
        if slot is None:
            await route.fulfill(status=404, content_type='application/json', body='{}')
            return
        if req.method == 'GET':
            if data[slot] is None:
                await route.fulfill(status=404, content_type='application/json', body='{"message":"no slot"}')
            else:
                await route.fulfill(content_type='application/json', body=json.dumps(
                    {'slot': slot, 'version': versions[slot], 'data': data[slot]}))
        elif req.method == 'PUT':
            parsed = json.loads(req.post_data or '{}')
            assert parsed['version'] == versions[slot]
            data[slot] = parsed['data']
            versions[slot] += 1
            await route.fulfill(content_type='application/json', body=json.dumps({'version': versions[slot]}))
        else:
            await route.fulfill(status=404, content_type='application/json', body='{}')

    config_stub = (
        "window.POCKETSHELL_WEB = {"
        f" syncApiUrl: '{SYNC_URL}', googleClientId: 'stub.apps.googleusercontent.com',"
        f" wsUrl: 'wss://bridge.e2e.test/link', directWsUrl: '{LEGACY_URL}',"
        f" gatewayServerUrl: '{GATEWAY_URL}', gatewayAllowInsecureWs: true,"
        f" syncApiBase: '{BROKER_URL}' }};"
    )
    gis_stub = """
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
    page.on('console', lambda m: (CONSOLE_ERRORS.append(m.text)) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    await page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=config_stub))
    await page.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=gis_stub))
    await page.route(f'**/{urlsplit(SYNC_URL).netloc}/**', handle_sync)

    fp_multi_ed = fp_for('multi', 'ed25519')
    fp_multi_ec = fp_for('multi', 'ecdsa')

    # --- sign in ------------------------------------------------------------
    # The GIS stub's callback IS the sign-in; it lands the app on the shared
    # host picker (route /). Host prep (unlock) lives one hop away on /app —
    # unlock_on_app performs that navigation, exactly like the accepted web
    # harness. There is no synced-hosts text on the picker itself.
    await page.goto(BASE + '/', wait_until='networkidle')
    await page.evaluate(f"window.__gsiInit.callback({{credential: '{GOOGLE_TOKEN}'}})")

    dial_results = {}

    # --- direct leg: the Go relay's legacy endpoint (documented dev) -------
    step('sign-in complete; starting the DIRECT leg')
    await add_host(page, 'directbox', FIX['directHost'], str(FIX['directPort']), 'testuser')
    await attach_key(page, 'directbox', 'key_plain', '')
    await connect_from_host_list(page, 'directbox')
    await wait_for(lambda: session_rows_loaded(page, 'directbox'), 45,
                   'the direct workspace exec probes (session rows) to land')
    await open_shell_session(page, 'directbox', '~/git/osc-demo')
    await pty_markers(page, f'{PTY_MARK}-direct')
    await osc52_leg(page)
    print('direct leg: exec rows + PTY markers + OSC 52 set/clear-refusal over the Go legacy relay')
    dial_results['direct'] = True

    # --- gateway positives -------------------------------------------------
    step('direct leg complete; starting the gateway mode dials')
    gw_specs = [
        ('gw-multi', 'multi', FIX['modes']['multi'], 'key_plain', ''),
        ('gw-reverse', 'reverse', FIX['modes']['reverse'], 'key_enc', KEY_PASSPHRASE),
        ('gw-rsaonly', 'rsaonly', FIX['modes']['rsaonly'], 'key_rsa', ''),
        # ('gw-sshrsa' is NOT in the positive list: the legacy ssh-rsa-only
        # mode is asserted separately below — the SHIPPING BROWSER cannot
        # complete a kex whose host key signs with ssh-rsa (SHA-1): the dial
        # dies with "Handshake failed: signature verification failed" while
        # the SAME server's signatures verify fine for the Go home agent at
        # enrollment. That asymmetry is a genuine browser-side finding
        # (recorded, not papered over): RSA SHA-2 host keys and user keys
        # both dial (gw-rsaonly proves the user-key half, gw-multi and
        # rsaonly prove host-key rsa-sha2-512).
        ('gw-edrsa', 'edrsa', FIX['modes']['edrsa'], 'key_plain', ''),
    ]
    for host, mode, spec, keyfile, passphrase in gw_specs:
        step(f'dialing {host} ({mode} mode)')
        await add_host(page, host, f'{mode}.gw.e2e.test', '22', 'testuser',
                       device=spec['device'], gwurl=GATEWAY_URL)
        await attach_key(page, host, keyfile, passphrase)
        await pair_host(page, host, fp_for(mode, 'ed25519' if mode != 'rsaonly' and mode != 'sshrsa' else 'rsa'))
        await connect_from_host_list(page, host)
        await wait_for(lambda: session_rows_loaded(page, host), 45,
                       f'the {host} workspace exec probes (session rows) to land')
        print(f'{host}: connected + exec rows over the production gateway ({mode} mode)')
        dial_results[mode] = True

    # PTY markers through the real terminal over the GATEWAY (multi) and an
    # encrypted-key PTY (reverse).
    step('opening a gateway shell session on gw-multi for the PTY + OSC 52 legs')
    await open_shell_session(page, 'gw-multi', '~/git/osc-demo')
    await pty_markers(page, f'{PTY_MARK}-gwmulti')
    await osc52_leg(page)
    print('gw-multi leg: PTY markers + OSC 52 set/clear-refusal over the production gateway')

    await open_shell_session(page, 'gw-reverse', '~/git/osc-demo')
    await pty_markers(page, f'{PTY_MARK}-gwreverse')
    print('gw-reverse leg: passphrase-encrypted key PTY over the production gateway')

    # --- calibrated zero-auth oracle snapshot --------------------------------
    # Every positive dial/shell that will ever touch an sshd has now happened
    # for the servers the NEGATIVE legs aim at (edrsa: wrong-pin; sshrsa: the
    # kex-failure finding) or leave untouched (multi/reverse). The negatives
    # must add ZERO accepted userauth lines on any of them — asserted against
    # the sshd logs' actual Accepted lines below (server-side truth, not
    # client-side inference).
    zero_auth_watch = ('edrsa', 'sshrsa', 'multi', 'reverse')
    zero_auth_snapshot = zero_auth_snapshot_or_raise(FIX['runId'], zero_auth_watch)
    print(f'zero-auth oracle snapshot (accepted userauth lines, all reads healthy): {zero_auth_snapshot}')

    # --- the negative legs (same context) -----------------------------------
    step('gateway mode dials complete; starting the in-browser negatives')
    # 1. keyless gateway host: refused BEFORE any socket.
    socks_before = len(gateway_sockets(main_store))
    await add_host(page, 'gw-keyless', 'keyless.gw.e2e.test', '22', 'testuser',
                   device=FIX['modes']['edrsa']['device'], gwurl=GATEWAY_URL)
    await pair_host(page, 'gw-keyless', fp_for('edrsa', 'ed25519'))
    await page.locator('.host-row', has_text='gw-keyless').get_by_role('button', name='Connect').click()
    await wait_for(
        lambda: page.evaluate(
            "(() => { const app = document.querySelector('#app').__vue_app__;"
            'const p = app.config.globalProperties.$pinia;'
            "return (p.state.value.connection || {}).error || ''; })()"
        ),
        15, 'the keyless gateway refusal to surface')
    assert len(gateway_sockets(main_store)) == socks_before, 'a keyless gateway dial opened a socket'
    assert '/host/' not in page.url, 'the keyless refusal navigated'
    print(f"keyless gateway refusal surfaced: {(await connection_state(page))['error'][:80]}")

    # 2. wrong pairing fingerprint: a DIFFERENT VALID host key (the multi
    #    server's ECDSA key) against the same live server. The gateway's
    #    ready advisory says the RIGHT key; the pin must refuse the dial at
    #    key exchange, before userauth.
    await add_host(page, 'gw-badpin', 'badpin.gw.e2e.test', '22', 'testuser',
                   device=FIX['modes']['edrsa']['device'], gwurl=GATEWAY_URL)
    await attach_key(page, 'gw-badpin', 'key_plain', '')
    await pair_host(page, 'gw-badpin', fp_multi_ec)
    await page.locator('.host-row', has_text='gw-badpin').get_by_role('button', name='Connect').click()
    await wait_for(
        lambda: page.evaluate(
            "(() => { const app = document.querySelector('#app').__vue_app__;"
            'const p = app.config.globalProperties.$pinia;'
            "return (p.state.value.connection || {}).error || ''; })()"
        ),
        30, 'the wrong-pin refusal to surface')
    wrongpin_error = (await connection_state(page))['error']
    assert wrongpin_error, 'no wrong-pin refusal surfaced'
    assert '/host/gw-badpin' not in page.url, 'the wrong-pin dial navigated'
    print(f'wrong-pin refusal surfaced: {wrongpin_error[:100]}')

    # 2b. legacy ssh-rsa-only host key: the dial must reach the kex and die
    # with the honest, specific refusal — recorded as the browser-side
    # finding it is (the Go agent verified this exact server's ssh-rsa
    # signatures during enrollment; the shipping browser cannot).
    await add_host(page, 'gw-sshrsa', 'sshrsa.gw.e2e.test', '22', 'testuser',
                   device=FIX['modes']['sshrsa']['device'], gwurl=GATEWAY_URL)
    await attach_key(page, 'gw-sshrsa', 'key_plain', '')
    await pair_host(page, 'gw-sshrsa', fp_for('sshrsa', 'rsa'))
    await page.locator('.host-row', has_text='gw-sshrsa').get_by_role('button', name='Connect').click()
    await wait_for(
        lambda: page.evaluate(
            "(() => { const app = document.querySelector('#app').__vue_app__;"
            'const p = app.config.globalProperties.$pinia;'
            "return (p.state.value.connection || {}).error || ''; })()"
        ),
        45, 'the ssh-rsa handshake failure to surface')
    sshrsa_error = (await connection_state(page))['error']
    assert 'signature verification failed' in (sshrsa_error or ''), (
        f'the ssh-rsa leg failed differently than the documented finding: {sshrsa_error}'
    )
    assert '/host/gw-sshrsa' not in page.url
    print(f'ssh-rsa host-key finding surfaced honestly: {sshrsa_error[:90]}')

    # 3. ECDSA user key: the shipping signing guard refuses before a socket.
    ecdsa_key = os.path.join(WORK, 'user_ecdsa')
    subprocess.run(['ssh-keygen', '-t', 'ecdsa', '-N', '', '-f', ecdsa_key, '-q'], check=True)
    socks_before = len(gateway_sockets(main_store))
    await add_host(page, 'gw-ecdsakey', 'ecdsakey.gw.e2e.test', '22', 'testuser',
                   device=FIX['modes']['edrsa']['device'], gwurl=GATEWAY_URL)
    key_dst = os.path.join(WORK, 'key_ecdsa')
    os.replace(ecdsa_key, key_dst)
    await attach_key(page, 'gw-ecdsakey', 'key_ecdsa', '')
    await pair_host(page, 'gw-ecdsakey', fp_for('edrsa', 'ed25519'))
    await page.locator('.host-row', has_text='gw-ecdsakey').get_by_role('button', name='Connect').click()
    await wait_for(
        lambda: page.evaluate(
            "(() => { const app = document.querySelector('#app').__vue_app__;"
            'const p = app.config.globalProperties.$pinia;'
            "return (p.state.value.connection || {}).error || ''; })()"
        ),
        15, 'the ECDSA-key refusal to surface')
    ecdsa_error = (await connection_state(page))['error']
    assert ecdsa_error, 'no ECDSA-key refusal surfaced'
    assert len(gateway_sockets(main_store)) == socks_before, 'an ECDSA-key dial opened a gateway socket'
    print(f'ECDSA-key refusal surfaced: {ecdsa_error[:100]}')

    await context.close()

    # --- broker-exchange failure: NO Google fallback, NO gateway socket ----
    step('in-browser negatives complete; starting the broken-broker leg')
    dead_broker = 'http://127.0.0.1:9'
    ctx2 = await browser.new_context(viewport={'width': 1280, 'height': 800}, ignore_https_errors=True)
    watch_http(ctx2, 'broken-broker')
    page2 = await ctx2.new_page()
    PAGE = page2
    store2: list = []
    watch(page2, store2)
    dead_config = config_stub.replace(f" syncApiBase: '{BROKER_URL}'", f" syncApiBase: '{dead_broker}'")
    await page2.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=dead_config))
    await page2.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=gis_stub))
    await page2.route(f'**/{urlsplit(SYNC_URL).netloc}/**', handle_sync)
    await page2.goto(BASE + '/', wait_until='networkidle')
    await page2.evaluate(f"window.__gsiInit.callback({{credential: '{GOOGLE_TOKEN}'}})")
    await unlock_on_app(page2)
    await page2.click('button:has-text("Add host")')
    await page2.fill('input[placeholder="Name (e.g. prod-box)"]', 'gw-brokenbroker')
    await page2.fill('input[placeholder="Hostname"]', 'broken.gw.e2e.test')
    await page2.fill('input[placeholder="Port"]', '22')
    await page2.fill('input[placeholder="User (optional)"]', 'testuser')
    await page2.fill('#hf-gw-device', FIX['modes']['multi']['device'])
    await page2.fill('#hf-gw-url', GATEWAY_URL)
    await page2.click('button:has-text("Save")')
    await page2.wait_for_selector('text=Saved gw-brokenbroker')
    await attach_key(page2, 'gw-brokenbroker', 'key_plain', '')
    await pair_host(page2, 'gw-brokenbroker', fp_multi_ed)
    await page2.locator('.host-row', has_text='gw-brokenbroker').get_by_role('button', name='Connect').click()
    await wait_for(
        lambda: page2.evaluate(
            "(() => { const app = document.querySelector('#app').__vue_app__;"
            'const p = app.config.globalProperties.$pinia;'
            "return (p.state.value.connection || {}).error || ''; })()"
        ),
        30, 'the broken-broker refusal to surface')
    broker_error = (await connection_state(page2))['error']
    assert broker_error, 'no broken-broker refusal surfaced'
    assert gateway_sockets(store2) == [], 'a failed broker exchange STILL opened a gateway socket'
    assert '/host/gw-brokenbroker' not in page2.url
    # The failed exchange surfaced WITHOUT any Google-shaped auth attempt:
    # no gateway socket exists at all, so there was no fallback frame either.
    print(f'broken-broker refusal surfaced (zero gateway sockets): {broker_error[:80]}')
    await ctx2.close()

    # --- wire assertions I: socket counts + the calibrated zero-auth oracle -
    # The tampered-advisory leg below re-dials gw-edrsa SUCCESSFULLY (a
    # positive — it adds one accepted userauth on that server), so the
    # NEGATIVES' zero-added-auth proof must close here, before that leg.
    step('broken-broker leg complete; running the pre-tamper wire assertions')
    gw_recs = gateway_sockets(main_store)
    legacy_recs = legacy_sockets(main_store)
    # 5 positive gateway dials + 1 wrong-pin attempt = exactly 6 sockets; the
    # keyless and ECDSA-key refusals opened none.
    assert len(gw_recs) == 6, f'expected exactly 6 gateway sockets (5 dials + wrong-pin attempt), saw {len(gw_recs)}'
    assert len(legacy_recs) == 1, f'expected exactly 1 direct socket, saw {len(legacy_recs)}'

    # The calibrated zero-auth oracle: the keyless, wrong-pin, ECDSA-key,
    # ssh-rsa-kex and broken-broker legs must have added ZERO accepted
    # userauth lines on ANY watched server (the negatives die before
    # userauth or before any socket at all — server-side truth, every read
    # proven healthy by the snapshot's positive calibration).
    zero_auth_after = zero_auth_snapshot_or_raise(FIX['runId'], zero_auth_watch)
    assert_zero_added_auth(zero_auth_snapshot, zero_auth_after, zero_auth_watch)
    print(f'zero-auth oracle: negatives added no accepted userauth on {sorted(zero_auth_watch)} '
          f'({zero_auth_after})')

    # --- production verifier negatives (server side, real WS route) --------
    step('wire assertions complete; probing the production verifier negatives')
    import websockets
    import gateway_fixture_broker as broker_mod
    broker_mod.ISSUER = BROKER_URL

    async def ws_probe(token: str, device: str) -> dict:
        async with websockets.connect(f'{GATEWAY_URL}/api/v1/hosts/{device}/ssh') as ws:
            await ws.send(json.dumps({'type': 'auth', 'v': 1, 'token': token, 'device_id': device}))
            try:
                reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
                return reply
            except websockets.ConnectionClosed as e:
                return {'type': 'closed', 'code': e.rcvd.code if e.rcvd else None}

    good = broker_mod.mint_scoped_token(BROKER_URL)['token']

    async def _ready_probe(device: str) -> bool:
        try:
            reply = await ws_probe(good, device)
            return reply.get('type') == 'ready'
        except Exception:  # noqa: BLE001 — offline is just "not yet"
            return False

    uniform_denials = []
    for name, variant in (('wrong-iss', 'wrong-iss'), ('wrong-aud', 'wrong-aud'),
                          ('no-scope', 'no-scope'), ('wrong-scope', 'wrong-scope'),
                          ('expired', 'expired')):
        reply = await ws_probe(broker_mod.mint_variant(variant), FIX['modes']['multi']['device'])
        assert reply.get('type') == 'error' and reply.get('code') == 'unauthorized', (name, reply)
        uniform_denials.append(reply['message'])
    for name, tok in (('garbage', 'not.a.jwt'),
                      ('google-shaped', GOOGLE_TOKEN),
                      ('empty', '')):
        reply = await ws_probe(tok, FIX['modes']['multi']['device'])
        assert reply.get('type') == 'error' and reply.get('code') in ('unauthorized', 'protocol'), (name, reply)
    assert len(set(uniform_denials)) == 1, f'token denials were not uniform: {uniform_denials}'
    # Unknown device: the uniform DEVICE denial (distinct axis, per contract).
    reply = await ws_probe(good, 'nosuchdevice42')
    assert reply.get('type') == 'error' and reply.get('code') == 'not_found', reply
    # Revocation through the PRODUCTION identity API, then the uniform denial
    # for the revoked device (the browser already dialed it successfully).
    import urllib.request
    req = urllib.request.Request(
        f'http://127.0.0.1:{urlsplit(GATEWAY_URL).port}/identity/v1/devices/{FIX["modes"]["sshrsa"]["device"]}/revoke',
        method='POST', headers={'Authorization': f'Bearer {good}'})
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200
    reply = await ws_probe(good, FIX['modes']['sshrsa']['device'])
    assert reply.get('type') == 'error', reply
    print(f'production verifier negatives: uniform denial {uniform_denials[0]!r}; device denial for unknown+revoked')

    # --- the lying ready advisory cannot change the pin ---------------------
    step('verifier negatives complete; starting the tampered-advisory leg')
    # The gateway's ready.ssh_host_key is its enrollment record — registry
    # metadata the gateway CONTROLS. Tamper that record out-of-band (a REAL
    # but WRONG key line — the multi server's RSA key), restart the gateway
    # over the same state, and re-dial gw-edrsa with the CORRECT pin: the
    # ready frame now advertises the WRONG key, the wire still presents the
    # pinned Ed25519 key, and the dial must SUCCEED — the advisory is
    # powerless to change trust in EITHER direction (the wrong-pin negative
    # above proved the other direction: pin refuses despite a right advisory).
    tamper_ctx = await browser.new_context(viewport={'width': 1280, 'height': 800}, ignore_https_errors=True)
    watch_http(tamper_ctx, 'tampered-advisory')
    page3 = await tamper_ctx.new_page()
    PAGE = page3
    store3: list = []
    watch(page3, store3)
    await page3.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript', body=config_stub))
    await page3.route('**/accounts.google.com/gsi/client*', lambda r: r.fulfill(content_type='application/javascript', body=gis_stub))
    await page3.route(f'**/{urlsplit(SYNC_URL).netloc}/**', handle_sync)

    registry_file = FIX['gatewayRegistry']
    # The RSA line of the multi server: a valid OpenSSH public key that is
    # NOT the key the server will present.
    pub = open(os.path.join(WORK, 'mode/multi/ssh_host_rsa_key.pub')).read().strip()
    rsa_line = ' '.join(pub.split()[:2])
    reg = json.load(open(registry_file))
    dev = next(d for d in reg['devices'] if d['ID'] == FIX['modes']['edrsa']['device'])
    assert dev['SSHHostKey'].startswith('ssh-ed25519 '), dev['SSHHostKey']
    dev['SSHHostKey'] = rsa_line
    json.dump(reg, open(registry_file, 'w'))
    subprocess.run(['bash', FIX['gatewayRestart']], check=True)
    # The agent reconnects with backoff; wait until the gateway serves the
    # (tampered) device again before re-dialing.
    await wait_for(lambda: _ready_probe(FIX['modes']['edrsa']['device']), 60,
                   'the agent to reconnect after the gateway restart')
    print(f"tampered ready advisory in place: gateway record now says rsa ({rsa_line[:40]}…)")

    await page3.goto(BASE + '/', wait_until='networkidle')
    await page3.evaluate(f"window.__gsiInit.callback({{credential: '{GOOGLE_TOKEN}'}})")
    await unlock_on_app(page3)
    await page3.click('button:has-text("Add host")')
    await page3.fill('input[placeholder="Name (e.g. prod-box)"]', 'gw-tampered')
    await page3.fill('input[placeholder="Hostname"]', 'tampered.gw.e2e.test')
    await page3.fill('input[placeholder="Port"]', '22')
    await page3.fill('input[placeholder="User (optional)"]', 'testuser')
    await page3.fill('#hf-gw-device', FIX['modes']['edrsa']['device'])
    await page3.fill('#hf-gw-url', GATEWAY_URL)
    await page3.click('button:has-text("Save")')
    await page3.wait_for_selector('text=Saved gw-tampered')
    await attach_key(page3, 'gw-tampered', 'key_plain', '')
    await pair_host(page3, 'gw-tampered', fp_for('edrsa', 'ed25519'))
    await connect_from_host_list(page3, 'gw-tampered')
    tampered_socket = [s for s in store3 if urlsplit(GATEWAY_URL).netloc in s.url]
    assert len(tampered_socket) == 1
    ready_texts = [p for t, p in tampered_socket[0].received if t]
    assert ready_texts and json.loads(ready_texts[0])['ssh_host_key'].startswith('ssh-rsa '), (
        f'the tampered advisory did not surface: {ready_texts[:1]}'
    )
    print('tampered-advisory leg: ready advertised the WRONG (rsa) key — the pin held, the dial succeeded')
    await tamper_ctx.close()

    # --- FINAL custody scan: ALL THREE contexts, post-quiescence ------------
    # Every context is now closed, so no late frame, no late HTTP task and no
    # third-context traffic can escape: this ONE pass scans every socket of
    # every store (dial URL policy; binary AND text, sent AND received),
    # every auth frame, and every captured HTTP request of all three
    # contexts (joined fail-closed).
    step('tampered-advisory leg complete; final custody scan over ALL THREE browser contexts (post-quiescence)')
    tampered_recs = [s for s in store3 if urlsplit(GATEWAY_URL).netloc in s.url]
    assert len(tampered_recs) == 1, f'expected exactly 1 tampered-advisory gateway socket, saw {len(tampered_recs)}'
    for store, label in ((main_store, 'main'), (store2, 'broken-broker'), (store3, 'tampered-advisory')):
        for rec in store:
            # The recorded dial URL through the ONE structured URL policy:
            # exact scheme/host/effective-port/path/query contracts, the
            # legacy relay's exact query shape with the sign-in as the ONE
            # token field value, no credential anywhere else (raw or
            # decoded), unknown origins refused.
            assert_url_custody_prod(rec.url, f'{label} socket')
            assert_wire_custody(rec.all_binary(), rec.all_text(), f'{label} {safe_url(rec.url)}')

    # Auth frames: exactly one TEXT auth frame per gateway socket (the FIRST
    # frame sent), exact shape, its device the dialed URL's device, its token
    # a signature-VERIFIED live broker-scoped RS256 credential; every other
    # sent frame binary; at most the one ready advisory back. Includes the
    # tampered-advisory context's socket.
    for rec in gw_recs + tampered_recs:
        assert_gateway_socket_frames(rec, f'gateway {safe_url(rec.url)}')
    # The wrong-pin socket got ready (advisory) but never a session: its SSH
    # stream died at the pin refusal — it carries NO exec/shell data beyond
    # the kex. Positive sockets DID carry real traffic both ways. Socket
    # order: the four positive dials, then wrong-pin (opened, ready, died at
    # the pin), then the ssh-rsa finding (opened, ready, died at the kex
    # signature verification).
    for rec in gw_recs[:4]:
        assert len(rec.all_binary()) > 200 and rec.received, f'{safe_url(rec.url)}: no real SSH traffic'
    wrongpin_rec = gw_recs[4]
    assert wrongpin_rec.all_text() or wrongpin_rec.all_binary()
    sshrsa_rec = gw_recs[5]
    assert sshrsa_rec.all_binary(), 'the ssh-rsa dial died before any SSH bytes flowed'
    assert len(tampered_recs[0].all_binary()) > 200 and tampered_recs[0].received, \
        'the tampered-advisory redial carried no real SSH traffic'

    # HTTP surfaces through the ONE captured-HTTP policy: every request ALL
    # THREE contexts issued is awaited and scanned — URL rules, methods, the
    # EXACT Bearer only on the exact account surfaces, every header value
    # (merged view + duplicate-preserving array) and body against the full
    # secret set. A capture failure FAILS the run here (never a silently
    # shrunken capture). The positive calibrations prove the capture really
    # SAW the account surfaces (a capture that silently missed the broker
    # exchange would prove nothing).
    http_capture_results = list(await asyncio.gather(*HTTP_TASKS, return_exceptions=True))
    http_captures = [t for t in http_capture_results if isinstance(t, dict)]
    failed_captures = [t for t in http_capture_results if not isinstance(t, dict)]
    assert not failed_captures, (
        f'{len(failed_captures)} request captures FAILED (fail-closed): {failed_captures[:2]}')
    for cap in http_captures:
        assert_http_request_custody_prod(cap['method'], cap['url'], cap['headers'], cap['body'],
                                         'captured HTTP', header_entries=cap['header_entries'])
    brokers = [c for c in http_captures if c['url'].startswith(BROKER_URL) and c['url'].endswith('/gateway/token')]
    assert brokers and all(c['method'] == 'POST' for c in brokers), (
        f'the broker exchange was never captured: {[c["url"] for c in http_captures][:5]}'
    )
    assert any(c['method'] == 'PUT' and '/settings/keys' in c['url'] for c in http_captures), \
        'the keys-slot sync PUT was never captured'
    print(f'captured-HTTP policy: {len(http_captures)} requests across ALL THREE contexts scanned '
          f'(broker POSTs: {len(brokers)}); zero raw or decoded credential placements')

    # Exec markers documented from the HOST side: the sshd logs' actual
    # Accepted-publickey lines (per mode, incl. the RSA SHA2 negotiation).
    receipt_sshd = {}
    for mode, spec in FIX['modes'].items():
        lines = sshd_accepted(f"{FIX['runId']}-{mode}")
        receipt_sshd[mode] = lines
        assert lines, f'{mode}: the sshd log shows no accepted public-key auth'
    assert any('rsa-sha2-512' in l or 'rsa-sha2-256' in l for l in receipt_sshd['rsaonly']), (
        f"rsaonly: the browser did not negotiate an RSA SHA2 userauth: {receipt_sshd['rsaonly']}"
    )
    with open(os.path.join(WORK, 'sshd-accepted.json'), 'w') as fh:
        json.dump(receipt_sshd, fh, indent=1)

    # sanity: no console errors accumulated in the main flow
    assert CONSOLE_ERRORS == [], CONSOLE_ERRORS

    print('COMBINED GATEWAY PROOF PASS')
    print(f"  gateway sockets: {len(gw_recs)} (4 dial modes + wrong-pin refusal) + 1 tampered-advisory redial; "
          f"direct sockets: {len(legacy_recs)}")
    print(f"  dial results: {sorted(dial_results)}")
    print(f"  custody: ALL THREE contexts (main, broken-broker, tampered-advisory), post-quiescence — every socket "
          f"scanned (dial URLs through the exact-surface policy; binary+text, sent+received) against "
          f"{len(SECRETS_AS_TEXT)} secret forms + full key bodies; {len(http_captures)} captured requests scanned")
    print('  auth frames: exactly one per gateway socket (incl. the tampered redial), each the FIRST frame, '
          'exact-shape, RS256-SIGNATURE-VERIFIED against the fixture broker key, never the sign-in')
    return 0


if __name__ == '__main__':
    code = asyncio.run(main())
    raise SystemExit(code)
