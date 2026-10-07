"""The LOCAL broker fixture for the combined gateway proof.

This is the stand-in for the separately-trusted PocketShell sync service's
auth broker (`POST /gateway/token`, `GET /gateway/jwks` — see the gateway
repo's docs/routing-credentials.md). It is a TEST FIXTURE, clearly distinct
from the live Cloud authorizer:

  - The "Google sign-in" here is a FIXED fixture JWT (the harness's GIS stub
    injects exactly this string). The authorizer check below is a local
    exact-match stand-in for the real API-Gateway JWT authorizer — it proves
    the exchange CONTRACT (empty body, bearer only in the Authorization
    header, scoped short-lived token out), NOT Google identity. No real
    Google credential is ever read, sent, or accepted.
  - The minted tokens are signed by a RUN-EPHEMERAL RSA key this process
    generates; the gateway verifies them through the PRODUCTION
    `internal/routingauth` verifier against this server's JWKS endpoint —
    RS256, exact issuer, aud=pocketshell-gateway, scope=pocketshell.gateway,
    <=5-minute lifetime, the full production claim contract.
  - Every request is recorded (method, path, authorization shape, body) to a
    JSONL so the custody oracle can prove what the broker saw.

Also exposes the negative-token minter used by the gateway-verifier
negative checks: `mint_variant()` produces claim-mutated tokens (wrong
issuer, wrong audience, missing scope, expired) signed by the same fixture
key — the gateway's production verifier must refuse every one of them.

Usage: python3 gateway_fixture_broker.py <port> <record-jsonl-path>
       (then GET /jwks.json for the public key, POST /gateway/token to mint)
"""

import base64
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

BROKER_EMAIL = 'e2e-gateway@pocketshell.test'
GOOGLE_SUB = 'e2e-google-sub-j9k2m'
TOKEN_TTL_SECS = 240  # <= the 300s production cap

# The fakeGoogle stand-in credential (the GIS stub injects exactly this).
GOOGLE_TOKEN = (
    'eyJhbGciOiJub25lIn9.'
    + base64.urlsafe_b64encode(
        json.dumps({'email': BROKER_EMAIL, 'sub': GOOGLE_SUB, 'exp': 4102444800}).encode()
    ).rstrip(b'=').decode()
    + '.fixture-signature'
)


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def b64u_json(obj) -> str:
    return b64u(json.dumps(obj, separators=(',', ':')).encode())


class BrokerKey:
    """The run-ephemeral RS256 signing key + its public JWK."""

    def __init__(self):
        self.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pub = self.private.public_key().public_numbers()
        n = pub.n.to_bytes((pub.n.bit_length() + 7) // 8, 'big')
        e = pub.e.to_bytes((pub.e.bit_length() + 7) // 8, 'big')
        # kid = the RFC 7638 thumbprint of the public JWK (the production
        # contract: the verifier pins the exact key by this id).
        jwk_canonical = json.dumps(
            {'e': b64u(e), 'kty': 'RSA', 'n': b64u(n)}, separators=(',', ':'), sort_keys=True
        )
        self.kid = b64u(__import__('hashlib').sha256(jwk_canonical.encode()).digest())
        self.jwk = {'kty': 'RSA', 'alg': 'RS256', 'use': 'sig', 'kid': self.kid, 'n': b64u(n), 'e': b64u(e)}

    def rekey(self, private_pem: bytes):
        """Adopt a persisted key (same-process consistency for the harness's
        variant minter: tokens minted in-process must carry the SAME kid the
        running broker serves, or the negatives would fail at `bad kid`
        instead of at the intended claim)."""
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        self.private = load_pem_private_key(private_pem, password=None)
        pub = self.private.public_key().public_numbers()
        n = pub.n.to_bytes((pub.n.bit_length() + 7) // 8, 'big')
        e = pub.e.to_bytes((pub.e.bit_length() + 7) // 8, 'big')
        jwk_canonical = json.dumps(
            {'e': b64u(e), 'kty': 'RSA', 'n': b64u(n)}, separators=(',', ':'), sort_keys=True
        )
        import hashlib

        self.kid = b64u(hashlib.sha256(jwk_canonical.encode()).digest())
        self.jwk = {'kty': 'RSA', 'alg': 'RS256', 'use': 'sig', 'kid': self.kid, 'n': b64u(n), 'e': b64u(e)}

    def sign_rs256(self, header: dict, claims: dict) -> str:
        signing_input = f'{b64u_json(header)}.{b64u_json(claims)}'
        sig = self.private.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
        return f'{signing_input}.{b64u(sig)}'


KEY = BrokerKey()
ISSUER = ''  # set from argv at startup
RECORD_PATH = ''
records: list = []


def load_signing_key(pem_path: str) -> None:
    """Harness-side: adopt the key the RUNNING broker generated (it persists
    its private key next to the record file at startup, mode 0600), so
    variant tokens minted in-process carry the same kid the broker serves."""
    with open(pem_path, 'rb') as fh:
        KEY.rekey(fh.read())


def mint_scoped_token(issuer: str, ttl: int = TOKEN_TTL_SECS) -> dict:
    """The PRODUCTION token contract, minted honestly: exact issuer, the
    gateway audience, the routing scope, bounded dual expiries."""
    now = int(time.time())
    claims = {
        'iss': issuer,
        'aud': 'pocketshell-gateway',
        'sub': GOOGLE_SUB,
        'email': BROKER_EMAIL,
        'email_verified': True,
        'iat': now,
        'nbf': now,
        'exp': now + ttl,
        'scope': 'pocketshell.gateway',
    }
    token = KEY.sign_rs256({'alg': 'RS256', 'typ': 'JWT', 'kid': KEY.kid}, claims)
    return {
        'token': token,
        'token_type': 'Bearer',
        'expires_in': ttl,
        'expires_at': now + ttl,
    }


def mint_variant(variant: str) -> str:
    """Claim-mutated tokens for the gateway's NEGATIVE authority checks —
    the production verifier must refuse each one. `ok` is the honest token."""
    now = int(time.time())
    base = {
        'iss': ISSUER,
        'aud': 'pocketshell-gateway',
        'sub': GOOGLE_SUB,
        'email': BROKER_EMAIL,
        'email_verified': True,
        'iat': now,
        'nbf': now,
        'exp': now + TOKEN_TTL_SECS,
        'scope': 'pocketshell.gateway',
    }
    if variant == 'ok':
        claims = base
    elif variant == 'wrong-iss':
        claims = {**base, 'iss': 'https://evil.example.org'}
    elif variant == 'wrong-aud':
        claims = {**base, 'aud': 'some-other-service'}
    elif variant == 'no-scope':
        claims = {k: v for k, v in base.items() if k != 'scope'}
    elif variant == 'wrong-scope':
        claims = {**base, 'scope': 'pocketshell.admin'}
    elif variant == 'expired':
        claims = {**base, 'iat': now - 600, 'nbf': now - 600, 'exp': now - 300}
    else:
        raise ValueError(variant)
    return KEY.sign_rs256({'alg': 'RS256', 'typ': 'JWT', 'kid': KEY.kid}, claims)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # request logs go to the record file, not stderr
        return

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def _record(self, shape: str):
        rec = {'t': time.time(), 'method': self.command, 'path': self.path, 'auth': shape}
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        rec['body'] = body.decode('utf-8', 'replace')
        rec['origin'] = self.headers.get('Origin') or ''
        records.append(rec)
        with open(RECORD_PATH, 'a') as fh:
            fh.write(json.dumps(rec) + '\n')
        return body

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path in ('/gateway/jwks', '/jwks.json'):
            self._record('none')
            body = json.dumps({'keys': [KEY.jwk]}).encode()
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if urlsplit(self.path).path != '/gateway/token':
            self.send_response(404)
            self.end_headers()
            return
        auth = self.headers.get('Authorization') or ''
        self._record(auth)
        # The authorizer stand-in: exactly the fixture sign-in as the bearer,
        # nothing else (the live authorizer verifies a real Google JWT; this
        # local stand-in matches the fixture constant — the exchange CONTRACT
        # is what is under proof, not Google identity).
        if auth != f'Bearer {GOOGLE_TOKEN}':
            body = json.dumps({'message': 'unauthorized'}).encode()
            self.send_response(401)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        minted = mint_scoped_token(ISSUER)
        body = json.dumps(minted).encode()
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def make_self_signed_cert(cert_path: str, key_path: str) -> None:
    """A run-ephemeral self-signed certificate for the broker's TLS listener:
    the browser's production exchange guard refuses to mint from a non-https
    account-service origin, so the FIXTURE serves TLS with an owned key. The
    harness's Chromium context is launched with ignore_https_errors for this
    fixture origin only (a lab affordance — nothing in shipped code changes)."""
    import datetime
    import ipaddress
    import ssl

    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa as _rsa
    from cryptography.x509.oid import NameOID

    key = _rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, 'pocketshell-gateway-broker-fixture')]
    )
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address('127.0.0.1')), x509.DNSName('localhost')]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as fh:
        fh.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    with open(cert_path, 'wb') as fh:
        fh.write(cert.public_bytes(serialization.Encoding.PEM))


def main() -> int:
    global ISSUER, RECORD_PATH
    port = int(sys.argv[1])
    RECORD_PATH = sys.argv[2]
    ISSUER = f'http://127.0.0.1:{port}'
    # The ISSUER pinned into minted tokens is the https origin the BROWSER
    # exchanges at; the plain-http listener below stays for the GATEWAY's
    # JWKS fetch (its own -broker-allow-insecure-dev lab flag).
    https_port = int(sys.argv[3]) if len(sys.argv) > 3 else None
    cert_path = os.path.join(os.path.dirname(RECORD_PATH) or '.', 'broker-fixture-cert.pem')
    key_path = os.path.join(os.path.dirname(RECORD_PATH) or '.', 'broker-fixture-key.pem')
    if https_port:
        ISSUER = f'https://127.0.0.1:{https_port}'
        make_self_signed_cert(cert_path, key_path)
        tls_cert_path, tls_key_path = cert_path, key_path
    # Persist the signing key for the harness's variant minter (same kid):
    # the negatives only prove what they claim when their signatures are
    # otherwise VALID — a foreign-key mutant dies at `bad kid`, which proves
    # nothing about issuer/audience/scope enforcement.
    key_path = RECORD_PATH.replace('.jsonl', '') + '-signing-key.pem'
    from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

    pem = KEY.private.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as fh:
        fh.write(pem)
    with open(RECORD_PATH, 'w') as fh:
        fh.write(json.dumps({'note': f'local broker fixture; issuer={ISSUER}; the authorizer is a LOCAL exact-match stand-in for the live Cloud authorizer (fixture sign-in only); owned ephemeral keys ({key_path}, 0600); records hold auth SHAPES, not secrets'}) + '\n')
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)

    import threading

    if https_port:
        import ssl

        httpd = ThreadingHTTPServer(('127.0.0.1', https_port), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        # tls_* names: the signing-key block above reassigns key_path, and
        # feeding the RS256 signing key here is exactly the mismatch that
        # crashed the first run.
        ctx.load_cert_chain(tls_cert_path, tls_key_path)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
    server.serve_forever()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
