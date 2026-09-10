/**
 * The zero-knowledge envelope, byte-compatible with the desktop app's
 * SyncCrypto (pocketshell-desktop src/main/sync/SyncCrypto.ts):
 *
 *   key   = PBKDF2(HMAC-SHA-256, passphrase, salt, iter, 256 bits)
 *   ct    = AES-256-GCM(key, iv, plaintext)
 *
 * salt is 16 bytes, iv is 12 bytes, both base64 in the header. The same
 * passphrase decrypts on any machine because the salt travels in the blob.
 */
import type { SyncEnvelope } from '../types';

const ITERATIONS = 600_000;

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt plaintext into the serialized envelope string. */
export async function encryptEnvelope(plaintext: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  const envelope: SyncEnvelope = {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iter: ITERATIONS,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
  };
  return JSON.stringify(envelope);
}

export class DecryptError extends Error {
  constructor() {
    super('wrong passphrase or corrupted blob');
  }
}

/** Decrypt a serialized envelope string back to plaintext. */
export async function decryptEnvelope(envelopeJson: string, passphrase: string): Promise<string> {
  let envelope: SyncEnvelope;
  try {
    envelope = JSON.parse(envelopeJson) as SyncEnvelope;
  } catch {
    throw new DecryptError();
  }
  if (envelope.kdf !== 'pbkdf2-sha256' || typeof envelope.ct !== 'string') throw new DecryptError();
  const key = await deriveKey(passphrase, b64ToBytes(envelope.salt), envelope.iter);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) as BufferSource },
      key,
      b64ToBytes(envelope.ct) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new DecryptError();
  }
}
