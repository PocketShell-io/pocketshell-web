/**
 * Browser crypto for ssh2: crypto-browserify covers the handshake (hashes,
 * HMAC, CTR ciphers, ECDH/Diffie-Hellman, RSA signing); the entries
 * crypto-browserify has no answer for exist so ssh2's import-time probes
 * succeed — and so Ed25519 keys work.
 *
 * Ed25519 is why `sign`/`verify` exist here. ssh2's eddsaSupported probe
 * calls them exactly like node's one-shot crypto APIs (null algorithm, PEM
 * key string) and expects a synchronous 64-byte detached signature; WebCrypto
 * cannot answer synchronously, so this uses tweetnacl. Keys are seeded
 * straight from the PKCS8/SPKI DER (fixed prefixes, no ASN.1 parser needed).
 *
 * Private-key signing is fail-closed on ECDSA (GHSA-848j-6mx2-7j84): both
 * the one-shot `sign` and the `createSign().sign` fallback classify the key
 * structurally and refuse before elliptic can receive it. See the
 * containment block below and ./private-key-classify.ts.
 */
import cryptoBrowserify from 'crypto-browserify';
import { Buffer as NodeBuffer } from 'node:buffer';
import nacl from 'tweetnacl';
import {
  assessPrivateKeyAuth,
  classifyPrivateKey,
  ECDSA_REFUSAL_REASON,
  type PrivateKeyAssessment,
  type PrivateKeyKind,
  type PrivateKeyVerdict,
} from './private-key-classify';

export { assessPrivateKeyAuth, classifyPrivateKey };
export type { PrivateKeyAssessment, PrivateKeyKind, PrivateKeyVerdict };

/* ssh2's key parser leans on node-internal Buffer fast paths (utf8Slice,
 * base64Slice, …) that no polyfilled Buffer implements — and ssh2 spins
 * subclasses via Buffer[Symbol.species], so per-class patches can't keep up.
 * Placing the shims on Uint8Array.prototype reaches every Buffer copy (each
 * extends Uint8Array) without colliding: node-internal Buffer keeps its own
 * copies closer in the prototype chain, and nothing else uses these names. */
type FastPathProto = {
  utf8Slice?: (start?: number, end?: number) => string;
  base64Slice?: (start?: number, end?: number) => string;
  hexSlice?: (start?: number, end?: number) => string;
  latin1Slice?: (start?: number, end?: number) => string;
  utf8Write?: (s: string, offset?: number, length?: number) => number;
};
{
  const proto = Uint8Array.prototype as unknown as FastPathProto;
  const self = (b: unknown) => b as unknown as {
    toString: (enc: string, start?: number, end?: number) => string;
    write: (s: string, off?: number, len?: number, enc?: string) => number;
  };
  proto.utf8Slice ??= function (start?: number, end?: number) {
    return self(this).toString('utf8', start, end);
  };
  proto.base64Slice ??= function (start?: number, end?: number) {
    return self(this).toString('base64', start, end);
  };
  proto.hexSlice ??= function (start?: number, end?: number) {
    return self(this).toString('hex', start, end);
  };
  proto.latin1Slice ??= function (start?: number, end?: number) {
    return self(this).toString('latin1', start, end);
  };
  proto.utf8Write ??= function (s: string, offset?: number, length?: number) {
    return self(this).write(s, offset, length, 'utf8');
  };
}

export const createCipheriv = cryptoBrowserify.createCipheriv.bind(cryptoBrowserify);
export const createDecipheriv = cryptoBrowserify.createDecipheriv.bind(cryptoBrowserify);
export const createECDH = cryptoBrowserify.createECDH.bind(cryptoBrowserify);
export const createDiffieHellman = cryptoBrowserify.createDiffieHellman.bind(cryptoBrowserify);
export const createDiffieHellmanGroup = cryptoBrowserify.createDiffieHellmanGroup.bind(cryptoBrowserify);
export const createHash = cryptoBrowserify.createHash.bind(cryptoBrowserify);
export const createHmac = cryptoBrowserify.createHmac.bind(cryptoBrowserify);
export const createVerify = cryptoBrowserify.createVerify.bind(cryptoBrowserify);
export const getCiphers = cryptoBrowserify.getCiphers.bind(cryptoBrowserify);
export const randomBytes = cryptoBrowserify.randomBytes.bind(cryptoBrowserify);
export const randomFillSync = cryptoBrowserify.randomFillSync.bind(cryptoBrowserify);

/* --- ECDSA signing containment (GHSA-848j-6mx2-7j84) ----------------------- */
/**
 * browserify-sign fulfills named-digest signing by parsing the private key
 * and, for EC keys, delegating to elliptic's ECDSA — the implementation the
 * open advisory flags (no patched elliptic release exists). Every ECDSA
 * user-authentication signature therefore goes through this module, and the
 * guard below refuses BEFORE any signer is constructed or any private-key
 * material is handed to a third-party parser: the key is classified
 * structurally (see ./private-key-classify) — no trial signature, no
 * "sign once to find out", no regex-only allow.
 *
 * Scope: PRIVATE-key signing only. Host-key verification (crypto.verify /
 * createVerify, public keys) and ECDH key exchange are untouched — elliptic
 * remains in the bundle for those.
 */

/** Fail closed before elliptic can see a private key: allowed kinds are
 * RSA/DSA/Ed25519; ECDSA, still-encrypted and unrecognized keys all refuse.
 * Errors are stable, must not contain key or passphrase material, and are
 * the only thing that ever leaves this module about the key. */
export function assertSignablePrivateKey(key: unknown): void {
  classifyAllowedPrivateKey(key);
}

/** Shared gate for EVERY sign API branch: classifies the key structurally
 * and either throws the stable coded refusal or returns the allowed kind.
 * Both the null-digest branch and the named-digest branch of `sign` (and
 * the createSign().sign wrapper) go through this, so no branch can reach a
 * signer with a key the classifier did not clear. */
function classifyAllowedPrivateKey(key: unknown): PrivateKeyKind {
  if (typeof key !== 'string' && !(key instanceof Uint8Array)) {
    // browserify-sign also accepts node KeyObjects; nothing in the browser
    // bundle produces one, and a key we cannot structurally classify is not
    // a key we sign with.
    throw unsupportedFormatError(
      'browser build refuses to sign with an unrecognizable private-key value',
    );
  }
  const kind = classifyPrivateKey(key);
  switch (kind) {
    case 'rsa':
    case 'dsa':
    case 'ed25519':
      return kind;
    case 'ecdsa':
      throw unsupportedFormatError(
        `browser build refuses ECDSA private-key signing: ${ECDSA_REFUSAL_REASON}`,
        'ERR_BROWSER_ECDSA_UNSUPPORTED',
      );
    case 'encrypted':
      throw unsupportedFormatError(
        'browser build refuses to sign with a still-encrypted private key',
      );
    default:
      throw unsupportedFormatError(
        'browser build refuses to sign with an unrecognized private-key format',
      );
  }
}

function unsupportedFormatError(message: string, code = 'ERR_BROWSER_KEY_FORMAT_UNSUPPORTED'): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  return err;
}

/** Guarded signer: the real browserify-sign instance with its `.sign`
 * instance method wrapped, so every private-key handoff — including the
 * one-shot `sign` fallback below — passes the refusal check first. */
export function createSign(algorithm: string) {
  const signer = cryptoBrowserify.createSign(algorithm);
  const realSign = signer.sign;
  signer.sign = function (this: unknown, key: unknown, ...rest: unknown[]) {
    assertSignablePrivateKey(key);
    return realSign.apply(this, [key, ...rest]);
  };
  return signer;
}

function unsupported(name: string): () => never {
  return () => {
    throw new Error(`crypto.${name} is not supported in the browser build`);
  };
}

export const generateKeyPair = unsupported('generateKeyPair');
export const generateKeyPairSync = unsupported('generateKeyPairSync');
export const diffieHellman = unsupported('diffieHellman');
export const createPublicKey = unsupported('createPublicKey');
export const getCurves = (): string[] => ['secp256k1', 'prime256v1'];
export const getHashes = (): string[] => ['sha1', 'sha256', 'sha384', 'sha512', 'md5'];

/** Constant-time comparison, as node's crypto.timingSafeEqual — ssh2 uses it
 * while verifying the key exchange. Throws on length mismatch like node. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    throw new Error('input buffers must have the same byte length');
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/* --- Ed25519 via tweetnacl ------------------------------------------------ */

// DER prefixes of a fixed shape: PKCS8 Ed25519 private key = 16 header bytes
// + 32-byte seed; SPKI Ed25519 public key = 12 header bytes + 32-byte key.
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const SPKI_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .split(/\r?\n/)
    .filter((line) => line !== '' && !line.startsWith('-----'))
    .join('');
  const bin = atob(body);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function ed25519HasPrefix(der: Uint8Array, prefix: Uint8Array): boolean {
  return der.length === prefix.length + 32 && prefix.every((b, i) => der[i] === b);
}

/** node crypto.sign: null algorithm = Ed25519 (raw 64-byte signature), named
 * digest = RSA (DER) through the same createSign path ssh2 would fall back to.
 * BOTH branches run the shared structural guard before any signer exists —
 * null/undefined digest is the Ed25519 path and additionally requires the
 * key to CLASSIFY as Ed25519, so a relabeled, marker-mismatched or
 * multi-envelope body that pemToDer would happily strip down to a signable
 * PKCS#8 form still refuses with the stable coded errors. */
export function sign(
  algorithm: string | null | undefined,
  data: Uint8Array | Buffer,
  key: string,
): Buffer | Error {
  try {
    if (algorithm === null || algorithm === undefined) {
      // Classify FIRST: pemToDer below discards every `-----` line and
      // cannot see envelope ambiguity. Encrypted headers stay advisory at
      // assessment but are never an authorization here, and an ECDSA
      // classification refuses with its own code before anything is seeded.
      if (classifyAllowedPrivateKey(key) !== 'ed25519') {
        throw unsupportedFormatError(
          'browser build refuses null-digest signing with a private key that does not classify as Ed25519',
        );
      }
      const der = pemToDer(key);
      if (!ed25519HasPrefix(der, PKCS8_ED25519_PREFIX)) {
        // Backstop only: an ed25519 classification already validated the
        // exact PKCS#8 Ed25519 shape (a cipher=none OpenSSH container
        // classifies ed25519 but is not the PKCS#8 DER this seeds from).
        return unsupportedFormatError('not a PKCS#8 Ed25519 private key');
      }
      // The PKCS8 body holds the 32-byte seed; tweetnacl signs with the
      // 64-byte secret key the seed expands to.
      const kp = nacl.sign.keyPair.fromSeed(der.slice(PKCS8_ED25519_PREFIX.length));
      // Buffer, not a plain view: ssh2's support probe checks
      // Buffer.isBuffer(sig) to decide whether Ed25519 exists at all.
      return NodeBuffer.from(nacl.sign.detached(new Uint8Array(data), kp.secretKey));
    }
    assertSignablePrivateKey(key);
    const signer = createSign(algorithm);
    signer.update(NodeBuffer.from(data));
    return signer.sign(key);
  } catch (ex) {
    return ex instanceof Error ? ex : new Error(String(ex));
  }
}

/** node crypto.verify: same shapes in, boolean out. A private key PEM is
 * accepted here too — the seed pair derives the verifying public key. */
export function verify(
  algorithm: string | null | undefined,
  data: Uint8Array | Buffer,
  key: string,
  signature: Uint8Array | Buffer,
): boolean | Error {
  try {
    if (algorithm === null || algorithm === undefined) {
      const der = pemToDer(key);
      let pub: Uint8Array | null = null;
      if (ed25519HasPrefix(der, SPKI_ED25519_PREFIX)) {
        pub = der.slice(SPKI_ED25519_PREFIX.length);
      } else if (ed25519HasPrefix(der, PKCS8_ED25519_PREFIX)) {
        pub = nacl.sign.keyPair.fromSeed(der.slice(PKCS8_ED25519_PREFIX.length)).publicKey;
      }
      if (pub === null) return new Error('not an Ed25519 key');
      return nacl.sign.detached.verify(
        new Uint8Array(data),
        new Uint8Array(signature),
        pub,
      );
    }
    const verifier = createVerify(algorithm);
    verifier.update(NodeBuffer.from(data));
    return verifier.verify(key, NodeBuffer.from(signature));
  } catch (ex) {    return ex instanceof Error ? ex : new Error(String(ex));
  }
}
