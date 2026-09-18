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
 */
import cryptoBrowserify from 'crypto-browserify';
import { Buffer as NodeBuffer } from 'node:buffer';
import nacl from 'tweetnacl';

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
export const createSign = cryptoBrowserify.createSign.bind(cryptoBrowserify);
export const createVerify = cryptoBrowserify.createVerify.bind(cryptoBrowserify);
export const getCiphers = cryptoBrowserify.getCiphers.bind(cryptoBrowserify);
export const randomBytes = cryptoBrowserify.randomBytes.bind(cryptoBrowserify);
export const randomFillSync = cryptoBrowserify.randomFillSync.bind(cryptoBrowserify);

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
 * digest = RSA (DER) through the same createSign path ssh2 would fall back to. */
export function sign(
  algorithm: string | null,
  data: Uint8Array | Buffer,
  key: string,
): Buffer | Error {
  try {
    if (algorithm === null || algorithm === undefined) {
      const der = pemToDer(key);
      if (!ed25519HasPrefix(der, PKCS8_ED25519_PREFIX)) {
        return new Error('not an Ed25519 private key');
      }
      // The PKCS8 body holds the 32-byte seed; tweetnacl signs with the
      // 64-byte secret key the seed expands to.
      const kp = nacl.sign.keyPair.fromSeed(der.slice(PKCS8_ED25519_PREFIX.length));
      // Buffer, not a plain view: ssh2's support probe checks
      // Buffer.isBuffer(sig) to decide whether Ed25519 exists at all.
      return NodeBuffer.from(nacl.sign.detached(new Uint8Array(data), kp.secretKey));
    }
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
  algorithm: string | null,
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
