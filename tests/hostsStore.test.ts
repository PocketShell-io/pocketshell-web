import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// The web as a sync WRITER: saveHost against a fake SyncService, with real
// envelopes (syncCrypto is pure WebCrypto) so each captured push decrypts to
// exactly the payload the store meant to upload.

// The factory is self-contained (no importOriginal — src/config.ts touches
// window, which node tests do not have), and src/config.ts itself needs a
// `window` before any import of the store runs, so vi.hoisted plants one —
// plus the Web Storage backends the auth and hosts stores touch at import
// and at save time.
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
  pulls: [] as ({ version: number; plaintext: string } | null)[],
  pushResults: [] as ('ok' | 'conflict')[],
  pushes: [] as { envelope: string; baseVersion: number }[],
  nextVersion: 0,
  reset() {
    fake.pulls.length = 0;
    fake.pushResults.length = 0;
    fake.pushes.length = 0;
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
      pull: () => Promise.resolve(fake.pulls.length === 0 ? null : fake.pulls.shift()),
      push: (_slot: string, envelope: string, baseVersion: number) => {
        fake.pushes.push({ envelope, baseVersion });
        const outcome = fake.pushResults.shift() ?? 'ok';
        if (outcome === 'conflict') return Promise.reject(new SyncConflictError(++fake.nextVersion));
        return Promise.resolve({ version: ++fake.nextVersion });
      },
    }),
  };
});

import { decryptEnvelope, encryptToEnvelope } from '../src/shared/syncCrypto';
import { serializeSyncPayload } from '../src/shared/syncMerge';
import { useHostsStore } from '../src/stores/hosts';
import type { HostEntry } from '../src/shared/types';

const PASSPHRASE = 'correct horse';

function host(name: string, hostname = `${name}.example.com`): HostEntry {
  return { name, hostname, port: 22, user: '', identityFile: null, proxyJump: null, forwardAgent: false, localForwards: [], remoteForwards: [], fromConfig: true };
}

/** A slot blob exactly as the real pull returns it: the envelope, not plaintext. */
async function pullBlob(version: number, hosts: HostEntry[]) {
  return { version, data: await encryptToEnvelope(serializeSyncPayload(hosts), PASSPHRASE) };
}

async function payloadOf(call: { envelope: string }): Promise<HostEntry[]> {
  return JSON.parse(await decryptEnvelope(call.envelope, PASSPHRASE)).hosts;
}

beforeEach(() => {
  setActivePinia(createPinia());
  fake.reset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('hosts store saveHost (the web pushing to the account slot)', () => {
  it('pushes the pulled list with the new entry upserted, and adopts the returned version', async () => {
    const store = useHostsStore();
    fake.pulls.push(await pullBlob(4, [host('a')]));
    await store.unlock(PASSPHRASE);

    await store.saveHost(host('b'));

    expect(fake.pushes).toHaveLength(1);
    expect(fake.pushes[0]!.baseVersion).toBe(4);
    expect((await payloadOf(fake.pushes[0]!)).map((h) => h.name)).toEqual(['a', 'b']);
    expect(store.version).toBe(1);
    expect(store.hosts.map((h) => h.name)).toEqual(['a', 'b']);
  });

  it('on a 409 re-applies only the saved entry to the FRESH blob, not the stale browser list', async () => {
    const store = useHostsStore();
    // The browser pulled at version 5; the desktop has since pushed a
    // different set at version 6 (say, without 'b' — the user unticked it).
    fake.pulls.push(await pullBlob(5, [host('b')]));
    await store.unlock(PASSPHRASE);
    fake.pulls.push(await pullBlob(6, [host('a', 'desktops-fresh.example.com')]));

    fake.pushResults.push('conflict', 'ok');
    await store.saveHost(host('c'));

    expect(fake.pushes).toHaveLength(2);
    expect(fake.pushes[1]!.baseVersion).toBe(6);
    const names = (await payloadOf(fake.pushes[1]!)).map((h) => h.name);
    expect(names).toEqual(['a', 'c']); // 'b' stays gone: the desktop's untick must not be reverted
    expect(store.version).toBe(2);
  });

  it('retries conflicts up to three rounds before surfacing the error', async () => {
    const store = useHostsStore();
    store.passphrase = PASSPHRASE;
    store.version = 3;
    store.hosts = [host('b')];
    // Two fresh blobs to re-base on during the two retries.
    fake.pulls.push(await pullBlob(4, [host('a')]), await pullBlob(5, [host('a')]));
    fake.pushResults.push('conflict', 'conflict', 'conflict');

    await expect(store.saveHost(host('c'))).rejects.toThrow(/slot changed/);
    expect(fake.pushes).toHaveLength(3);
  });

  it('refuses to resurrect a slot that was deleted between our pull and push', async () => {
    const store = useHostsStore();
    store.passphrase = PASSPHRASE;
    store.version = 3;
    store.hosts = [host('b')];
    fake.pulls.push(null);
    fake.pushResults.push('conflict');

    await expect(store.saveHost(host('c'))).rejects.toThrow(/reload/);
    expect(fake.pushes).toHaveLength(1);
  });
});

describe('hosts store importHosts (the config import writing the ticked set)', () => {
  it('lands the whole imported set in ONE push, merged after the existing list', async () => {
    const store = useHostsStore();
    fake.pulls.push(await pullBlob(2, [host('a')]));
    await store.unlock(PASSPHRASE);

    await store.importHosts([host('b'), host('c')]);

    expect(fake.pushes).toHaveLength(1);
    expect((await payloadOf(fake.pushes[0]!)).map((h) => h.name)).toEqual(['a', 'b', 'c']);
    expect(store.hosts.map((h) => h.name)).toEqual(['a', 'b', 'c']);
    expect(store.version).toBe(1);
  });

  it('upserts over existing names and is a no-op for an empty selection', async () => {
    const store = useHostsStore();
    fake.pulls.push(await pullBlob(1, [host('a', 'old.example.com')]));
    await store.unlock(PASSPHRASE);

    await store.importHosts([host('a', 'fresh.example.com')]);
    expect((await payloadOf(fake.pushes[0]!)).map((h) => h.hostname)).toEqual(['fresh.example.com']);

    await store.importHosts([]);
    expect(fake.pushes).toHaveLength(1);
  });

  it('on a 409 re-applies the whole imported set to the fresh blob', async () => {
    const store = useHostsStore();
    fake.pulls.push(await pullBlob(5, [host('b')]));
    await store.unlock(PASSPHRASE);
    // The desktop pushed a fresh blob (only 'a') while the import ran.
    fake.pulls.push(await pullBlob(6, [host('a')]));
    fake.pushResults.push('conflict', 'ok');

    await store.importHosts([host('c'), host('d')]);

    const names = (await payloadOf(fake.pushes[1]!)).map((h) => h.name);
    expect(names).toEqual(['a', 'c', 'd']);
  });
});

describe('hosts store secrets (key + key passphrase, encrypted before anything leaves)', () => {
  it('stores the key passphrase with the key and returns it; the local envelope never holds plaintext', async () => {
    const store = useHostsStore();
    store.passphrase = PASSPHRASE;

    await store.setHostSecret('a', { privateKeyPem: '-----BEGIN TEST KEY-----', keyPassphrase: 'open-sesame' });

    expect(await store.getHostSecret('a')).toEqual({ privateKeyPem: '-----BEGIN TEST KEY-----', keyPassphrase: 'open-sesame' });
    expect(store.secretHosts).toEqual(['a']);
    const raw = localStorage.getItem('ps.hostKeys')!;
    expect(raw).not.toContain('BEGIN TEST KEY');
    expect(raw).not.toContain('open-sesame');
    // Same envelope shape the account uses: opaque without the passphrase.
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kdf: 'pbkdf2-sha256' });
  });

  it('a passphrase alone is not a usable credential for the secret-hosts marker', async () => {
    const store = useHostsStore();
    store.passphrase = PASSPHRASE;
    await store.setHostSecret('a', { keyPassphrase: 'orphan' });
    expect(store.secretHosts).toEqual([]);
  });
});
