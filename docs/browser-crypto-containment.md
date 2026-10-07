# Browser SSH crypto containment — ECDSA signing refusal (GHSA-848j-6mx2-7j84)

Status: implemented on `gateway-browser-crypto` (browser release security scope).
This document is the shim-side contract; the terminal/dial integration belongs
to `src/terminal/connection.ts` (owned elsewhere — a suggested hunk is in the
handoff report, not applied here).

## What the advisory is (and is not)

`elliptic 6.6.1` (unpatched for GHSA-848j-6mx2-7j84, "cryptographic primitive
with a risky implementation") is reachable from the browser SSH **signing**
path: ssh2's key parser signs client-auth data through `crypto.sign` /
`crypto.createSign` — polyfilled by `src/shims/ssh2-crypto.ts` — and
browserify-sign delegates EC (ECDSA) keys to `elliptic`'s ECDSA. The upstream
report itself questions ordinary hash-before-sign key recovery, so this is a
**conservative containment decision before release, not a demonstrated
compromise**: no key recovery was attempted or shown here.

## What was changed

Fail-closed at the lowest browser signing boundary, before elliptic receives
any private key:

- `src/shims/private-key-classify.ts` (new, dependency-free): structural
  classification of the PEM forms that actually reach the boundary —
  PKCS#1 RSA/DSA, SEC1 EC, PKCS#8 (by algorithm OID, including PBES-family →
  "encrypted"), raw `openssh-key-v1` containers (cipher/KDF names →
  "encrypted"; key-type string → algorithm), and RFC 1423 `Proc-Type`/
  `DEK-Info` headers. Every DER read is bounds-checked; anything unrecognized
  classifies as `unknown` and callers fail closed. No ASN.1 library, no
  elliptic import, no ssh2 import (no cycles).
- `src/shims/ssh2-crypto.ts`:
  - one-shot `sign(algo, data, key)`: named-digest calls classify the key and
    refuse **before** a signer exists — no trial signature, no
    call-elliptic-to-find-out;
  - `createSign(algorithm)`: returns the real browserify-sign signer with its
    `.sign` instance method wrapped by the same check, so the fallback path
    cannot bypass the one-shot guard (the one-shot path itself routes through
    this wrapper);
  - refusal errors are stable, carry machine codes
    (`ERR_BROWSER_ECDSA_UNSUPPORTED`, `ERR_BROWSER_KEY_FORMAT_UNSUPPORTED`)
    and never contain key or passphrase material.

## What deliberately still uses elliptic

- **ECDH key exchange** (`ecdh-sha2-nistp*` via `createECDH`) — untouched; the
  advisory concerns ECDSA signatures. The library is NOT removed from the
  bundle.
- **Public-key verification** (`crypto.verify` / `createVerify`) — untouched,
  so RSA/Ed25519 (and ECDSA, for deployments that opt in) host-key
  verification keeps working. Host-key verification uses the public half only;
  no private key is involved.

## Kept working (regression-tested)

- RSA (PKCS#1, PKCS#8, OpenSSH-converted) signing with sha256/sha512 — the
  `rsa-sha2-*` userauth algorithms — verified against the public key.
- Ed25519 one-shot signing (ssh2's own support probe included).
- Encrypted OpenSSH keys: ssh2 decrypts (bcrypt-pbkdf) before signing, and the
  decrypted PEM passes the guard — correct passphrases still sign.
- `randomBytes` / `randomFillSync`, `timingSafeEqual`, and the Ed25519 probe
  behavior are unchanged.

## Tests

- `tests/crypto/shim-guard.test.ts` — runs in the default `npm test`:
  classification of real ephemeral keys, both guard boundaries, RSA/Ed
  positives, verification residuals, error hygiene.
- `npm run test:crypto-lab` (`tests/crypto/lab/`): node module hooks serve the
  compiled shim to ssh2's `require('crypto')` and a counting probe to
  browserify-sign's `require('elliptic')` — the exact production wiring —
  then runs the real ssh2 key parser and a full in-process SSH handshake
  (server verifies client signatures through the same shim). Zero elliptic
  ECDSA signature calls is asserted across every flow.

## Known pre-existing limitation (flagged for root coordination, NOT this fix)

The shim's import-probe stubs (`diffieHellman`, `generateKeyPairSync`,
`createPublicKey` are exported as throwing functions) make ssh2's
`curve25519Supported` probe true, so ssh2 offers `curve25519-sha256` FIRST —
and `Curve25519Exchange` then dies inside the `generateKeyPairSync` stub. Any
server whose preference picks curve25519 (modern OpenSSH default) fails the
handshake with `crypto.generateKeyPairSync is not supported in the browser
build`. The crypto lab pins this behavior as a test; resolving it (making the
probe false so ssh2 offers `ecdh-sha2-nistp*`, which works via `createECDH`)
is a transport-offer change that needs the web worker's coordination.

## pbkdf2

The polyfill tree's `pbkdf2` (reached via crypto-browserify → browserify-sign
→ parse-asn1; GHSA-477h-4r7f-fvrx, long-passphrase DoS) is resolved to
≥ 3.1.7 by a `"pbkdf2": "^3.1.7"` package override — the only lockfile change
in that commit.
