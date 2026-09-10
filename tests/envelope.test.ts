import { describe, expect, it } from 'vitest';
import { decryptEnvelope, encryptToEnvelope, SyncCryptoError } from '../src/shared/syncCrypto';

// Independent implementation of the documented envelope format
// (aws-infra sandbox/pocketshell-sync docs/CLIENT-INTEGRATION.md) — the
// desktop app writes this exact shape, so if decryptEnvelope reads one of
// these, it reads a real desktop blob.
async function desktopStyleEnvelope(plaintext: string, passphrase: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return JSON.stringify({
    v: 1,
    kdf: 'pbkdf2-sha256',
    iter: 600000,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(new Uint8Array(ct)),
  });
}

const payload = JSON.stringify({
  hosts: [{ name: 'hetzner', hostname: '135.181.114.209', port: 22, user: 'alexey' }],
});

describe('sync envelope', () => {
  it('round-trips through encrypt → decrypt', async () => {
    const envelope = await encryptToEnvelope(payload, 'correct horse');
    expect(JSON.parse(envelope)).toMatchObject({ v: 1, kdf: 'pbkdf2-sha256', iter: 600000 });
    expect(await decryptEnvelope(envelope, 'correct horse')).toBe(payload);
  }, 30_000);

  it('decrypts a desktop-format envelope built independently', async () => {
    const envelope = await desktopStyleEnvelope(payload, 'passphrase');
    expect(await decryptEnvelope(envelope, 'passphrase')).toBe(payload);
  }, 30_000);

  it('rejects a wrong passphrase without leaking plaintext', async () => {
    const envelope = await encryptToEnvelope(payload, 'right');
    await expect(decryptEnvelope(envelope, 'wrong')).rejects.toBeInstanceOf(SyncCryptoError);
  }, 30_000);

  it('uses a 16-byte salt and a 12-byte IV', async () => {
    const envelope = await encryptToEnvelope(payload, 'p');
    const fields = JSON.parse(envelope) as { salt: string; iv: string };
    expect(atob(fields.salt).length).toBe(16);
    expect(atob(fields.iv).length).toBe(12);
  }, 30_000);
});
