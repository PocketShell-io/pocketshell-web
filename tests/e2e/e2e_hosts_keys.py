"""End-to-end: config import + key upload + real terminal + gateway dial.

Drives the built app in Chromium with five network fakes, everything else
real (see run-e2e.sh):

  /config.js + GIS    stubbed exactly like .tmp/auth-review-capture.py does
                      for visual captures — a fake button that signs in via
                      the app's own callback.
  sync.e2e.test       a fake settings store: every body is captured by the
                      harness's HTTP log (and scanned there); the fake only
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
                       session) end to end. EVERY original text frame the
                       browser puts on this wire — the first/auth frame
                       included — is preserved verbatim by the fixture's
                       recorder and fed through the SAME wire-custody oracle
                       as the binary bytes and the HTTP captures (exact
                       surface rules + methods, Authorization headers, every
                       header value, bodies — see assert_url_custody,
                       assert_http_request_custody and the wire-level
                       assertions). Production-gateway
                       claims are made elsewhere or not at all.

The OSC 52 clipboard leg rides a REAL terminal: the folder-first workspace's
"Start a session here" -> Shell -> the shipping TerminalView xterm with its
registered OSC 52 handler, driven through the fixture's PTY (an aplexer
session on the helper fixture, which relays the escape verbatim — probed).

Usage: /usr/bin/python3 tests/e2e/e2e_hosts_keys.py <base-url> <workdir> <fixture-port> <container> <key-pub-path>
"""

import asyncio
import base64
import contextlib
import io
import json
import os
import subprocess
import sys
import time

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from playwright.async_api import async_playwright
from urllib.parse import parse_qsl, quote_plus, unquote, unquote_plus, urlsplit

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
# on EVERY surface (a private key riding a text frame is exactly the leak a
# binary-only scan misses; the gateway's first/auth TEXT frame is no
# exception). Each secret carries a LABEL for failure messages, so no
# receipt or assertion ever prints credential material itself. The OSC 52
# marker is deliberately NOT in it: that string is terminal payload the test
# itself puts on the wire (typed into the PTY), not a credential.
SECRET_LABELS = [
    (CANARY, 'the config canary'),
    (KEY_PASSPHRASE, 'the key passphrase'),
    (GOOGLE_TOKEN, 'the Google sign-in'),
    ('BEGIN OPENSSH PRIVATE KEY', 'a private-key marker'),
]


def decrypt_envelope(envelope: str, passphrase: str) -> str:
    """The desktop's SyncCrypto, test-side: same envelope, python runtime."""
    fields = json.loads(envelope)
    assert fields['v'] == 1 and fields['kdf'] == 'pbkdf2-sha256', (
        f'envelope fields: {sorted(fields)}; '
        f"v={safe_diag_text(repr(fields.get('v')))}, kdf={safe_diag_text(repr(fields.get('kdf')))}"
    )
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
    and ignored. Failure messages name the secret's LABEL, never the
    material itself."""
    joined = '\n'.join(texts)
    for secret, label in SECRET_LABELS:
        assert secret not in joined, f'{where}: {label} reached a TEXT frame'
    for secret, label in SECRET_LABELS:
        assert secret.encode() not in binary, f'{where}: {label} reached the binary wire'


def custody_negative_control() -> None:
    """Offline selftest: the oracle must REJECT a deliberately injected
    credential in every surface it claims to scan. If this ever stops
    failing-on-poison, the live custody assertions are decoration. This
    helper proves the oracle BITES — it is not itself the coverage; the live
    coverage is each real recording being fed through the same oracle."""
    for label, poisoned in (
        ('a private-key marker in a TEXT frame', {'binary': b'', 'texts': [f'{"x" * 40}BEGIN OPENSSH PRIVATE KEY{"y" * 40}']}),
        ('the key passphrase in the binary wire', {'binary': b'\x00\x01' + KEY_PASSPHRASE.encode(), 'texts': []}),
        ('the Google sign-in in a TEXT frame', {'binary': b'', 'texts': [f'auth token {GOOGLE_TOKEN}']}),
        ('the config canary in the binary wire', {'binary': CANARY.encode(), 'texts': []}),
    ):
        threw = False
        try:
            assert_wire_custody(poisoned['binary'], poisoned['texts'], 'negative-control')
        except AssertionError:
            threw = True
        assert threw, f'custody oracle FAILED to reject an injected credential ({label})'


def gateway_auth_negative_control() -> None:
    """Negative control through the REAL gateway recorder and extractor: the
    exact shape that once slipped past the parsed type/token assertions — a
    well-formed auth frame (correct type, device id, scoped token) carrying
    ONE extra field with forbidden material — must be preserved verbatim by
    the recorder and REJECTED by the custody scan. The scoped token itself
    stays allowed: the honest frame passes the same scan."""
    honest = {'type': 'auth', 'v': 1, 'device_id': GW_DEVICE, 'token': GW_TOKEN}
    passing = FakeGateway(0, GW_DEVICE, '')
    passing.record_text(json.dumps(honest))
    assert passing.every_text_frame() == [json.dumps(honest)], 'the recorder did not preserve the auth frame'
    assert_wire_custody(b'', passing.every_text_frame(), 'negative-control')  # the honest frame passes
    for secret, label in SECRET_LABELS:
        gw = FakeGateway(0, GW_DEVICE, '')
        poisoned = dict(honest, note=f'carry {secret}')
        gw.record_text(json.dumps(poisoned))
        assert gw.every_text_frame() == [json.dumps(poisoned)], 'the recorder did not preserve the poisoned frame'
        frame = json.loads(gw.every_text_frame()[0])
        # The poisoned frame IS a valid auth frame — type, device and token
        # all satisfy the contract assertions. Only the custody scan, fed
        # the recording, sees what the extra field carries.
        assert frame['type'] == 'auth' and frame['device_id'] == GW_DEVICE and frame['token'] == GW_TOKEN, frame
        threw = False
        try:
            assert_wire_custody(b'', gw.every_text_frame(), 'negative-control')
        except AssertionError:
            threw = True
        assert threw, f'gateway custody FAILED to reject a poisoned auth frame ({label} in an extra field)'


# --- fixture surfaces, as STRUCTURED rules -----------------------------------
#
# The Google sign-in's accepted placements, per the documented credential
# boundary (docs/gateway-client.md) and the app's LIVE request builders
# (src/api/sync.ts, src/api/gatewayToken.ts, src/terminal/connection.ts,
# pocketshell-core gatewayTransport.ts):
#
#   sync + broker (account surfaces)
#       https ONLY, exact host, effective port 443, an EXACT supported path,
#       an allowed method, NO query, NO fragment, NO userinfo, and the
#       sign-in ONLY as the exact `Authorization: Bearer <sign-in>` header —
#       never in the URL. The paths/methods below mirror the live
#       SyncService (GET /me, GET /settings, GET/PUT/DELETE /settings/{slot})
#       and the broker exchange (POST /gateway/token, empty body).
#   direct relay (legacy, documented exception)
#       EXACTLY wss://direct.e2e.test/pipe with the live dial's query shape —
#       `new URLSearchParams({host, port, token})`: those THREE fields, each
#       exactly once, the sign-in as the value of the ONE `token` field and
#       nowhere else in the URL. Any other scheme, port, path, param,
#       duplicate or placement refuses.
#   gateway
#       EXACTLY wss://gateway.e2e.test/api/v1/hosts/{device}/ssh — no query,
#       no fragment, no userinfo, and NONE of the Google sign-in anywhere
#       (its admission is the broker-scoped routing token, asserted on the
#       auth FRAME, never on the URL).
#
# A hostname alone is NOT origin authority: a URL that merely CONTAINS an
# account hostname in its path or query, a suffix-spoofed hostname, or an
# account hostname on the wrong scheme/port/path is not that surface and
# grants nothing. Every other origin (the app's own pages/assets, the GIS
# stub) carries no credential anywhere in its URL. No key/canary material
# rides ANY surface.
DIRECT_RELAY_HOST = 'direct.e2e.test'
SYNC_HOST = 'sync.e2e.test'
BROKER_HOST = 'gateway-broker.e2e.test'
GATEWAY_HOST = 'gateway.e2e.test'

ACCOUNT_SCHEME = 'https'
ACCOUNT_PORT = 443
# (host, exact path, allowed methods) — the live service's supported CRUD.
ACCOUNT_HTTP_SURFACES = (
    (SYNC_HOST, '/me', ('GET',)),
    (SYNC_HOST, '/settings', ('GET',)),
    (SYNC_HOST, '/settings/main', ('GET', 'PUT', 'DELETE')),
    (SYNC_HOST, '/settings/keys', ('GET', 'PUT', 'DELETE')),
    (BROKER_HOST, '/gateway/token', ('POST',)),
)
# The legacy direct-relay dial: the ONE URL exception, pinned to the exact
# origin, path and query shape the live code produces.
DIRECT_RELAY_DIAL = {
    'scheme': 'wss',
    'host': DIRECT_RELAY_HOST,
    'port': 443,
    'path': '/pipe',
    'query_keys': ('host', 'port', 'token'),
}
GATEWAY_DIAL = {
    'scheme': 'wss',
    'host': GATEWAY_HOST,
    'port': 443,
    'path': f'/api/v1/hosts/{GW_DEVICE}/ssh',
}

DEFAULT_PORTS = {'http': 80, 'https': 443, 'ws': 80, 'wss': 443}


def effective_port(parts) -> int | None:
    """The port an honest client would CONNECT to: explicit, else the
    scheme's default — `https://host/` and `https://host:443/` are the same
    origin, `https://host:444/` is not."""
    if parts.port is not None:
        return parts.port
    return DEFAULT_PORTS.get((parts.scheme or '').lower())


def _scrub(text: str) -> str:
    """A mention-safe rendering of an untrusted fragment: anything carrying
    credential material — raw OR in its single-pass decoded form (a
    reversibly percent/+-encoded secret is not redacted) — becomes
    <redacted>."""
    for secret, _ in SECRET_LABELS:
        if secret in text or secret in unquote_plus(text):
            return '<redacted>'
    return text


def safe_url(url: str) -> str:
    """The STRUCTURAL URL for failure messages: scheme/host scrubbed against
    the full secret set, port kept (digits), while path contents, query
    values, userinfo and fragment are WITHHELD (segment counts, scrubbed
    param names and presence flags only). A rejected secret can never be
    repeated by a diagnostic, wherever it hid."""
    try:
        parts = urlsplit(url)
        scheme = _scrub((parts.scheme or '?').lower())
        host = _scrub((parts.hostname or '<no-host>').lower())
        port = parts.port
        netloc = f'{host}:{port}' if port is not None else host
        segments = len([s for s in parts.path.split('/') if s])
        bits = [f'path: {segments} segment(s), withheld']
        if parts.username is not None or parts.password is not None:
            bits.append('userinfo PRESENT')
        if parts.query:
            names = sorted({_scrub(p.split('=', 1)[0]) or '<unnamed>' for p in parts.query.split('&')})
            bits.append(f'query params: {",".join(names)}')
        if parts.fragment:
            bits.append('fragment PRESENT')
        return f'{scheme}://{netloc} ({"; ".join(bits)})'
    except ValueError:
        return f'<unparsable URL: {len(url)} chars, withheld>'


def describe_authorization(authz: str) -> str:
    """Shape/length only — never an untrusted Authorization word or token."""
    if authz == f'Bearer {GOOGLE_TOKEN}':
        return 'the exact expected Bearer'
    if authz.startswith('Bearer '):
        return f'a Bearer with an unexpected credential (length {len(authz)})'
    if authz.strip() == '':
        return 'empty'
    return f'an unexpected shape (length {len(authz)})'


KNOWN_HTTP_METHODS = ('GET', 'PUT', 'POST', 'DELETE', 'HEAD', 'OPTIONS')


def describe_method(method: str) -> str:
    """A safe rendering of an untrusted method: the enum label for the
    methods the live builders send, shape/length only for anything else —
    a canary-bearing method is never echoed into a diagnostic (the policy's
    messages AND the live loop's `where` prefix go through this)."""
    if method in KNOWN_HTTP_METHODS:
        return method
    return f'an unexpected method (length {len(method)})'


# --- failure-output renderers -------------------------------------------------
#
# The custody policies' own messages are label-safe by construction; the SAME
# boundary now covers EVERY other failure output — diagnostic dumps, the final
# console verdict, connection-store diagnostics, structured assertion payloads
# and caught exceptions. Untrusted text is WITHHELD WHOLE when it carries any
# declared secret, raw or in its single-pass +- / percent-decoded form (the
# identical parser boundary the URL scans use — a reversibly encoded secret is
# not redacted away); otherwise it is kept, capped with an explicit withheld
# marker. No partial masking: a fragment either appears clean or disappears
# entirely. Captured wire/HTTP data itself stays raw in memory for the
# load-bearing custody verdicts — only these diagnostic renderings are safe.

DIAG_TEXT_CAP = 300     # per-fragment cap for free-text failure diagnostics
DIAG_BODY_CAP = 1500    # cap for the visible-body diagnostic dump


def _carries_secret(text: str) -> bool:
    return any(secret in text or secret in unquote_plus(text) for secret, _ in SECRET_LABELS)


def safe_diag_text(text: str, cap: int = DIAG_TEXT_CAP) -> str:
    """One untrusted free-text fragment (a console line, an app error, an
    exception message, page text) rendered for failure output."""
    if _carries_secret(text):
        return f'<redacted: withheld ({len(text)} chars)>'
    if len(text) > cap:
        return f'{text[:cap]}... [+{len(text) - cap} chars withheld]'
    return text


def safe_exc(exc: BaseException) -> str:
    """A caught exception for failure output: the type name always, the
    message only through safe_diag_text — a driver/API error string can
    embed a credential-bearing URL. Never a raw repr."""
    message = safe_diag_text(str(exc))
    return f'{type(exc).__name__}: {message}' if message else type(exc).__name__


def safe_repr_payload(obj) -> str:
    """A structured assertion payload (a parsed envelope, decrypted store
    objects, recorded frames) for failure output: withheld whole when its
    repr carries any declared secret, else kept capped."""
    return safe_diag_text(repr(obj), cap=2000)


def safe_console_payload(entries: list) -> list:
    """The final console verdict's payload: every captured console error
    through the same withheld-or-capped renderer — a sign-in that reached
    the console can never be repeated by the failure message."""
    return [safe_diag_text(entry) for entry in entries]


def assert_no_console_errors(entries: list) -> None:
    """The live final console verdict (was `assert len(console_errors) == 0,
    console_errors`): the same assertion, its payload now the safe
    rendering. The negative control drives THIS function, not a copy."""
    assert len(entries) == 0, safe_console_payload(entries)


def describe_connection_state(state: dict) -> str:
    """The connection store's diagnostic rendering: the state plus the
    scrubbed/capped error — an app error string can quote a refused URL."""
    error = state.get('error')
    return (
        f"state={safe_diag_text(str(state.get('state')))} "
        f"error={safe_diag_text('none' if error is None else str(error))}"
    )


def _parse_url(url: str, where: str):
    """urlsplit with malformed-port/host forms rejected up front (they are
    broken URLs, never honest surfaces)."""
    try:
        parts = urlsplit(url)
        _ = parts.port, parts.hostname
        return parts
    except ValueError:
        raise AssertionError(f'{where}: URL did not parse — withheld ({safe_url(url)})')


def _assert_exact_origin(parts, url: str, where: str, *, scheme: str, host: str, port: int,
                         path: str | None, allow_query: bool) -> None:
    """Pin scheme, host, EFFECTIVE port, (optionally exact) path and forbid
    userinfo/fragment — and query unless the rule allows one. Reasons are
    structural; the URL is rendered through safe_url only."""
    wrong = []
    if (parts.scheme or '').lower() != scheme:
        wrong.append(f'scheme is not {scheme}')
    if (parts.hostname or '').lower() != host:
        wrong.append(f'host is not {host}')
    if effective_port(parts) != port:
        wrong.append(f'effective port is not {port}')
    if path is not None and parts.path != path:
        wrong.append(f'path is not {path}')
    if parts.username is not None or parts.password is not None:
        wrong.append('userinfo present')
    if parts.fragment:
        wrong.append('fragment present')
    if not allow_query and parts.query:
        wrong.append('unexpected query')
    assert not wrong, (
        f'{where}: not the exact {scheme}://{host}:{port}{path or ""} surface '
        f'({"; ".join(wrong)}; {safe_url(url)})'
    )


def _assert_direct_relay_query(parts, url: str, where: str) -> None:
    """The legacy exception's exact query shape: the documented dial fields
    (host, port, token), each exactly once, the sign-in as the value of the
    ONE token field (equality-pinned — no other secret can sit there, and
    no declared secret is a substring of the sign-in). The exactly-once
    proof for every OTHER placement — raw and DECODED: any other field's
    name or value, the path, userinfo, fragment, host — is the decoded
    component scan in assert_url_custody; a raw whole-URL occurrence count
    cannot see an encoded second copy."""
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    keys = [k for k, _ in pairs]
    expected = list(DIRECT_RELAY_DIAL['query_keys'])
    key_names = ','.join(_scrub(k) or '<unnamed>' for k in keys) or 'none'
    assert sorted(keys) == sorted(expected), (
        f'{where}: the legacy relay dial query must be exactly {expected}, each once '
        f'(saw {len(keys)} param(s): {key_names}; {safe_url(url)})'
    )
    fields = dict(pairs)
    assert fields['host'] and fields['port'], f'{where}: the relay dial must carry nonempty host and port fields ({safe_url(url)})'
    assert fields['token'] == GOOGLE_TOKEN, (
        f'{where}: the relay token field is not the exact sign-in ({safe_url(url)})'
    )


def _url_scan_material(parts, url: str, direct: bool) -> list:
    """Every string the URL custody scan must inspect: the RAW serialized
    URL plus each DECODED component the URI parser actually exposes — host,
    userinfo user/password, path, the whole query string (single-pass
    percent-decode) and each DECODED query name/value (the form semantics
    parse_qsl/URLSearchParams implement: `+` for space plus percent
    escapes) — and the fragment. Yields (what, text, google_allowed):
    google_allowed marks the only entries the direct relay's ONE sign-in
    copy necessarily rides (the raw serialization and the query string
    contain the token field's equality-pinned value; the token VALUE entry
    itself is equality-asserted, and no other declared secret is a substring
    of the sign-in, so it needs no scan). Every OTHER entry — every decoded
    field value included — is scanned against the FULL secret set, so an
    encoded second copy in `host`, a path, userinfo or a fragment cannot
    hide. Single-pass decoding only, exactly what the actual parser exposes:
    no invented nested-decode guarantee."""
    material = [
        ('the raw URL', url, direct),
        ('the host', unquote(parts.hostname or ''), False),
    ]
    if parts.username is not None:
        material.append(('userinfo user', unquote(parts.username), False))
    if parts.password is not None:
        material.append(('userinfo password', unquote(parts.password), False))
    material.append(('the path', unquote(parts.path), False))
    if parts.query:
        material.append(('the query string', unquote(parts.query), direct))
        for i, (name, value) in enumerate(parse_qsl(parts.query, keep_blank_values=True), 1):
            label = _scrub(name) or '<unnamed>'
            material.append((f'the value of query field {i} ({label})', value, direct and name == 'token'))
            material.append((f'the name of query field {i} ({label})', name, False))
    if parts.fragment:
        material.append(('the fragment', unquote(parts.fragment), False))
    return material


def assert_url_custody(url: str, where: str) -> None:
    """The per-surface URL custody policy — the ONE structured policy the
    live HTTP request URLs, the direct-relay dial URLs and the gateway dial
    URLs all run through, and the negative controls with them:
      - the documented surfaces (direct relay, gateway, sync, broker) are
        pinned to their EXACT scheme/host/effective-port/path/query rules
        above — an account hostname on the wrong scheme, port or path is a
        refusal, not a match;
      - the ONLY credential placement on any URL is the Google sign-in as
        the ONE `token` field of the legacy direct relay's dial query;
      - everywhere else, no credential/canary may appear in ANY part of the
        URL — raw or DECODED: path, query names/values, fragment, userinfo
        or host (a +- or percent-encoded secret is still a secret)."""
    parts = _parse_url(url, where)
    host = (parts.hostname or '').lower()
    direct = host == DIRECT_RELAY_DIAL['host']
    if direct:
        _assert_exact_origin(
            parts, url, where,
            scheme=DIRECT_RELAY_DIAL['scheme'], host=DIRECT_RELAY_DIAL['host'],
            port=DIRECT_RELAY_DIAL['port'], path=DIRECT_RELAY_DIAL['path'],
            allow_query=True,
        )
        _assert_direct_relay_query(parts, url, where)
    elif host == GATEWAY_DIAL['host']:
        _assert_exact_origin(
            parts, url, where,
            scheme=GATEWAY_DIAL['scheme'], host=GATEWAY_DIAL['host'],
            port=GATEWAY_DIAL['port'], path=GATEWAY_DIAL['path'],
            allow_query=False,
        )
    elif host in {h for h, _, _ in ACCOUNT_HTTP_SURFACES}:
        # An account-surface attempt: the exact account origin must hold, and
        # the path must be one of the supported account paths.
        _assert_exact_origin(
            parts, url, where,
            scheme=ACCOUNT_SCHEME, host=host, port=ACCOUNT_PORT,
            path=None, allow_query=False,
        )
        supported = [p for h, p, _ in ACCOUNT_HTTP_SURFACES if h == host]
        assert parts.path in supported, (
            f'{where}: {host} path is not a supported account path '
            f'(supported: {", ".join(supported)}; {safe_url(url)})'
        )
    for what, text, google_allowed in _url_scan_material(parts, url, direct):
        for secret, label in SECRET_LABELS:
            if secret == GOOGLE_TOKEN and google_allowed:
                continue  # the direct relay's ONE token-field copy (rule above)
            assert secret not in text, f'{where}: {label} rode {what} ({safe_url(url)})'


def assert_http_request_custody(method: str, url: str, headers: dict, body: str, where: str,
                                header_entries: list | None = None) -> None:
    """The captured-HTTP policy — the ONE policy the live recorded-request
    loop and the negative controls both run through, for EVERY captured HTTP
    request (method, URL, headers, body):
      - the URL through assert_url_custody (exact surface rules + the one
        legacy relay exception, raw AND decoded components);
      - a request TO an account surface (exact origin AND path) must be an
        allowed method and carry the sign-in as the EXACT
        `Authorization: Bearer <sign-in>` — nothing else in that header;
      - every OTHER header value is scanned against the FULL secret set on
        every request, and the Authorization header of non-account requests
        is scanned against the full set too (only the exact account bearer
        is exempt — pinned by equality, so nothing can hide beside it);
      - header_entries, when the capture supplies the duplicate-preserving
        array (`headers_array`), are scanned exactly like dict headers, and
        a SECOND Authorization entry is refused — the exact-Bearer exception
        must not broaden to an unchecked second occurrence;
      - the body is scanned against the full secret set. The sync PUT
        envelopes stay ciphertext (shape-checked and decrypted in the live
        section) — no plaintext exception exists here.
    Untrusted method strings reach diagnostics only through describe_method;
    URLs only through safe_url."""
    assert_url_custody(url, where)
    parts = _parse_url(url, where)
    host = (parts.hostname or '').lower()
    surface = next(((h, p, methods) for h, p, methods in ACCOUNT_HTTP_SURFACES if h == host and p == parts.path), None)
    authz = next((v for k, v in headers.items() if k.lower() == 'authorization'), '')
    if header_entries is not None:
        authz_entry_values = [v for k, v in header_entries if k.lower() == 'authorization']
        assert len(authz_entry_values) <= 1, (
            f'{where}: {len(authz_entry_values)} Authorization header entries — the exact Bearer must be '
            f'the ONE Authorization header ({safe_url(url)})'
        )
    if surface is not None:
        surface_host, surface_path, methods = surface
        assert method in methods, (
            f'{where}: {describe_method(method)} is not a supported method for {surface_host} {surface_path} '
            f'(allowed: {", ".join(methods)}; {safe_url(url)})'
        )
        assert authz == f'Bearer {GOOGLE_TOKEN}', (
            f'{where}: Authorization was {describe_authorization(authz)}, '
            f'expected the exact Bearer ({safe_url(url)})'
        )
    else:
        assert GOOGLE_TOKEN not in authz, (
            f'{where}: the Google sign-in rode the Authorization header of a non-account request ({safe_url(url)})'
        )
    for key, value in list(headers.items()) + list(header_entries or []):
        if surface is not None and key.lower() == 'authorization':
            continue  # pinned to the EXACT bearer by the equality above
        name = _scrub(key)
        for secret, label in SECRET_LABELS:
            assert secret not in key, f'{where}: {label} rode a header NAME ({name}; {safe_url(url)})'
            assert secret not in value, f'{where}: {label} rode the {name} header ({safe_url(url)})'
    for secret, label in SECRET_LABELS:
        assert secret not in body, f'{where}: {label} left the browser in the body ({safe_url(url)})'


def _must_reject(what: str, fn) -> None:
    """Run fn; it MUST raise AssertionError (the policy refused)."""
    threw = False
    try:
        fn()
    except AssertionError:
        threw = True
    assert threw, f'custody policy FAILED to reject {what}'


def _must_accept(what: str, fn) -> None:
    """Run fn; it MUST NOT raise (the policy accepted a documented honest
    surface). The policy's own messages are label-safe, so echoing one here
    cannot leak credential material."""
    try:
        fn()
    except AssertionError as exc:
        raise AssertionError(f'custody policy wrongly rejected {what}: {exc}') from exc


def url_custody_negative_control() -> None:
    """The SAME live URL policy, fed every shape that must refuse: the frozen
    counterexamples (attacker URLs carrying an account hostname in path or
    query, a suffix-spoofed hostname, account/gateway URLs with the sign-in
    in their query) PLUS the exactness shapes — wrong scheme/port/path on the
    direct exception and the account surfaces, duplicate token placements
    (fragment, userinfo, a second field, an unexpected param), a missing
    token field, and a canary on the legacy relay — PLUS the encoded
    placements the raw-URL scan cannot see: +-encoded (URLSearchParams form
    semantics) and percent-encoded secrets in decoded field values, path,
    userinfo and fragment. The documented positives — the exact relay dial
    (any field order, explicit default port, honest encoding), every
    supported account path, and the clean gateway dial — must PASS."""
    rejected: list[str] = []
    honored: list[str] = []

    def fails(url: str, what: str) -> None:
        rejected.append(what)
        _must_reject(what, lambda: assert_url_custody(url, 'negative-control'))

    def passes(url: str, what: str) -> None:
        honored.append(what)
        _must_accept(what, lambda: assert_url_custody(url, 'negative-control'))

    enc_first = '%' + GOOGLE_TOKEN[0].encode().hex() + GOOGLE_TOKEN[1:]

    relay_q = 'host=127.0.0.1&port=22&token='
    # attacker shapes around the account hostnames (frozen counterexamples)
    fails(f'https://attacker.e2e.test/sync.e2e.test?c={GOOGLE_TOKEN}',
          'an attacker URL with an account hostname in its path')
    fails(f'https://attacker.e2e.test/?upstream=sync.e2e.test&c={GOOGLE_TOKEN}',
          'an attacker URL with an account hostname in its query')
    fails(f'https://sync.e2e.test.attacker.io/?c={GOOGLE_TOKEN}', 'a suffix-spoofed account hostname')
    fails(f'https://sync.e2e.test/me?token={GOOGLE_TOKEN}',
          'a sign-in token in an account URL query (Authorization-only surface)')
    fails(f'wss://gateway.e2e.test/api/v1/hosts/dev-e2e/ssh?token={GOOGLE_TOKEN}',
          'a sign-in token on the gateway surface')
    fails(f'wss://direct.e2e.test/pipe?host=127.0.0.1&key={CANARY}',
          'a canary on the legacy relay (the exception covers the sign-in only)')
    fails(f'https://sync.e2e.test/me?x={"x" * 20}BEGIN OPENSSH PRIVATE KEY',
          'a private-key marker in an account URL')
    # the direct-relay exception is EXACT: scheme, port, path, shape
    fails(f'http://direct.e2e.test/pipe?{relay_q}{GOOGLE_TOKEN}',
          'a plain-http scheme on the legacy relay dial')
    fails(f'wss://direct.e2e.test:444/pipe?{relay_q}{GOOGLE_TOKEN}',
          'an effective port other than 443 on the legacy relay dial')
    fails(f'wss://direct.e2e.test/untrusted?{relay_q}{GOOGLE_TOKEN}',
          'a path other than /pipe on the legacy relay dial')
    fails(f'wss://direct.e2e.test/pipe?{relay_q}{GOOGLE_TOKEN}#token={GOOGLE_TOKEN}',
          'a duplicate copy of the sign-in in the fragment')
    fails(f'wss://e2e:{GOOGLE_TOKEN}@direct.e2e.test/pipe?{relay_q}{GOOGLE_TOKEN}',
          'the sign-in in userinfo')
    fails(f'wss://direct.e2e.test/pipe?host=127.0.0.1&port=22&token={GOOGLE_TOKEN}&token={GOOGLE_TOKEN}',
          'a duplicated token field')
    fails(f'wss://direct.e2e.test/pipe?host=127.0.0.1&port=22&token={GOOGLE_TOKEN}&extra=1',
          'an unexpected query field on the legacy relay dial')
    fails(f'wss://direct.e2e.test/pipe?host=127.0.0.1&port=22&c={GOOGLE_TOKEN}',
          'the sign-in outside its token field')
    fails(f'wss://direct.e2e.test/pipe?host=127.0.0.1&port=22',
          'a relay dial without the token field')
    fails(f'wss://direct.e2e.test/leak/{GOOGLE_TOKEN}?host=127.0.0.1&port=22&token={GOOGLE_TOKEN}',
          'the sign-in in the relay dial path')
    # encoded placements are NOT hiding places: the decoded components and
    # every decoded query name/value are scanned (U1)
    fails(f'wss://direct.e2e.test/pipe?host={quote_plus("BEGIN OPENSSH PRIVATE KEY zz")}&port=22&token={GOOGLE_TOKEN}',
          'a +-encoded private-key marker in the relay host field')
    fails(f'wss://direct.e2e.test/pipe?host={enc_first}&port=22&token={GOOGLE_TOKEN}',
          'a percent-encoded SECOND sign-in in the relay host field')
    fails(f'wss://direct.e2e.test/pipe?host=127.0.0.1&port=22&token={GOOGLE_TOKEN}&c={enc_first}',
          'a percent-encoded second sign-in in an extra relay field')
    fails(f'https://attacker.e2e.test/x?c={quote_plus("BEGIN OPENSSH PRIVATE KEY zz")}',
          'a +-encoded private-key marker in an attacker query')
    fails(f'https://attacker.e2e.test/leak/{enc_first}',
          'a percent-encoded sign-in in an attacker path')
    fails(f'https://e2e:{enc_first}@attacker.e2e.test/',
          'a percent-encoded sign-in in attacker userinfo')
    fails(f'https://attacker.e2e.test/x#t={enc_first}',
          'a percent-encoded sign-in in an attacker fragment')
    # the account surfaces are EXACT too: scheme, effective port, path, no query
    fails('http://sync.e2e.test/me', 'a plain-http scheme on a sync surface')
    fails('https://sync.e2e.test:444/me', 'an effective port other than 443 on a sync surface')
    fails('https://sync.e2e.test/untrusted', 'an unsupported sync path')
    fails('https://sync.e2e.test/me?x=1', 'a query on a sync surface')
    fails('https://sync.e2e.test/me#frag', 'a fragment on a sync surface')
    fails('https://e2e@sync.e2e.test/me', 'userinfo on a sync surface')
    fails('http://gateway-broker.e2e.test/gateway/token', 'a plain-http scheme on the broker')
    fails('https://gateway-broker.e2e.test:8443/gateway/token', 'a wrong port on the broker')
    # the gateway dial is exact: no query, no other path
    fails('wss://gateway.e2e.test/api/v1/hosts/other-device/ssh', 'a gateway path for another device')
    fails('wss://gateway.e2e.test/evil', 'an unsupported gateway path')
    # the documented positives
    passes(f'wss://direct.e2e.test/pipe?{relay_q}{GOOGLE_TOKEN}',
           'the documented legacy direct-relay query token')
    passes(f'wss://direct.e2e.test/pipe?port=22&host=127.0.0.1&token={GOOGLE_TOKEN}',
           'the relay dial with its fields in any order')
    passes(f'wss://direct.e2e.test:443/pipe?{relay_q}{GOOGLE_TOKEN}',
           'the relay dial on the explicit default port')
    passes(f'wss://direct.e2e.test/pipe?host=127%2E0%2E0%2E1&port=22&token={GOOGLE_TOKEN}',
           'an honestly percent-encoded relay host field (decodes to the same host)')
    passes(f'wss://direct.e2e.test/pipe?host=127.0.0.1&port=%32%32&token={GOOGLE_TOKEN}',
           'an honestly percent-encoded relay port field')
    passes('https://sync.e2e.test/me', 'a clean sync /me URL')
    passes('https://sync.e2e.test/settings', 'a clean sync /settings URL')
    passes('https://sync.e2e.test/settings/main', 'a clean account URL')
    passes('https://sync.e2e.test/settings/keys', 'a clean keys-slot URL')
    passes('https://gateway-broker.e2e.test/gateway/token', 'a clean broker URL')
    passes('wss://gateway.e2e.test/api/v1/hosts/dev-e2e/ssh', 'a clean gateway URL')
    print(f'url custody control: {len(rejected)} rejects + {len(honored)} exact honest positives')


def http_custody_negative_control() -> None:
    """The SAME captured-HTTP policy, fed the recorded-request shapes that
    must refuse — method/scheme/port/path mismatches, wrong or missing
    Authorization, the sign-in outside the account surfaces, EVERY
    non-Google secret in the Authorization header and in ordinary headers
    (on attacker origins AND on the account surfaces), secrets in bodies,
    the +- / percent-encoded URL placements the raw scan cannot see, and a
    second Authorization header entry beside the exact Bearer — plus the
    documented honest surface of every live request builder (including one
    carried by a duplicate-preserving header array), which must PASS."""
    bearer = f'Bearer {GOOGLE_TOKEN}'
    rejected: list[str] = []
    honored: list[str] = []

    def fails(what: str, method: str, url: str, headers: dict, body: str = '', entries: list | None = None) -> None:
        rejected.append(what)
        _must_reject(what, lambda: assert_http_request_custody(method, url, headers, body, 'negative-control',
                                                               header_entries=entries))

    def passes(what: str, method: str, url: str, headers: dict, body: str = '', entries: list | None = None) -> None:
        honored.append(what)
        _must_accept(what, lambda: assert_http_request_custody(method, url, headers, body, 'negative-control',
                                                               header_entries=entries))

    def bearer_headers(**extra):
        return {'authorization': bearer, **extra}

    enc_first = '%' + GOOGLE_TOKEN[0].encode().hex() + GOOGLE_TOKEN[1:]

    # --- the documented honest surfaces (the live code's exact calls) -----
    passes('GET /me with the exact Bearer', 'GET', 'https://sync.e2e.test/me', bearer_headers(accept='application/json'))
    passes('GET /me with the exact Bearer (duplicate-preserving array)', 'GET', 'https://sync.e2e.test/me',
           bearer_headers(), entries=[('Authorization', bearer), ('accept', 'application/json')])
    passes('GET /settings/main with the exact Bearer', 'GET', 'https://sync.e2e.test/settings/main', bearer_headers())
    passes('PUT /settings/main envelope', 'PUT', 'https://sync.e2e.test/settings/main',
           bearer_headers(**{'content-type': 'application/json'}), '{"data":"<envelope>","version":1}')
    passes('PUT /settings/keys envelope', 'PUT', 'https://sync.e2e.test/settings/keys',
           bearer_headers(**{'content-type': 'application/json'}), '{"data":"<envelope>","version":0}')
    passes('DELETE /settings/main', 'DELETE', 'https://sync.e2e.test/settings/main', bearer_headers())
    passes('the broker exchange: POST /gateway/token, empty body, exact Bearer',
           'POST', 'https://gateway-broker.e2e.test/gateway/token', {'authorization': bearer})
    passes('the app origin', 'GET', 'http://localhost:4173/config.js', {})
    passes('a page navigation on the app origin', 'GET', 'http://localhost:4173/host/manualbox', {})
    passes('the GIS client script', 'GET', 'https://accounts.google.com/gsi/client', {})
    # --- surface exactness through the captured-HTTP policy ---------------
    fails('the Google bearer on a plain-http sync surface', 'GET', 'http://sync.e2e.test/me', bearer_headers())
    fails('the Google bearer on a wrong-port sync surface', 'GET', 'https://sync.e2e.test:444/me', bearer_headers())
    fails('the Google bearer on an unsupported sync path', 'GET', 'https://sync.e2e.test/untrusted', bearer_headers())
    fails('an unsupported method on /me', 'DELETE', 'https://sync.e2e.test/me', bearer_headers())
    fails('POST is not a sync method', 'POST', 'https://sync.e2e.test/settings/main', bearer_headers(), '{}')
    fails('GET is not the broker method', 'GET', 'https://gateway-broker.e2e.test/gateway/token', bearer_headers())
    fails('a sync surface without the Authorization header', 'GET', 'https://sync.e2e.test/me', {})
    fails('a wrong credential on a sync surface', 'GET', 'https://sync.e2e.test/me', {'authorization': 'Bearer someone-elses-token'})
    fails('the sign-in in userinfo through the HTTP policy', 'GET', f'https://e2e:{GOOGLE_TOKEN}@sync.e2e.test/me', bearer_headers())
    fails('the sign-in in a fragment through the HTTP policy', 'GET', f'https://sync.e2e.test/me#token={GOOGLE_TOKEN}', bearer_headers())
    # --- the sign-in must never leave the account surfaces ----------------
    fails('the sign-in in the Authorization header of a non-account request',
          'GET', 'https://attacker.e2e.test/x', bearer_headers())
    # --- EVERY non-Google secret, in EVERY header placement ---------------
    for secret, label in ((CANARY, 'the config canary'), (KEY_PASSPHRASE, 'the key passphrase'),
                          ('BEGIN OPENSSH PRIVATE KEY', 'a private-key marker'), (GOOGLE_TOKEN, 'the Google sign-in')):
        fails(f'{label} in the Authorization header of an attacker request',
              'GET', 'https://attacker.e2e.test/x', {'authorization': f'Bearer {secret}'})
        fails(f'{label} in an ordinary header of an attacker request',
              'GET', 'https://attacker.e2e.test/x', {'x-exfil': secret})
        fails(f'{label} in an ordinary header of an account-surface request',
              'GET', 'https://sync.e2e.test/me', bearer_headers(**{'x-trace': secret}))
    # --- bodies ------------------------------------------------------------
    fails('the canary in a request body', 'POST', 'https://attacker.e2e.test/x', {}, f'leak {CANARY}')
    fails('the sign-in in a request body', 'POST', 'https://attacker.e2e.test/x', {}, f'token={GOOGLE_TOKEN}')
    fails('the key passphrase in a sync PUT body', 'PUT', 'https://sync.e2e.test/settings/main',
          bearer_headers(**{'content-type': 'application/json'}), f'{{"data":"{KEY_PASSPHRASE}"}}')
    # --- encoded URL placements (U1) through the SAME policy ---------------
    fails('a +-encoded private-key marker in an attacker query', 'GET',
          f'https://attacker.e2e.test/x?c={quote_plus("BEGIN OPENSSH PRIVATE KEY zz")}', {})
    fails('a percent-encoded sign-in in an attacker query value', 'GET',
          f'https://attacker.e2e.test/x?c={enc_first}', {})
    fails('a percent-encoded sign-in in an attacker path', 'GET',
          f'https://attacker.e2e.test/leak/{enc_first}', {})
    fails('a percent-encoded sign-in in attacker userinfo', 'GET',
          f'https://e2e:{enc_first}@attacker.e2e.test/', {})
    fails('a percent-encoded sign-in in an attacker fragment', 'GET',
          f'https://attacker.e2e.test/x#t={enc_first}', {})
    fails('a +-encoded private-key marker on the relay dial through the HTTP policy', 'GET',
          f'wss://direct.e2e.test/pipe?host={quote_plus("BEGIN OPENSSH PRIVATE KEY zz")}&port=22&token={GOOGLE_TOKEN}',
          {})
    # --- duplicate Authorization entries in the capture array ---------------
    fails('a second Authorization entry beside the exact Bearer', 'GET',
          'https://sync.e2e.test/me', bearer_headers(),
          entries=[('authorization', bearer), ('Authorization', f'Bearer {CANARY}')])
    fails('a duplicated Authorization entry on a non-account origin', 'GET',
          'https://attacker.e2e.test/x', {},
          entries=[('authorization', f'Bearer {GOOGLE_TOKEN}'), ('authorization', 'x')])
    print(f'captured-HTTP control: {len(rejected)} rejects + {len(honored)} documented honest surfaces')


async def diagnostics_negative_control() -> None:
    """The failure DIAGNOSTICS must never repeat the rejected credential —
    raw OR in its reversible encoded forms: feed the policies inputs
    poisoned in every placement (path, userinfo, fragment, query value,
    query NAME, host, Authorization — +-encoded and percent-encoded
    included) and scan the raised messages — and the
    safe_url/describe_authorization/describe_method renderings — for EVERY
    declared secret (and the +-encoded marker form). The ACTUAL broker
    handler and the ACTUAL live caller-context construction are driven too:
    a rejected broker URL / unsupported method must surface with safe
    diagnostics (the frozen faf4ac9 handler echoed the whole token-bearing
    URL; the method rule and the live `where` prefix echoed a canary-bearing
    method)."""
    enc_first = '%' + GOOGLE_TOKEN[0].encode().hex() + GOOGLE_TOKEN[1:]
    probes = tuple(s for s, _ in SECRET_LABELS) + ('BEGIN+OPENSSH+PRIVATE+KEY',)
    poisons = [
        f'https://attacker.e2e.test/leak/{GOOGLE_TOKEN}?x={CANARY}',
        f'https://e2e:{GOOGLE_TOKEN}@attacker.e2e.test/',
        f'https://attacker.e2e.test/x#{CANARY}',
        f'https://attacker.e2e.test/?{KEY_PASSPHRASE}=1',
        f'https://{GOOGLE_TOKEN}.attacker.io/',
        f'wss://e2e:{GOOGLE_TOKEN}@direct.e2e.test/leak/{CANARY}#{KEY_PASSPHRASE}',
        f'https://attacker.e2e.test/x?c={quote_plus("BEGIN OPENSSH PRIVATE KEY zz")}',
        f'https://attacker.e2e.test/leak/{enc_first}',
        f'https://e2e:{enc_first}@attacker.e2e.test/',
        f'https://attacker.e2e.test/?{enc_first}=1',
        f'wss://direct.e2e.test/pipe?host={enc_first}&port=22&token={GOOGLE_TOKEN}',
    ]
    for url in poisons:
        rendered = safe_url(url)
        for probe in probes:
            assert probe not in rendered, f'safe_url echoed a secret placement for a poisoned URL'
        threw = False
        try:
            assert_url_custody(url, 'diagnostics-probe')
        except AssertionError as exc:
            threw = True
            message = str(exc)
            for probe in probes:
                assert probe not in message, f'the URL-policy failure message echoed a secret placement'
        assert threw, 'the URL policy accepted a poisoned URL (diagnostics probe could not run)'
    for authz in (f'Bearer {CANARY}', f'Bearer {GOOGLE_TOKEN} extra {KEY_PASSPHRASE}', CANARY, f'token={GOOGLE_TOKEN}'):
        rendered = describe_authorization(authz)
        for secret, label in SECRET_LABELS:
            assert secret not in rendered, f'describe_authorization echoed {label}'
    for method in ('GET-' + CANARY, CANARY, f'GET {CANARY}'):
        rendered = describe_method(method)
        assert CANARY not in rendered, 'describe_method echoed the canary-bearing method'
        assert rendered in KNOWN_HTTP_METHODS or 'length' in rendered, rendered
    poisoned_requests = [
        ('GET', f'https://sync.e2e.test/me?x={GOOGLE_TOKEN}', {}, ''),
        ('GET', f'https://sync.e2e.test/leak/{KEY_PASSPHRASE}', {}, ''),
        ('GET', 'https://attacker.e2e.test/x', {'authorization': f'Bearer {CANARY}'}, ''),
        ('GET', 'https://attacker.e2e.test/x', {f'x-{CANARY}': KEY_PASSPHRASE}, ''),
        ('PUT', 'https://sync.e2e.test/settings/main', {'authorization': f'Bearer {GOOGLE_TOKEN}'}, CANARY),
        ('GET', f'wss://direct.e2e.test/wrong?token={GOOGLE_TOKEN}#{GOOGLE_TOKEN}', {}, ''),
        ('GET-' + CANARY, 'https://sync.e2e.test/me', {'authorization': f'Bearer {GOOGLE_TOKEN}'}, ''),
        ('GET', 'https://attacker.e2e.test/x', {}, f'body {GOOGLE_TOKEN}'),
    ]
    for method, url, headers, body in poisoned_requests:
        threw = False
        try:
            assert_http_request_custody(method, url, headers, body, f'HTTP {describe_method(method)}')
        except AssertionError as exc:
            threw = True
            message = str(exc)
            for probe in probes:
                assert probe not in message, 'the captured-HTTP failure message echoed a secret placement'
        assert threw, 'the captured-HTTP policy accepted a poisoned request (diagnostics probe could not run)'
    # the ACTUAL broker handler: a rejected URL surfaces WITHOUT echoing the
    # token (the handler's own assertions are the raise path), and the
    # honest exchange still fulfills with the scoped token.
    fulfilled: dict = {}

    class _BrokerReq:
        method = 'POST'
        url = f'https://gateway-broker.e2e.test/gateway/token?c={GOOGLE_TOKEN}'
        post_data = ''

        async def header_value(self, name):
            return f'Bearer {GOOGLE_TOKEN}'

    class _HonestReq:
        method = 'POST'
        url = 'https://gateway-broker.e2e.test/gateway/token'
        post_data = ''

        async def header_value(self, name):
            return f'Bearer {GOOGLE_TOKEN}'

    class _BrokerRoute:
        def __init__(self, req):
            self.request = req

        async def fulfill(self, **kw):
            fulfilled.update(kw)

    threw = False
    try:
        await handle_broker(_BrokerRoute(_BrokerReq()))
    except AssertionError as exc:
        threw = True
        message = str(exc)
        for probe in probes:
            assert probe not in message, 'the broker handler echoed a secret placement'
    assert threw, 'the broker handler accepted a token-bearing URL (diagnostics probe could not run)'
    await handle_broker(_BrokerRoute(_HonestReq()))
    assert json.loads(fulfilled['body'])['token'] == GW_TOKEN, 'the honest broker exchange did not fulfill'
    print('diagnostics control: every rejection renders label-safe, the broker handler and the live '
          'where= construction included')


class _RequestShape:
    """A request-shaped fixture for the offline capture controls: the OLD
    `.headers` property view (documented incomplete — security/cookie-related
    headers can be absent from it) is benign, while the COMPLETE async API —
    `await all_headers()` (full merged map) and `await headers_array()`
    (complete, duplicates preserved, original casing) — carries the real
    material. Same shapes as the live Playwright Request object."""

    def __init__(self, prop_headers: dict, full_headers: dict, entries: list | None = None,
                 delay: float = 0.0, fail: bool = False,
                 fail_message: str = 'the complete-header read failed (fixture)'):
        self.method = 'GET'
        self.url = 'https://attacker.e2e.test/x'
        self.post_data = None
        self._prop = prop_headers
        self._full = full_headers
        self._entries = entries
        self._delay = delay
        self._fail = fail
        self._fail_message = fail_message

    @property
    def headers(self) -> dict:
        return dict(self._prop)

    async def all_headers(self) -> dict:
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._fail:
            raise RuntimeError(self._fail_message)
        return dict(self._full)

    async def headers_array(self) -> list:
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._fail:
            raise RuntimeError(self._fail_message)
        return list(self._entries if self._entries is not None
                    else [{'name': k, 'value': v} for k, v in self._full.items()])


async def capture_request(req) -> dict:
    """The ACTUAL capture path behind the page's 'request' event: the
    COMPLETE header map — `req.headers` is the documented-incomplete
    property view, so a secret riding a security/cookie header would be
    invisible to it — plus the duplicate-preserving header array, both
    AWAITED here. The returned record is the ONLY thing the custody verdict
    scans; a capture that fails or never lands must fail the run through
    gather_captures, never silently shrink the scan."""
    full = await req.all_headers()
    entries = await req.headers_array()
    return {
        'method': req.method,
        'url': req.url,
        'headers': dict(full),
        'header_entries': [(e['name'], e['value']) for e in entries],
        'body': req.post_data or '',
    }


async def gather_captures(tasks: list, timeout: float = 60.0) -> list:
    """EVERY header capture must COMPLETE before the custody verdict or
    browser teardown: the results are awaited (a slow complete-header read
    is waited on, not skipped) and a failed read PROPAGATES — an unfinished
    or failed capture can never green the run. The propagated failure keeps
    its TYPE but carries the scrubbed rendering: a driver API error string
    can embed a captured request's credential-bearing URL, and this
    exception is what reaches the final traceback."""
    results = await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout)
    failed = [r for r in results if isinstance(r, BaseException)]
    if failed:
        reason = safe_exc(failed[0])
        try:
            raise type(failed[0])(reason) from None
        except TypeError:
            raise RuntimeError(reason) from None
    return results


async def capture_path_negative_control() -> None:
    """The capture gap and its repair, through the ACTUAL capture function,
    the ACTUAL gather and the ONE shared HTTP policy (no browser needed):
      - the old property view is benign while the complete map carries a
        forbidden Cookie value — the real capture must record it and the
        same live policy must refuse it;
      - a DELAYED complete-header read: the verdict waits for it via
        gather_captures and the record lands complete;
      - a FAILED read propagates — an unfinished or failed capture cannot
        green the run;
      - a SECOND Authorization entry in the duplicate-preserving array is
        refused: the exact-Bearer exception must not broaden to an
        unchecked occurrence, and the honest single-entry array still
        passes."""
    benign = {'user-agent': 'benign', 'accept': '*/*'}
    poisoned_cookie = {**benign, 'cookie': f'sid={CANARY}'}
    # calibration: the OLD shape is exactly what missed it
    shape = _RequestShape(benign, poisoned_cookie)
    old_view = dict(shape.headers)
    assert 'cookie' not in old_view and CANARY not in json.dumps(old_view), \
        'calibration broke: the old property view already shows the cookie header'
    record = await capture_request(shape)
    assert record['headers'].get('cookie') == f'sid={CANARY}', 'the complete capture missed the cookie header'
    assert [(k, v) for k, v in record['header_entries'] if k == 'cookie'] == [('cookie', f'sid={CANARY}')], \
        'the duplicate-preserving array missed the cookie header'
    _must_reject(
        'a canary riding a Cookie header only the COMPLETE capture sees',
        lambda: assert_http_request_custody(record['method'], record['url'], record['headers'],
                                            record['body'], 'negative-control',
                                            header_entries=record['header_entries']),
    )
    # a delayed complete-header read: the verdict WAITS, the record lands
    delayed = asyncio.ensure_future(capture_request(_RequestShape(benign, poisoned_cookie, delay=0.3)))
    landed = await gather_captures([delayed])
    assert delayed.done(), 'gather_captures returned before the delayed capture completed'
    assert len(landed) == 1 and landed[0]['headers'].get('cookie') == f'sid={CANARY}', \
        'the delayed capture was not awaited to completion'
    # a failed read propagates: a failed capture cannot green the run
    failing = asyncio.ensure_future(capture_request(_RequestShape(benign, poisoned_cookie, fail=True)))
    failed = False
    try:
        await gather_captures([failing])
    except RuntimeError:
        failed = True
    assert failed and failing.done(), 'a failed header capture did not propagate'
    # duplicate Authorization entries: the exception must not broaden
    dup = [('authorization', f'Bearer {GOOGLE_TOKEN}'),
           ('Authorization', f'Bearer {CANARY}')]
    _must_reject(
        'a second Authorization header entry beside the exact Bearer',
        lambda: assert_http_request_custody('GET', 'https://sync.e2e.test/me',
                                            {'authorization': f'Bearer {GOOGLE_TOKEN}'}, '',
                                            'negative-control', header_entries=dup),
    )
    _must_accept(
        'the exact Bearer as the ONE duplicate-preserving array entry',
        lambda: assert_http_request_custody('GET', 'https://sync.e2e.test/me',
                                            {'authorization': f'Bearer {GOOGLE_TOKEN}'}, '',
                                            'negative-control',
                                            header_entries=[('Authorization', f'Bearer {GOOGLE_TOKEN}')]),
    )
    print('capture-path control: complete-header capture + gather + duplicate-Authorization refusal all bite')


def clear_ack_reached(terminal_text: str, ack: str) -> bool:
    """True only when the ack appears as a STANDALONE terminal line — the
    command's OUTPUT. The typed command's echo carries the ack token only
    inside shell quotes (`echo 'e2e-clear''-ack-…'`), so no echoed row can
    equal the token, and the whole-line comparison rejects any row that
    merely CONTAINS it (a wrapped prompt line, a mention in other output)."""
    lines = terminal_text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    return any(line.strip() == ack for line in lines)


def osc52_clear_ack_negative_control() -> None:
    """The CLEAR leg's acknowledgment matcher, fed the shapes that must NOT
    satisfy it: a prompt/echo row carrying the token mid-line (what a wrapped
    echo would look like), a row merely mentioning it, and unrelated output.
    Only the command's own output line satisfies it."""
    ack = f'e2e-clear-ack-{os.urandom(4).hex()}'
    for text, what in (
        (f'testuser@fixture:~$ printf ..; echo {ack}\n', 'the echoed command line'),
        (f'earlier output mentioning {ack} mid-sentence\n', 'a row merely containing the token'),
        ('unrelated output\n', 'an unrelated terminal'),
    ):
        assert not clear_ack_reached(text, ack), f'the ack matcher was satisfied by {what}'
    assert clear_ack_reached(f'$ prompt\r\n{ack}\r\nnext', ack), 'the ack matcher missed real command output'


class FakeSync:
    """The settings API as the real one behaves: PER-SLOT opaque blobs, each
    with its own version — `main` (the host list) and `keys` (the roaming
    credential envelope) are independent slots, so one slot's writes never
    advance the other's base version."""

    def __init__(self):
        self.versions = {'main': 0, 'keys': 0}
        self.data = {'main': None, 'keys': None}
        self.put_bodies: list[dict] = []

    def _slot(self, url: str) -> str | None:
        for name in ('main', 'keys'):
            if url.endswith(f'/settings/{name}'):
                return name
        return None

    async def handle(self, route):
        req = route.request
        body = req.post_data or ''
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
                print(f'--- pipe: TCP CONNECT FAILED: {safe_exc(e)}')

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
    binary only, ferried to the fixture's real sshd. EVERY original text
    frame — the first/auth frame included — is preserved verbatim by the
    recorder and fed through the SAME custody oracle as the binary bytes
    (the old recording lost the auth frame into the handshake future, so a
    credential smuggled in an extra auth field was recorded and ignored);
    the auth frame is additionally asserted to carry EXACTLY the expected
    routing token."""

    def __init__(self, fixture_port: int, device_id: str, host_key_line: str):
        self.fixture_port = fixture_port
        self.device_id = device_id
        self.host_key_line = host_key_line
        self.dials = 0
        self.urls: list[str] = []
        self.auth_frames: list[dict] = []
        self.text_frames: list[str] = []
        self.text_after_ready: list[str] = []
        self.pipes: list[_TcpPipe] = []
        self.ready_sent = 0

    def record_text(self, payload: str) -> None:
        """The recorder, shared by the live socket handler and the negative
        control: EVERY original text frame is preserved verbatim, in arrival
        order — the first/auth frame included."""
        self.text_frames.append(payload)

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
                self.record_text(payload)
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
        """The EXACT recording the custody oracle scans — every original
        text frame as received, the auth frame included."""
        return list(self.text_frames)


async def handle_broker(route):
    """POST /gateway/token under the real contract: EMPTY body, the Google
    sign-in ONLY as the Authorization bearer, a scoped short-lived token back."""
    req = route.request
    assert req.method == 'POST' and req.url.endswith('/gateway/token'), (
        f'the broker route is POST /gateway/token '
        f'(method: {describe_method(req.method)}; {safe_url(req.url)})'
    )
    assert (req.post_data or '') == '', 'the broker exchange must send an empty body'
    authz = (await req.header_value('authorization')) or ''
    assert authz == f'Bearer {GOOGLE_TOKEN}', (
        f'broker saw an unexpected Authorization header '
        f'(shape: {describe_authorization(authz)})'
    )
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
    last_note = safe_exc(last) if isinstance(last, BaseException) else 'none'
    raise AssertionError(f'timed out waiting for {what} (last probe error: {last_note})')


async def clipboard_equals(page, expected: str, timeout: float = 12.0) -> None:
    async def read() -> bool:
        return await page.evaluate('navigator.clipboard.readText()') == expected

    await wait_for(read, timeout, f'clipboard to become {expected!r}')


async def wait_for_terminal_line(page, ack: str, timeout: float = 15.0) -> None:
    """Wait for the ack to appear as a STANDALONE line in the real xterm
    buffer — the command's output, not the echoed typed input (see
    clear_ack_reached). The xterm DOM renderer keeps the viewport rows in
    .xterm-rows under .xterm-screen."""
    async def read() -> bool:
        text = await page.locator('.xterm-screen').inner_text()
        return clear_ack_reached(text, ack)

    await wait_for(read, timeout, f'the clear-attempt acknowledgment {ack!r} to appear as real terminal output')


# Failure diagnostics: the flow's page + console errors, dumped when the run
# dies mid-flow so a stalled selector names what the app was actually showing.
# Every untrusted field is rendered through the SAME withheld-or-capped
# boundary as the custody diagnostics (safe_url / safe_diag_text): the page
# URL structurally, console/body/error text withheld whole when it carries
# any declared secret. Each read is attempted and collected INDEPENDENTLY —
# one failed read is reported through safe_exc (never a raw repr), can
# neither mask the original failure nor skip the remaining reads. The
# screenshot PNG is written unchanged but is an UNREDACTED artifact by
# explicit scope: the no-credential claim covers text/log output only;
# image-artifact handling is reviewed separately.
PAGE = None
CONSOLE_ERRORS: list[str] = []


async def dump_diagnostics() -> None:
    try:
        try:
            print(f'--- failure diagnostics: url={safe_url(PAGE.url)}')
        except Exception as e:  # noqa: BLE001 - each read is collected independently
            print(f'--- failure diagnostics: url read failed ({safe_exc(e)})')
        try:
            print(f'--- console errors ({len(CONSOLE_ERRORS)}) ---')
            for entry in CONSOLE_ERRORS:
                print(f'  {safe_diag_text(entry)}')
        except Exception as e:  # noqa: BLE001
            print(f'--- console errors: render failed ({safe_exc(e)})')
        shot = os.path.abspath('e2e-failure.png')
        try:
            await PAGE.screenshot(path=shot)
            print(f'--- screenshot (unredacted artifact, outside the text policy): {shot}')
        except Exception as e:  # noqa: BLE001
            print(f'--- screenshot failed ({safe_exc(e)})')
        try:
            text = await PAGE.inner_text('body')
            print('--- visible text (capped; withheld whole when it carries a declared secret) ---')
            print(safe_diag_text(text, cap=DIAG_BODY_CAP))
        except Exception as e:  # noqa: BLE001
            print(f'--- visible text: read failed ({safe_exc(e)})')
    except Exception as e:  # noqa: BLE001 - diagnostics must never mask the error
        print(f'(diagnostics unavailable: {safe_exc(e)})')


async def failure_dump_negative_control() -> None:
    """The FAILURE-DUMP path must be credential-safe too, through the ACTUAL
    functions (request-free fake objects, no browser — the RED for the frozen
    e6 dump echoed every placement offline the same way):
      - dump_diagnostics with a POISONED fake page (the direct-relay dial URL
        carrying the sign-in; console entries and visible body text with raw,
        +-encoded and percent-encoded placements) must print useful
        STRUCTURED diagnostics — the scrubbed URL shape, the console count,
        the withheld-with-counts body, the screenshot line — and no declared
        secret raw or ordinarily encoded;
      - a diagnostic read that FAILS with a secret-bearing exception is
        reported through the safe rendering (type name + withheld message),
        neither masks the dump nor skips the remaining reads;
      - an HONEST page keeps its diagnostics verbatim (capped) — withholding
        is not blanket;
      - the ACTUAL final console verdict function (the one main() calls)
        refuses poisoned console errors through a payload echoing no secret
        and passes a clean run;
      - the ACTUAL connection-store diagnostic rendering withholds a
        poisoned refusal while an honest error stays readable;
      - a capture failure whose exception message carries a secret lands
        SCRUBBED at the gather boundary, still failing the run."""
    global PAGE, CONSOLE_ERRORS
    enc_first = '%' + GOOGLE_TOKEN[0].encode().hex() + GOOGLE_TOKEN[1:]
    plus_form = 'BEGIN+OPENSSH+PRIVATE+KEY'
    probes = tuple(s for s, _ in SECRET_LABELS) + (plus_form, enc_first)

    class _DumpPage:
        def __init__(self, url: str, body: str, url_raises: Exception | None = None,
                     body_raises: Exception | None = None):
            self._url, self._body = url, body
            self._url_raises, self._body_raises = url_raises, body_raises
            self.shots: list[str] = []

        @property
        def url(self):
            if self._url_raises is not None:
                raise self._url_raises
            return self._url

        async def screenshot(self, path=None):
            self.shots.append(path)

        async def inner_text(self, selector):
            if self._body_raises is not None:
                raise self._body_raises
            assert selector == 'body'
            return self._body

    def scan(text: str, what: str) -> None:
        for probe in probes:
            assert probe not in text, f'{what} echoed a declared secret'

    old_page, old_console = PAGE, list(CONSOLE_ERRORS)
    try:
        # the poisoned dump: every placement carries a different declared
        # secret, encoded forms included
        poisoned_console = [
            f'uncaught token={GOOGLE_TOKEN}',
            f'console err {CANARY}',
            f'key {quote_plus("BEGIN OPENSSH PRIVATE KEY zz")}',
            f'enc {enc_first}',
        ]
        page = _DumpPage(
            f'wss://direct.e2e.test/pipe?host=127.0.0.1&port=22&token={GOOGLE_TOKEN}',
            f'visible {CANARY} body {KEY_PASSPHRASE} {plus_form} {enc_first}',
        )
        PAGE, CONSOLE_ERRORS = page, poisoned_console
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            await dump_diagnostics()
        out = buf.getvalue()
        scan(out, 'the poisoned failure dump')
        # useful structured diagnostics survived the withholding
        assert 'wss://direct.e2e.test' in out and 'query params: host,port,token' in out, out
        assert 'path: 1 segment(s)' in out, out
        assert '--- console errors (4) ---' in out, out
        assert '<redacted: withheld (' in out, out  # the poisoned body, withheld whole
        assert '--- screenshot (unredacted artifact' in out and len(page.shots) == 1, out
        # no CONSOLE entry is kept when it carries a secret — all four withheld
        assert out.count('<redacted: withheld (') >= 5, out

        # a diagnostic read failing with a secret-bearing exception: type +
        # withheld message, later reads still collected
        failing = _DumpPage('https://sync.e2e.test/me', '', body_raises=RuntimeError(f'body read failed for {CANARY}'))
        PAGE, CONSOLE_ERRORS = failing, []
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            await dump_diagnostics()
        out = buf.getvalue()
        scan(out, 'the read-failure dump')
        assert 'visible text: read failed (RuntimeError: <redacted' in out, out
        assert CANARY not in out, 'the read-failure message leaked its secret'
        assert '--- screenshot (unredacted artifact' in out and len(failing.shots) == 1, out
        assert 'url=https://sync.e2e.test' in out, out

        # the honest page: diagnostics stay USEFUL — nothing is blanket-withheld
        honest = _DumpPage('https://sync.e2e.test/settings/main', 'No hosts synced yet — all nominal')
        PAGE, CONSOLE_ERRORS = honest, ['first pull is a legitimate 404']
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            await dump_diagnostics()
        out = buf.getvalue()
        scan(out, 'the honest dump')
        assert 'https://sync.e2e.test' in out and 'No hosts synced yet — all nominal' in out, out
        assert 'first pull is a legitimate 404' in out, out

        # the ACTUAL final console verdict function, poisoned and clean
        poisoned_entries = [f'uncaught token={GOOGLE_TOKEN}', f'console {CANARY}', plus_form]
        threw, message = False, ''
        try:
            assert_no_console_errors(poisoned_entries)
        except AssertionError as exc:
            threw, message = True, str(exc)
        assert threw, 'the final console verdict accepted console errors'
        scan(message, 'the final console verdict payload')
        rendered = safe_console_payload(poisoned_entries)
        assert len(rendered) == 3 and all(r.startswith('<redacted: withheld') for r in rendered), rendered
        assert_no_console_errors([])  # the clean run passes
        assert safe_console_payload(['benign console line']) == ['benign console line']

        # the ACTUAL connection-store rendering, poisoned and honest
        poisoned_store = {
            'error': f'dial refused wss://direct.e2e.test/pipe?token={GOOGLE_TOKEN} {CANARY}',
            'state': 'idle',
        }
        rendered = describe_connection_state(poisoned_store)
        scan(rendered, 'the connection-store diagnostic')
        assert 'state=idle' in rendered and '<redacted: withheld' in rendered, rendered
        honest_rendered = describe_connection_state({'error': 'host key mismatch', 'state': 'error'})
        assert 'host key mismatch' in honest_rendered and 'state=error' in honest_rendered, honest_rendered

        # a capture failure carrying a secret in its message: the gather
        # boundary re-raises the SAME type with the scrubbed message — the
        # run still fails, the traceback never sees the raw string
        shape = _RequestShape({'user-agent': 'benign'}, {'x': 'y'},
                              fail=True, fail_message=f'all_headers failed for {GOOGLE_TOKEN} {CANARY}')
        task = asyncio.ensure_future(capture_request(shape))
        threw, caught = False, None
        try:
            await gather_captures([task])
        except RuntimeError as exc:
            threw, caught = True, exc
        assert threw and task.done(), 'a failed capture no longer fails the run'
        scan(str(caught), 'the gather-boundary capture failure')
        assert '<redacted: withheld' in str(caught) and str(caught).startswith('RuntimeError:'), caught
    finally:
        PAGE, CONSOLE_ERRORS = old_page, old_console
    print('failure-dump control: the ACTUAL dump/console-verdict/store/gather outputs stayed '
          'label-safe, with honest diagnostics and failure propagation intact')


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
        # the receipt names the refusal, not just the timeout. The store read
        # is collected safely — its own failure must not mask the dial failure.
        await page.wait_for_timeout(2_000)
        try:
            rendered = describe_connection_state(await connection_state(page))
        except Exception as e:  # noqa: BLE001
            rendered = f'store read failed ({safe_exc(e)})'
        print(f'--- dial to {name} did not navigate; connection store: {rendered}')
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
    gateway_auth_negative_control()
    url_custody_negative_control()
    http_custody_negative_control()
    await diagnostics_negative_control()
    await capture_path_negative_control()
    await failure_dump_negative_control()
    osc52_clear_ack_negative_control()
    print('negative controls: custody oracle, gateway auth-frame recorder, the exact-surface URL policy,'
          ' the captured-HTTP policy, the complete-header capture path, custody diagnostics,'
          ' the credential-safe failure dumps (dump/console verdict/store/gather)'
          ' and the OSC 52 ack matcher all bite')

    sync = FakeSync()
    relay = FakeRelay(FIXTURE_PORT)
    host_key_line = open(os.path.join(WORK, 'host_key.pub')).read().strip()
    gateway = FakeGateway(FIXTURE_PORT, GW_DEVICE, host_key_line)
    # EVERY HTTP request the page makes: method, URL, COMPLETE headers and
    # body — the URL policy, the Authorization rule and the body scan below
    # run on THIS capture, not just on the sync route's own log. The
    # complete-header read is ASYNC (the .headers property is documented
    # incomplete — security/cookie headers can be absent), so every request
    # event spawns a capture task; gather_captures below awaits them ALL
    # before the verdict, and a failed read fails the run.
    capture_tasks: list[asyncio.Task] = []
    console_errors: list[str] = []

    def on_request(req):
        capture_tasks.append(asyncio.ensure_future(capture_request(req)))

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
        assert any('dockertest' in r for r in rows), safe_repr_payload(rows)
        assert any('already synced' in r for r in rows), safe_repr_payload(rows)
        assert any('pattern' in r and 'skipped' in r for r in await page.locator('.import-hint').all_inner_texts()), safe_repr_payload(rows)
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
        assert surfaced['error'], f'no refusal surfaced: {describe_connection_state(surfaced)}'
        print(f"keyless-collision refusal surfaced: {safe_diag_text(str(surfaced['error']))}")
        await page.wait_for_timeout(2_000)
        assert relay.dials == dials_before, 'a refused dial must not open a relay socket'
        assert '/host/' not in page.url, 'a refused dial must not navigate to the host'
        assert surfaced['state'] == 'idle', (
            f'the dial must settle as idle, saw {safe_diag_text(str(surfaced["state"]))}'
        )

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
        # sequence is refused by the shipping handler. The refusal is silent,
        # so the SAME PTY command emits a unique harmless output ack AFTER
        # the empty OSC; the harness waits for that ack as a REAL terminal
        # line — the typed echo carries the token only inside shell quotes,
        # so the wait cannot be satisfied by the echo. Reaching the output
        # proves ordered parsing has processed the clear attempt before the
        # clipboard is checked; a stalled or dropped command fails the wait
        # instead of passing on the already-present marker.
        ack_suffix = os.urandom(4).hex()
        ack = f'e2e-clear-ack-{ack_suffix}'
        await page.keyboard.type(f"printf '\\033]52;c;\\a'; echo 'e2e-clear''-ack-{ack_suffix}'")
        await page.keyboard.press('Enter')
        await wait_for_terminal_line(page, ack)
        await clipboard_equals(page, OSC52_MARKER)
        print('OSC 52 CLEAR: empty-payload refusal kept the yanked marker (acknowledged by real output)')

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
        assert sorted(names) == ['dockertest', 'keylesstest', 'manualbox'], safe_repr_payload(names)
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

        # EVERY header capture must land before teardown and the verdict: a
        # slow complete-header read is awaited, a failed one fails the run.
        await page.wait_for_timeout(1_000)  # let trailing request events land
        http_records = await gather_captures(capture_tasks)
        if any(not task.done() for task in capture_tasks):
            http_records = await gather_captures(capture_tasks)
    except BaseException:
        for task in capture_tasks:
            task.cancel()
        await dump_diagnostics()
        raise
    finally:
        await context.close()
        await browser.close()
        await pw.stop()

    # --- wire-level assertions ----------------------------------------------
    # 0. The custody oracle's surfaces, stated exactly as implemented:
    #      - EVERY HTTP request the page made (captured with method, URL,
    #        the COMPLETE header map + the duplicate-preserving header
    #        array, and body — awaited to completion by gather_captures
    #        before this verdict) through ONE captured-HTTP policy
    #        (assert_http_request_custody): the structured exact-surface URL
    #        rules (scheme/host/effective port/path/query — see
    #        assert_url_custody, raw AND decoded components), the method
    #        rule and the exact-Bearer Authorization rule on the account
    #        surfaces only, a FULL secret-set scan of every header value
    #        (the exact account bearer is the single exempt value, pinned by
    #        equality; a second Authorization entry refuses), and a
    #        full-set body scan (the sync envelopes are additionally
    #        shape-checked and decrypted below);
    #      - the direct-relay and gateway WebSocket dial URLs, through the
    #        same structured per-surface policy (the gateway dial has NO
    #        query — its admission token rides the auth frame);
    #      - EVERY recorded relay/gateway frame — binary AND text, the
    #        gateway's first/auth TEXT frame included — through the SAME
    #        oracle.
    #    The negative controls above proved the oracle, the gateway recorder,
    #    the URL policy, the captured-HTTP policy, the capture path and the
    #    failure diagnostics bite; THIS run's coverage is the live recordings
    #    going through them.
    assert http_records, 'no HTTP request was captured for the custody verdict'
    assert len(http_records) == len(capture_tasks), (
        'a header capture never completed — the verdict refuses an incomplete recording '
        f'({len(http_records)} record(s) for {len(capture_tasks)} request event(s))'
    )
    for record in http_records:
        assert_http_request_custody(
            record['method'], record['url'], record['headers'], record['body'],
            f"HTTP {describe_method(record['method'])}",
            header_entries=record['header_entries'],
        )
    for url in relay.urls:
        assert_url_custody(url, 'the direct-relay dial')
    for url in gateway.urls:
        assert_url_custody(url, 'the gateway dial')
    assert_wire_custody(relay.every_relayed_byte(), relay.every_text_frame(), 'direct-relay')
    assert_wire_custody(gateway.every_relayed_byte(), gateway.every_text_frame(), 'gateway')

    # 1. Sync request custody: the global body scan above already covers
    #    every sync body against the full secret set; what remains here is
    #    sync-STRUCTURE: every PUT carried exactly the envelope fields —
    #    ciphertext only.
    for put in sync.put_bodies:
        assert set(put.keys()) == {'data', 'version'}
        envelope = json.loads(put['data'])
        assert set(envelope.keys()) == {'v', 'kdf', 'iter', 'salt', 'iv', 'ct'}, envelope.keys()
    # 3. What left is decryptable with the passphrase and carries the merged
    #    list — host list AND the roaming key envelope (the key-slot restore
    #    proof: the redial below only works if THIS payload came back).
    final_hosts = json.loads(decrypt_envelope(sync.data['main'], SYNC_PASSPHRASE))['hosts']
    assert [h['name'] for h in final_hosts] == ['manualbox', 'dockertest', 'keylesstest', 'gwbox'], \
        safe_repr_payload(final_hosts)
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
    #    ONLY the scoped routing token in its auth frame. That frame is part
    #    of the custody recording now (the auth frame is inside
    #    every_text_frame, scanned with the full secret set — the scoped
    #    token itself stays allowed), the Google sign-in appears on no
    #    gateway surface (asserted globally on URLs and headers), and a real
    #    SSH session ran behind `ready`.
    assert gateway.dials == 1, f'expected exactly one gateway dial, saw {gateway.dials}'
    assert any('/api/v1/hosts/dev-e2e/ssh' in u for u in gateway.urls), [safe_url(u) for u in gateway.urls]
    assert len(gateway.auth_frames) == 1 and gateway.auth_frames[0].get('type') == 'auth', \
        safe_repr_payload(gateway.auth_frames)
    assert gateway.auth_frames[0]['token'] == GW_TOKEN, 'auth frame did not carry the broker-scoped token'
    assert gateway.ready_sent == 1
    assert gateway.text_after_ready == [], f'text frames after ready: {safe_repr_payload(gateway.text_after_ready)}'
    assert all(
        len(p.relayed) > 0 and len(p.from_server) > 0 for p in gateway.pipes
    ), 'the gateway pipe saw no real SSH traffic'
    assert_no_console_errors(console_errors)

    print('E2E PASS: import + key + selection + OSC 52 + gateway verified against the real sshd fixture')
    print(
        f'  sync PUTs: {len(sync.put_bodies)} envelopes; direct dials: {relay.dials}'
        f' (browser-direct, custody-scanned: binary + text + URLs);'
        f' gateway dials: {gateway.dials} (protocol fixture, real sshd behind it,'
        f' auth TEXT frame custody-scanned: {len(gateway.every_text_frame())} text frame(s))'
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
