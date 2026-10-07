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
  PKCS#1 RSA/DSA (exact INTEGER runs, SEQUENCE consuming the whole buffer),
  SEC1 EC (version/OCTET STRING/optional-[0]/[1] shape), PKCS#8 (algorithm
  OID **with the inner payload validated against it**: rsaEncryption →
  PKCS#1 shape, id-Ed25519 → exactly OCTET STRING(32), id-ecPublicKey →
  SEC1 shape, id-dsa → the PKCS#8 exponent-INTEGER form, PBES-family →
  "encrypted"), raw `openssh-key-v1` containers, and RFC 1423 `Proc-Type`/
  `DEK-Info` headers. DER length encodings must be minimal; anything
  unrecognized or structurally inconsistent (trailing bytes, truncated
  bodies, container halves that disagree) classifies as `unknown` and
  callers fail closed. No ASN.1 library, no elliptic import, no ssh2 import
  (no cycles).
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

## OpenSSH container classification — what it does and does not read

For a **cipher=none** container the classifier parses the actual private
section (check ints, type string, per-type fields, comment, canonical
padding, exact consumption) and requires it to agree with the public header
— the verdict reads the real key. For an **encrypted** container the
ciphertext cannot be checked, so the cipher/KDF headers are advisory only:
the kind is "encrypted" and the verdict is "indeterminate". The
**authoritative** decision in every case is the re-classification at the
signing boundary, on the PEM ssh2 actually produces after parsing/decryption.

## Early assessment contract (for the dial/UI owner)

`assessPrivateKeyAuth(pem)` is advisory UX triage. Only `verdict ===
'refused'` (ECDSA) may block a dial early — that dial could never sign.
`'indeterminate'` (encrypted or unrecognized — ssh2 may still decrypt or
convert, e.g. PPK) and `'allowed'` MUST NOT gate the dial: the authoritative
fail-closed guard runs at the signing boundary on whatever key material
ssh2 produces, and a refusal there fails the dial through the normal error
path. No trial signing and no "sign once to find out" exists anywhere.

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
  positives, verification residuals, error hygiene, plus hardened DER and
  container negatives (trailing bytes, non-minimal lengths, OID/payload
  mismatches, spliced OpenSSH containers).
- **`tests/crypto/lab/browser/run-browser-lab.mjs` — the shipping acceptance
  pass.** Builds a bundle with the production vite pipeline (the real
  `vite.config.ts`, loaded unmodified — the node-polyfills `crypto` →
  `src/shims/ssh2-crypto.ts` override is the shipping wiring; one extra
  lab-only HTML entry), runs it in a real headless Chromium over CDP, and
  dials a real in-process ssh2 server through a WebSocket bridge using
  connection.ts's exact algorithm config (nistp256/DH14, AES-CTR,
  ed25519/RSA host keys). Covers positive RSA/Ed25519 handshakes (plain +
  passphrase-encrypted), ECDSA plaintext and encrypted refusals, malformed
  key refusals, host-pin rejection before userauth, and the public-key
  verification residual. An elliptic prototype probe counts ECDSA/EdDSA
  signatures in the real bundled library (liveness proven by the ECDH
  handshakes hitting the same wrapped prototype); every flow ends at zero.
- `npm run test:crypto-lab` (`tests/crypto/lab/`): **supplemental** node
  evidence. Module hooks serve the compiled shim to real ssh2's
  `require('crypto')` and a counting probe to browserify-sign's
  `require('elliptic')`, then run the ssh2 key parser and in-process SSH
  handshakes. Useful for the interception-source receipts and the counting
  probe — but it is NOT the shipping wiring (the production bundle aliases
  `crypto` through vite, not node hooks); the browser lab above is what
  proves the shipped wiring.

## Curve25519 offer stub — shim-level only, not a shipping bug

The shim's import-probe stubs (`generateKeyPairSync` etc. are exported as
throwing functions) make ssh2's `curve25519Supported` probe true, so a dial
using ssh2's DEFAULT algorithm list offers `curve25519-sha256` first and
then dies inside the stub. **This cannot happen in the shipping app:**
`src/terminal/connection.ts` (line 293–297) pins `algorithms.kex` to
`['ecdh-sha2-nistp256', 'diffie-hellman-group14-sha256']` (with AES-CTR
ciphers and ed25519/RSA host keys), so curve25519 is never offered — the
shipping browser lab dials with exactly that list and all handshakes
negotiate `ecdh-sha2-nistp256`. The node-hook lab pins the default-offer
failure as a shim-level fact only; changing the offer list would alter
negotiation outside the crypto scope and has no demonstrated production
need.

## pbkdf2

The polyfill tree's `pbkdf2` (reached via crypto-browserify → browserify-sign
→ parse-asn1; GHSA-477h-4r7f-fvrx, long-passphrase DoS) is resolved to
≥ 3.1.7 by a `"pbkdf2": "^3.1.7"` package override — the only lockfile change
in that commit.
