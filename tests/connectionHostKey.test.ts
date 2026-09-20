import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { verifyHostKey, type HostKeyInfo, type KnownHostsHooks } from '../src/terminal/connection';

// The hostVerifier decision body: trusted → proceed, mismatch → hard block
// (with the onMismatch surface), unknown → the TOFU decision. The desktop's
// SshService.hostVerifier is the contract twin.

function ed25519Blob(byte: number): Buffer {
  const type = Buffer.from('ssh-ed25519', 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(type.length, 0);
  return Buffer.concat([len, type, Buffer.alloc(32, byte)]);
}

interface Recording extends KnownHostsHooks {
  pinned: { host: string; port: number; pin: { keyType: string; keyB64: string } }[];
  mismatches: HostKeyInfo[];
}

function hooksOver(
  pins: Record<string, { keyType: string; keyB64: string } | undefined>,
  decide?: KnownHostsHooks['decide'],
): Recording {
  const rec: Recording = {
    pinned: [],
    mismatches: [],
    lookup: async (host, port) => pins[`${host}:${port}`],
    pin: async (host, port, pin) => void rec.pinned.push({ host, port, pin }),
    onMismatch: (info) => void rec.mismatches.push(info),
  };
  if (decide !== undefined) rec.decide = decide;
  return rec;
}

function opts() {
  return { host: 'devbox', port: 22, onStatus: (_s: string) => undefined };
}

describe('verifyHostKey', () => {
  it('a stored matching pin proceeds without prompting or pinning', async () => {
    const blob = ed25519Blob(1);
    const h = hooksOver({ 'devbox:22': { keyType: 'ssh-ed25519', keyB64: blob.toString('base64') } });
    const result = await verifyHostKey(h, opts(), blob);
    expect(result).toEqual({ ok: true });
    expect(h.pinned).toEqual([]);
  });

  it('a changed key hard-blocks and surfaces the mismatch', async () => {
    const blob = ed25519Blob(2);
    const stored = ed25519Blob(3).toString('base64');
    const h = hooksOver({ 'devbox:22': { keyType: 'ssh-ed25519', keyB64: stored } });
    const result = await verifyHostKey(h, opts(), blob);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/mismatch/i);
    expect(h.mismatches).toHaveLength(1);
    expect(h.mismatches[0]?.keyType).toBe('ssh-ed25519');
    expect(h.mismatches[0]?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(h.pinned).toEqual([]);
  });

  it('an unknown key with connect-and-pin persists the pin', async () => {
    const blob = ed25519Blob(4);
    const h = hooksOver({});
    const result = await verifyHostKey(h, opts(), blob);
    expect(result).toEqual({ ok: true });
    expect(h.pinned).toHaveLength(1);
    expect(h.pinned[0]?.host).toBe('devbox');
    expect(h.pinned[0]?.port).toBe(22);
    expect(h.pinned[0]?.pin.keyType).toBe('ssh-ed25519');
    expect(h.pinned[0]?.pin.keyB64).toBe(blob.toString('base64'));
  });

  it('an unknown key with connect-once proceeds WITHOUT persisting', async () => {
    const h = hooksOver({}, async () => 'once');
    const result = await verifyHostKey(h, opts(), ed25519Blob(5));
    expect(result).toEqual({ ok: true });
    expect(h.pinned).toEqual([]);
  });

  it('a rejected unknown key refuses the handshake', async () => {
    const h = hooksOver({}, async () => 'reject');
    const result = await verifyHostKey(h, opts(), ed25519Blob(6));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/rejected/i);
    expect(h.pinned).toEqual([]);
  });

  it('no decide hook (programmatic caller) defaults to pin-always', async () => {
    const h = hooksOver({});
    const result = await verifyHostKey(h, opts(), ed25519Blob(7));
    expect(result).toEqual({ ok: true });
    expect(h.pinned).toHaveLength(1);
  });

  it('a pin-store failure refuses the connection — never fails open', async () => {
    const h: KnownHostsHooks = {
      lookup: async () => {
        throw new Error('envelope unavailable');
      },
      pin: async () => undefined,
    };
    await expect(verifyHostKey(h, opts(), ed25519Blob(8))).rejects.toThrow('envelope unavailable');
  });

  it('the fingerprint is deterministic for the same key', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const h = hooksOver({ 'devbox:22': { keyType: 'ssh-ed25519', keyB64: 'old' } });
      await verifyHostKey(h, opts(), ed25519Blob(8));
      seen.add(h.mismatches[0]?.fingerprint ?? 'missing');
    }
    expect(seen.size).toBe(1);
  });
});
