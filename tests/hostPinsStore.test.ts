import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// The browser's known_hosts: pins live in one localStorage envelope
// (`ps.hostPins`) encrypted with the sync passphrase — the same at-rest
// treatment as the keys cache. Round-trips here run the REAL
// encryptToEnvelope/decryptEnvelope (pure WebCrypto), so what a pin()
// persists is exactly what a later ensure() classifies against.

vi.hoisted(() => {
  const memoryStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => void map.clear(),
    };
  };
  const g = globalThis as Record<string, unknown>;
  g['window'] ??= { POCKETSHELL_WEB: {} };
  g['localStorage'] ??= memoryStorage();
  g['sessionStorage'] ??= memoryStorage();
});

// The pins store reaches the hosts store for the session passphrase; the
// hosts store imports the sync API, which needs a window before import.
vi.mock('../src/api/sync', () => ({
  SyncConflictError: class SyncConflictError extends Error {},
  makeSyncService: () => {
    throw new Error('sync is not used by the pins store');
  },
}));

import { useHostPinsStore } from '../src/stores/hostPins';
import { useHostsStore } from '../src/stores/hosts';

const PIN = { keyType: 'ssh-ed25519', keyB64: 'QUJDREVGRw==' };

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

describe('hostPins store', () => {
  it('without the sync passphrase, lookups report unknown (ask again)', async () => {
    const pins = useHostPinsStore();
    expect(await pins.lookup('devbox', 22)).toBeUndefined();
    expect(pins.loaded).toBe(false);
  });

  it('pin() persists an envelope a later store reads back', async () => {
    useHostsStore().passphrase = 'sync-pass';
    const pins = useHostPinsStore();
    await pins.pin('devbox', 22, PIN);
    expect(localStorage.getItem('ps.hostPins')).not.toBeNull();

    // A fresh store (page reload): same passphrase, decrypts the same pin.
    setActivePinia(createPinia());
    useHostsStore().passphrase = 'sync-pass';
    const fresh = useHostPinsStore();
    expect(await fresh.lookup('devbox', 22)).toEqual(PIN);
  });

  it('pins are keyed [host]:port on non-default ports', async () => {
    useHostsStore().passphrase = 'sync-pass';
    const pins = useHostPinsStore();
    await pins.pin('devbox', 3205, PIN);
    expect(await pins.lookup('devbox', 3205)).toEqual(PIN);
    expect(await pins.lookup('devbox', 22)).toBeUndefined();
  });

  it('forget() removes the pin so the next connect is a first use', async () => {
    useHostsStore().passphrase = 'sync-pass';
    const pins = useHostPinsStore();
    await pins.pin('devbox', 22, PIN);
    await pins.forget('devbox', 22);
    expect(await pins.lookup('devbox', 22)).toBeUndefined();
    setActivePinia(createPinia());
    useHostsStore().passphrase = 'sync-pass';
    expect(await useHostPinsStore().lookup('devbox', 22)).toBeUndefined();
  });

  it('an envelope under a different passphrase degrades to empty', async () => {
    useHostsStore().passphrase = 'first';
    await useHostPinsStore().pin('devbox', 22, PIN);
    setActivePinia(createPinia());
    useHostsStore().passphrase = 'changed';
    expect(await useHostPinsStore().lookup('devbox', 22)).toBeUndefined();
  });

  it('garbage in storage parses to an empty map', async () => {
    useHostsStore().passphrase = 'sync-pass';
    localStorage.setItem('ps.hostPins', 'not an envelope');
    expect(await useHostPinsStore().lookup('devbox', 22)).toBeUndefined();
  });
});
