import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptEnvelope, encryptToEnvelope, SyncCryptoError } from '../src/shared/syncCrypto';

// Independent implementation of the desktop's envelope writer
// (PocketShell-io/pocketshell-desktop src/main/sync/SyncCrypto.ts, which
// uses node:crypto) — if decryptEnvelope reads one of these, it reads a
// real desktop blob.
function desktopStyleEnvelope(plaintext: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 600_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    v: 1,
    kdf: 'pbkdf2-sha256',
    iter: 600000,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
  });
}

// And the reverse: a node-side reader for what the browser wrote.
function desktopStyleDecrypt(envelope: string, passphrase: string): string {
  const f = JSON.parse(envelope) as { iter: number; salt: string; iv: string; ct: string };
  const key = pbkdf2Sync(passphrase, Buffer.from(f.salt, 'base64'), f.iter, 32, 'sha256');
  const data = Buffer.from(f.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
}

const payload = JSON.stringify({
  hosts: [{ name: 'hetzner', hostname: '135.181.114.209', port: 22, user: 'alexey' }],
});

describe('sync envelope (browser twin of the desktop SyncCrypto)', () => {
  it('round-trips through encrypt → decrypt', async () => {
    const envelope = await encryptToEnvelope(payload, 'correct horse');
    expect(JSON.parse(envelope)).toMatchObject({ v: 1, kdf: 'pbkdf2-sha256', iter: 600000 });
    expect(await decryptEnvelope(envelope, 'correct horse')).toBe(payload);
  }, 30_000);

  it('decrypts an envelope the DESKTOP (node:crypto) would have written', async () => {
    const envelope = desktopStyleEnvelope(payload, 'passphrase');
    expect(await decryptEnvelope(envelope, 'passphrase')).toBe(payload);
  }, 30_000);

  it('writes envelopes the DESKTOP (node:crypto) can decrypt', async () => {
    const envelope = await encryptToEnvelope(payload, 'passphrase');
    expect(desktopStyleDecrypt(envelope, 'passphrase')).toBe(payload);
  }, 30_000);

  it('rejects a wrong passphrase without leaking plaintext', async () => {
    const envelope = await encryptToEnvelope(payload, 'right');
    await expect(decryptEnvelope(envelope, 'wrong')).rejects.toBeInstanceOf(SyncCryptoError);
  }, 30_000);

  it('uses a 16-byte salt and a 12-byte IV, like the desktop format', async () => {
    const envelope = await encryptToEnvelope(payload, 'p');
    const fields = JSON.parse(envelope) as { salt: string; iv: string };
    expect(atob(fields.salt).length).toBe(16);
    expect(atob(fields.iv).length).toBe(12);
  }, 30_000);
});
