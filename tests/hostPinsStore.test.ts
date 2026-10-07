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

describe('gateway host pins (the pairing fingerprints)', () => {
  const FINGERPRINT =
    'SHA256:ABCDEFGHIJKLMNOPabcdefghijklmnop12345678901'; // 43 unpadded chars

  it('setGatewayPin normalizes the fingerprint and a fresh store reads it back', async () => {
    useHostsStore().passphrase = 'sync-pass';
    const pins = useHostPinsStore();
    const pin = await pins.setGatewayPin('dev-01', `  sha256:${FINGERPRINT.slice(7)}=  `);
    expect(pin).toEqual({ fingerprintSha256: FINGERPRINT });

    setActivePinia(createPinia());
    useHostsStore().passphrase = 'sync-pass';
    expect(await useHostPinsStore().gatewayLookup('dev-01')).toEqual({ fingerprintSha256: FINGERPRINT });
  });

  it('pairing refuses non-SHA-256 input — a bad paste never becomes a pin', async () => {
    useHostsStore().passphrase = 'sync-pass';
    const pins = useHostPinsStore();
    expect(await pins.setGatewayPin('dev-01', 'MD5:ab:cd:ef')).toBeNull();
    expect(await pins.setGatewayPin('dev-01', 'the host looked legit')).toBeNull();
    expect(await pins.gatewayLookup('dev-01')).toBeUndefined();
  });

  it('re-pairing (deliberate rotation) replaces the pin', async () => {
    useHostsStore().passphrase = 'sync-pass';
    const pins = useHostPinsStore();
    await pins.setGatewayPin('dev-01', FINGERPRINT);
    await pins.setGatewayPin('dev-01', 'SHA256:zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJ');
    expect((await pins.gatewayLookup('dev-01'))!.fingerprintSha256).toBe(
      'SHA256:zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJ',
    );
  });

  it('forgetGatewayPin drops the pairing; legacy pins are untouched by all of it', async () => {
    useHostsStore().passphrase = 'sync-pass';
    const pins = useHostPinsStore();
    await pins.pin('legacy-host', 22, PIN);
    await pins.setGatewayPin('dev-01', FINGERPRINT);
    await pins.forgetGatewayPin('dev-01');
    expect(await pins.gatewayLookup('dev-01')).toBeUndefined();
    expect(await pins.lookup('legacy-host', 22)).toEqual(PIN);
  });

  it('a corrupt gatewayPins map degrades to empty without touching the pins map', async () => {
    useHostsStore().passphrase = 'sync-pass';
    const pins = useHostPinsStore();
    await pins.pin('legacy-host', 22, PIN);
    await pins.setGatewayPin('dev-01', FINGERPRINT);
    // Hand-corrupt the envelope's inner payload: re-encrypt a payload with a
    // nonsense gatewayPins value under the same passphrase.
    const { decryptEnvelope, encryptToEnvelope } = await import('../src/shared/syncCrypto');
    const raw = localStorage.getItem('ps.hostPins')!;
    const plaintext = await decryptEnvelope(raw, 'sync-pass');
    const parsed = JSON.parse(plaintext) as { gatewayPins: unknown };
    parsed.gatewayPins = { 'dev-01': { fingerprintSha256: 42 }, junk: 'x' };
    localStorage.setItem('ps.hostPins', await encryptToEnvelope(JSON.stringify(parsed), 'sync-pass'));
    setActivePinia(createPinia());
    useHostsStore().passphrase = 'sync-pass';
    const fresh = useHostPinsStore();
    expect(await fresh.gatewayLookup('dev-01')).toBeUndefined();
    expect(await fresh.lookup('legacy-host', 22)).toEqual(PIN);
  });
});
