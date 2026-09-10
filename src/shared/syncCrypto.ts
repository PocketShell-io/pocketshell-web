/**
 * Browser twin of PocketShell-io/pocketshell-desktop's
 * src/main/sync/SyncCrypto.ts — same envelope, different runtime. The
 * desktop derives with node:crypto, the browser with WebCrypto; the shared
 * format is what makes a blob written by one readable by the other:
 *
 *     { "v": 1, "kdf": "pbkdf2-sha256", "iter": 600000,
 *       "salt": "<b64 16B>", "iv": "<b64 12B>", "ct": "<b64 ct+tag>" }
 *
 * salt/iv travel inside the envelope, so one passphrase decrypts anywhere.
 * A wrong passphrase or corrupted blob fails the GCM tag check — never
 * garbage output. tests/syncCrypto.test.ts proves interop with the desktop
 * format in both directions.
 *
 * Vendoring policy: types/syncMerge/sync/syncConfig are copied verbatim by
 * scripts/sync-shared.sh; this file is hand-maintained because the runtime
 * differs — change it in lockstep with the desktop's SyncCrypto.
 */

const FORMAT_VERSION = 1;
const KDF_NAME = 'pbkdf2-sha256';
export const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The serialized envelope: exactly the JSON string the server stores as `data`. */
export type EnvelopeString = string;

interface EnvelopeFields {
  v: number;
  kdf: string;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

/**
 * Everything that can go wrong while decrypting, as one error type the UI
 * renders as a message: not the passphrase, a malformed envelope, or a blob
 * that is not ours. Same contract as the desktop's SyncCryptoError.
 */
export class SyncCryptoError extends Error {}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(value: string, what: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // The round-trip catches what atob tolerates silently: anything base64
  // cannot represent does not survive it (same check as the desktop).
  if (b64encode(out).replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new SyncCryptoError(`envelope ${what} is not valid base64`);
  }
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt [plaintext] under [passphrase] into the serialized envelope.
 * Fresh salt and IV on every call, so encrypting the same settings twice
 * never produces the same blob. (Async where the desktop is sync — the
 * browser's PBKDF2 is asynchronous by spec.)
 */
export async function encryptToEnvelope(plaintext: string, passphrase: string): Promise<EnvelopeString> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  const fields: EnvelopeFields = {
    v: FORMAT_VERSION,
    kdf: KDF_NAME,
    iter: KDF_ITERATIONS,
    salt: b64encode(salt),
    iv: b64encode(iv),
    ct: b64encode(new Uint8Array(ct)),
  };
  return JSON.stringify(fields);
}

/**
 * Reverse {@link encryptToEnvelope}. Throws {@link SyncCryptoError} for a
 * malformed envelope and for ANY decryption failure — GCM cannot
 * distinguish "wrong passphrase" from "corrupted blob", and neither message
 * should pretend to know which.
 */
export async function decryptEnvelope(envelope: EnvelopeString, passphrase: string): Promise<string> {
  let fields: unknown;
  try {
    fields = JSON.parse(envelope);
  } catch {
    throw new SyncCryptoError('stored blob is not a sync envelope');
  }
  if (typeof fields !== 'object' || fields === null) {
    throw new SyncCryptoError('stored blob is not a sync envelope');
  }
  const f = fields as Record<string, unknown>;
  if (f['v'] !== FORMAT_VERSION || f['kdf'] !== KDF_NAME) {
    throw new SyncCryptoError(`envelope this app cannot read (v=${String(f['v'])}, kdf=${String(f['kdf'])})`);
  }
  if (typeof f['iter'] !== 'number' || typeof f['salt'] !== 'string' || typeof f['iv'] !== 'string' || typeof f['ct'] !== 'string') {
    throw new SyncCryptoError('envelope is missing required fields');
  }
  if (f['iter'] < 1 || f['iter'] > 10_000_000) {
    // The iteration count is attacker-controlled input (it is in the blob)
    // and feeds PBKDF2's loop — bounded before use, as on the desktop.
    throw new SyncCryptoError('envelope iteration count is out of range');
  }
  const key = await deriveKey(passphrase, b64decode(f['salt'], 'salt'), f['iter']);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(f['iv'], 'iv') as BufferSource },
      key,
      b64decode(f['ct'], 'ct') as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new SyncCryptoError('could not decrypt the stored blob (wrong passphrase or corrupted blob)');
  }
}
