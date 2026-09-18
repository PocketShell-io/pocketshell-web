import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The vault's contract: a two-halves secret (non-extractable AES-GCM key in
// IndexedDB, ciphertext in localStorage) that round-trips only for the
// account that saved it, and fails closed — any unreadable combination
// returns null and cleans up instead of leaving a stale blob behind.
// fake-indexeddb exercises the real IDB wrapper; Node structured-clones
// non-extractable CryptoKeys faithfully, so the key really lives in the
// database, not in a test double.

// Node has no Web Storage; the vault touches localStorage at call time, so a
// fresh backend per test keeps the per-account namespacing observable.
vi.hoisted(() => {
  const map = new Map<string, string>();
  const memoryStorage = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => void map.clear(),
  };
  (globalThis as Record<string, unknown>)['localStorage'] ??= memoryStorage;
});

import {
  forgetPassphrase,
  hasVault,
  recallPassphrase,
  rememberPassphrase,
  vaultBlobKey,
} from '../src/shared/passphraseVault';

const SUB = '1234567890abcdef';
const OTHER = 'fedcba0987654321';
const PASSPHRASE = 'correct horse battery';

beforeEach(() => {
  localStorage.clear();
  indexedDB = new IDBFactory(); // eslint-disable-line no-global-assign
});

describe('passphraseVault', () => {
  it('round-trips the passphrase and never stores it in the clear', async () => {
    await rememberPassphrase(SUB, PASSPHRASE);
    expect(hasVault(SUB)).toBe(true);
    const raw = localStorage.getItem(vaultBlobKey(SUB))!;
    expect(raw).not.toContain(PASSPHRASE);
    const blob = JSON.parse(raw);
    expect(blob.v).toBe(1);
    expect(typeof blob.iv).toBe('string');
    expect(typeof blob.ct).toBe('string');
    expect(await recallPassphrase(SUB)).toBe(PASSPHRASE);
  });

  it('fresh IV per save: two saves of the same passphrase differ', async () => {
    await rememberPassphrase(SUB, PASSPHRASE);
    const first = localStorage.getItem(vaultBlobKey(SUB));
    await rememberPassphrase(SUB, PASSPHRASE);
    expect(localStorage.getItem(vaultBlobKey(SUB))).not.toBe(first);
    expect(await recallPassphrase(SUB)).toBe(PASSPHRASE);
  });

  it('namespaces by account: two subs never read each other', async () => {
    await rememberPassphrase(SUB, 'one');
    await rememberPassphrase(OTHER, 'two');
    expect(await recallPassphrase(SUB)).toBe('one');
    expect(await recallPassphrase(OTHER)).toBe('two');
  });

  it('a tampered blob fails closed and removes itself', async () => {
    await rememberPassphrase(SUB, PASSPHRASE);
    const blob = JSON.parse(localStorage.getItem(vaultBlobKey(SUB))!);
    blob.ct = blob.ct.slice(0, -4) + 'AAAA';
    localStorage.setItem(vaultBlobKey(SUB), JSON.stringify(blob));
    expect(await recallPassphrase(SUB)).toBeNull();
    expect(hasVault(SUB)).toBe(false);
  });

  it('a blob whose key is gone fails closed and removes itself', async () => {
    // The half that survives a one-sided IndexedDB wipe: a well-shaped blob
    // with no key ever generated for this sub.
    localStorage.setItem(
      vaultBlobKey(SUB),
      JSON.stringify({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAA' }),
    );
    expect(await recallPassphrase(SUB)).toBeNull();
    expect(hasVault(SUB)).toBe(false);
  });

  it('a malformed blob fails closed and removes itself', async () => {
    localStorage.setItem(vaultBlobKey(SUB), '{"v":1,"iv":');
    expect(await recallPassphrase(SUB)).toBeNull();
    expect(hasVault(SUB)).toBe(false);
  });

  it('forget removes the blob and the key, and a re-save works after it', async () => {
    await rememberPassphrase(SUB, PASSPHRASE);
    await forgetPassphrase(SUB);
    expect(hasVault(SUB)).toBe(false);
    expect(await recallPassphrase(SUB)).toBeNull();
    await rememberPassphrase(SUB, 'again');
    expect(await recallPassphrase(SUB)).toBe('again');
  });

  it('forget for one account leaves the other untouched', async () => {
    await rememberPassphrase(SUB, 'one');
    await rememberPassphrase(OTHER, 'two');
    await forgetPassphrase(SUB);
    expect(await recallPassphrase(OTHER)).toBe('two');
    expect(hasVault(SUB)).toBe(false);
  });
});
