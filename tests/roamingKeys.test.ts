import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// Roaming secrets: the keys slot. The point of the feature — a key attached
// on one device (the desktop) must make the same host usable on another
// (the tablet) after a plain unlock, with the server holding only another
// sync envelope it cannot open.

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

const fake = vi.hoisted(() => ({
  mainPulls: [] as unknown[],
  keyPulls: [] as unknown[],
  keyPushes: [] as { envelope: string; baseVersion: number }[],
  keyPushResults: [] as ('ok' | 'conflict')[],
  keyPullFailure: null as Error | null,
  nextVersion: 0,
  reset() {
    fake.mainPulls.length = 0;
    fake.keyPulls.length = 0;
    fake.keyPushes.length = 0;
    fake.keyPushResults.length = 0;
    fake.keyPullFailure = null;
    fake.nextVersion = 0;
  },
}));

vi.mock('../src/api/sync', () => {
  class SyncConflictError extends Error {
    readonly currentVersion: number;
    constructor(currentVersion: number) {
      super(`slot changed under us (stored version ${currentVersion})`);
      this.currentVersion = currentVersion;
    }
  }
  return {
    SyncConflictError,
    makeSyncService: () => ({
      pull: (slot: string) => {
        if (slot === 'keys') {
          if (fake.keyPullFailure) return Promise.reject(fake.keyPullFailure);
          return Promise.resolve(fake.keyPulls.length === 0 ? null : fake.keyPulls.shift());
        }
        return Promise.resolve(fake.mainPulls.length === 0 ? null : fake.mainPulls.shift());
      },
      push: (slot: string, envelope: string, baseVersion: number) => {
        if (slot !== 'keys') return Promise.resolve({ version: ++fake.nextVersion });
        fake.keyPushes.push({ envelope, baseVersion });
        const outcome = fake.keyPushResults.shift() ?? 'ok';
        if (outcome === 'conflict') return Promise.reject(new SyncConflictError(++fake.nextVersion));
        return Promise.resolve({ version: ++fake.nextVersion });
      },
    }),
  };
});

import { decryptEnvelope, encryptToEnvelope } from '../src/shared/syncCrypto';
import { serializeSyncPayload } from '../src/shared/syncMerge';
import { useHostsStore, type HostSecret } from '../src/stores/hosts';
import type { HostEntry } from '../src/shared/types';

const PASSPHRASE = 'correct horse';

function host(name: string): HostEntry {
  return { name, hostname: `${name}.example.com`, port: 22, user: '', identityFile: null, proxyJump: null, forwardAgent: false, localForwards: [], remoteForwards: [], fromConfig: true };
}

async function keysBlob(version: number, secrets: Record<string, HostSecret>) {
  return { version, data: await encryptToEnvelope(JSON.stringify({ v: 1, secrets }), PASSPHRASE) };
}

async function pushedSecretsOf(call: { envelope: string }): Promise<Record<string, HostSecret>> {
  const parsed: unknown = JSON.parse(await decryptEnvelope(call.envelope, PASSPHRASE));
  return (parsed as { secrets: Record<string, HostSecret> }).secrets;
}

beforeEach(() => {
  setActivePinia(createPinia());
  fake.reset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('roaming secrets (the keys slot)', () => {
  it('a key synced from another device marks the host usable here after unlock', async () => {
    const store = useHostsStore();
    fake.mainPulls.push({ version: 3, data: await encryptToEnvelope(serializeSyncPayload([host('hetzner')]), PASSPHRASE) });
    fake.keyPulls.push(await keysBlob(2, { hetzner: { privateKeyPem: '-----BEGIN SYNCED KEY-----' } }));

    await store.unlock(PASSPHRASE);

    expect(store.secretHosts).toEqual(['hetzner']);
    expect((await store.getHostSecret('hetzner'))?.privateKeyPem).toContain('SYNCED KEY');
  });

  it('uploads keys only this browser had, exactly once — the migration path', async () => {
    const store = useHostsStore();
    // The pre-roaming install: a local envelope, nothing in the account.
    localStorage.setItem('ps.hostKeys', await encryptToEnvelope(JSON.stringify({ v: 1, secrets: { hetzner: { privateKeyPem: '-----BEGIN LOCAL KEY-----' } } }), PASSPHRASE));
    fake.mainPulls.push(null);

    await store.unlock(PASSPHRASE);

    expect(fake.keyPushes).toHaveLength(1);
    expect(fake.keyPushes[0]!.baseVersion).toBe(0);
    expect(await pushedSecretsOf(fake.keyPushes[0]!)).toEqual({ hetzner: { privateKeyPem: '-----BEGIN LOCAL KEY-----' } });

    // Second unlock: the account has it, nothing new to push.
    fake.mainPulls.push(null);
    fake.keyPulls.push(await keysBlob(1, { hetzner: { privateKeyPem: '-----BEGIN LOCAL KEY-----' } }));
    await store.unlock(PASSPHRASE);
    expect(fake.keyPushes).toHaveLength(1);
  });

  it('on a 409 keeps the other device key and re-applies ours per host', async () => {
    const store = useHostsStore();
    fake.mainPulls.push(null);
    fake.keyPulls.push(await keysBlob(4, { desktop: { privateKeyPem: '-----BEGIN DESKTOP KEY-----' } }));
    await store.unlock(PASSPHRASE);

    fake.keyPulls.push(await keysBlob(5, { tablet: { privateKeyPem: '-----BEGIN TABLET KEY-----' } }));
    fake.keyPushResults.push('conflict', 'ok');
    await store.setHostSecret('hetzner', { privateKeyPem: '-----BEGIN NEW KEY-----' });

    expect(fake.keyPushes).toHaveLength(2);
    expect(fake.keyPushes[1]!.baseVersion).toBe(5);
    const merged = await pushedSecretsOf(fake.keyPushes[1]!);
    expect(Object.keys(merged).sort()).toEqual(['desktop', 'hetzner', 'tablet']);
    expect(merged['hetzner']!.privateKeyPem).toContain('NEW KEY');
    expect(store.keyVersion).toBe(2);
  });

  it('a keys-slot outage degrades to the local cache instead of failing the unlock', async () => {
    const store = useHostsStore();
    localStorage.setItem('ps.hostKeys', await encryptToEnvelope(JSON.stringify({ v: 1, secrets: { hetzner: { privateKeyPem: '-----BEGIN CACHED KEY-----' } } }), PASSPHRASE));
    fake.mainPulls.push({ version: 1, data: await encryptToEnvelope(serializeSyncPayload([host('hetzner')]), PASSPHRASE) });
    fake.keyPullFailure = new Error('API down');

    await store.unlock(PASSPHRASE);

    expect(store.hosts.map((h) => h.name)).toEqual(['hetzner']);
    expect(store.secretHosts).toEqual(['hetzner']);
  });

  it('removeHostSecret deletes the record from the account, not just locally', async () => {
    const store = useHostsStore();
    fake.mainPulls.push(null);
    fake.keyPulls.push(await keysBlob(1, { hetzner: { privateKeyPem: '-----BEGIN KEY-----' }, other: { password: 'x' } }));
    await store.unlock(PASSPHRASE);

    await store.removeHostSecret('hetzner');

    const pushed = await pushedSecretsOf(fake.keyPushes[0]!);
    expect(Object.keys(pushed)).toEqual(['other']);
    expect(store.secretHosts).toEqual(['other']);
  });
});
