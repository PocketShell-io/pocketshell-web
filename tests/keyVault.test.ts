import { IDBFactory } from 'fake-indexeddb';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// The web key vault end to end, over an in-memory settings server with the
// real API's semantics (versioned slots, 409 on a stale base, 404 absent):
// first setup, unlock (wrong passphrase + backoff), remember-on-device,
// one passphrase opening the host list too, keys bound to hosts and
// decrypted on connect, change passphrase, reset, and the hard-cut
// migration of the legacy `keys` slot. Keys are throwaway ssh-keygen output.

vi.hoisted(() => {
  const memoryStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => void map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    };
  };
  const g = globalThis as Record<string, unknown>;
  g['window'] ??= { POCKETSHELL_WEB: {} };
  g['localStorage'] ??= memoryStorage();
  g['sessionStorage'] ??= memoryStorage();
});

const server = vi.hoisted(() => ({
  slots: new Map<string, { version: number; data: string }>(),
  pushes: [] as { slot: string; data: string }[],
  reset() {
    server.slots.clear();
    server.pushes.length = 0;
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
  class SyncApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  class NotSignedInError extends Error {}
  return {
    SyncConflictError,
    SyncApiError,
    NotSignedInError,
    makeSyncService: () => ({
      pull: async (slot: string) => {
        const s = server.slots.get(slot);
        return s ? { slot, version: s.version, data: s.data } : null;
      },
      push: async (slot: string, data: string, baseVersion: number) => {
        if (new TextEncoder().encode(data).length > 8192) throw new SyncApiError(0, 'settings blob exceeds the 8 KB sync limit');
        const cur = server.slots.get(slot)?.version ?? 0;
        if (cur !== baseVersion) throw new SyncConflictError(cur);
        server.slots.set(slot, { version: cur + 1, data });
        server.pushes.push({ slot, data });
        return { version: cur + 1 };
      },
      remove: async (slot: string) => void server.slots.delete(slot),
      list: async () => [...server.slots.entries()].map(([slot, s]) => ({ slot, version: s.version, size: s.data.length, updatedAt: '' })),
    }),
  };
});

import { encryptToEnvelope, decryptEnvelope } from '../src/shared/syncCrypto';
import { serializeSyncPayload, type HostEntry } from '@pocketshell/core';
import { useAuthStore } from '../src/stores/auth';
import { useHostsStore } from '../src/stores/hosts';
import { setKeyVaultFactoryForTests, useVaultStore, vaultTuning, WrongPassphraseError } from '../src/stores/vault';
import { useVaultGateStore } from '../src/stores/vaultGate';
import { rememberPassphrase } from '../src/shared/passphraseVault';
import { requestVaultUnlock, settleVaultUnlock, unlockSheet } from '../src/vault/unlockSheet';
import { authorizeDial } from '../src/platform/dialGate';

const SUB = 'sub-1234';
const VAULT_PASS = 'throwaway vault passphrase';
const SYNC_PASS = 'throwaway sync passphrase';
const KEY_PASS = 'throwaway-key-pass';

let dir = '';
let plainKey = '';
let encKey = '';
let otherKey = '';

function keygen(name: string, pass: string): string {
  const path = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', pass, '-C', `${name}@test`, '-f', path]);
  return readFileSync(path, 'utf8');
}

function jwt(sub: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ sub, email: 'e2e@pocketshell.test', exp: 4102444800, iat: Math.floor(Date.now() / 1000) })}.x`;
}

function host(name: string): HostEntry {
  return { name, hostname: `${name}.example.com`, port: 22, user: 'u', identityFile: null, proxyJump: null, forwardAgent: false, localForwards: [], remoteForwards: [], fromConfig: true };
}

/** A fresh "tab" on the same browser: new stores, same storage + IndexedDB. */
function newTab() {
  setActivePinia(createPinia());
  setKeyVaultFactoryForTests(null);
  useAuthStore().signIn(jwt(SUB));
}

/** A different browser: also no localStorage / IndexedDB. */
function newDevice() {
  localStorage.clear();
  (globalThis as Record<string, unknown>)['indexedDB'] = new IDBFactory();
  newTab();
}

async function seedMain(hosts: HostEntry[], passphrase = SYNC_PASS) {
  server.slots.set('main', { version: 1, data: await encryptToEnvelope(serializeSyncPayload(hosts), passphrase) });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-web-'));
  plainKey = keygen('plain', '');
  encKey = keygen('enc', KEY_PASS);
  otherKey = keygen('other', '');
  vaultTuning.kdf = { m: 32768, t: 3, p: 1 }; // tests only: the cheapest params core accepts
  // Phase 2 not deployed: every /vault/* call is a 404.
  globalThis.fetch = (async () => new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  server.reset();
  newDevice();
});

describe('first setup and unlock', () => {
  it('a brand-new account creates the vault, and its passphrase also encrypts the host list', async () => {
    const gate = useVaultGateStore();
    expect(await gate.open()).toBe('create-vault');
    await gate.createVault(VAULT_PASS, false);
    expect(gate.step).toBe('ready');
    const header = server.slots.get('vault')!.data;
    expect(header).not.toContain(VAULT_PASS);
    expect(JSON.parse(header)).toMatchObject({ v: 1, epoch: 1, kdf: { alg: 'argon2id' } });

    await useHostsStore().saveHost(host('box'));
    newDevice();
    expect(await useVaultGateStore().open()).toBe('vault-locked');
    await useVaultGateStore().submitVaultPassphrase(VAULT_PASS, false);
    expect(useVaultGateStore().step).toBe('ready');
    expect(useHostsStore().hosts.map((h) => h.name)).toEqual(['box']);
  });

  it('a wrong passphrase is refused with a retry, and backoff starts after three failures', async () => {
    const gate = useVaultGateStore();
    await gate.open();
    await gate.createVault(VAULT_PASS, false);
    newDevice();
    await useVaultGateStore().open();
    const vault = useVaultStore();
    // Core's rule: two free retries, then 1s after the third failure, 2s, 4s… 30s.
    for (let i = 0; i < 2; i++) {
      await expect(vault.unlock('nope', false)).rejects.toBeInstanceOf(WrongPassphraseError);
      expect(vault.retryAt <= Date.now()).toBe(true);
    }
    await expect(vault.unlock('nope', false)).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(vault.retryAt).toBeGreaterThan(Date.now());
    await expect(vault.unlock(VAULT_PASS, false)).rejects.toThrow(/Try again in/);
    expect(vault.unlocked).toBe(false);
  });

  it('remember on this device unlocks silently next time; type-every-time does not; sign-out forgets', async () => {
    const gate = useVaultGateStore();
    await gate.open();
    await gate.createVault(VAULT_PASS, true);
    const record = localStorage.getItem(`ps.vaultDek.${SUB}`)!;
    expect(record).not.toContain(VAULT_PASS);

    newTab();
    expect(await useVaultGateStore().open()).toBe('ready');

    // An unlock with "type it every time" drops what this device remembered.
    newTab();
    await useVaultGateStore().open();
    useVaultStore().lock();
    await useVaultStore().unlock(VAULT_PASS, false);
    expect(localStorage.getItem(`ps.vaultDek.${SUB}`)).toBeNull();
    newTab();
    expect(await useVaultGateStore().open()).toBe('vault-locked');

    await useVaultStore().unlock(VAULT_PASS, true);
    await useVaultStore().signOut(SUB);
    expect(localStorage.getItem(`ps.vaultDek.${SUB}`)).toBeNull();
  });
});

describe('keys, bindings and connect', () => {
  async function ready() {
    await seedMain([host('box'), host('relay')]);
    const gate = useVaultGateStore();
    expect(await gate.open()).toBe('sync-passphrase');
    await gate.submitSyncPassphrase(SYNC_PASS);
    expect(gate.step).toBe('create-vault');
    await gate.createVault(VAULT_PASS, false);
    expect(gate.step).toBe('ready');
  }

  it('an uploaded key is sealed, bound by host name, and decrypted only on demand', async () => {
    await ready();
    const vault = useVaultStore();
    const added = await vault.addKey(plainKey, 'laptop');
    expect(added.kind).toBe('ok');
    if (added.kind !== 'ok') return;
    expect(added.entry.fingerprint).toMatch(/^SHA256:/);
    await vault.bindHost('box', added.entry.keyId, 'managed');
    const blob = server.slots.get(`vk-${added.entry.keyId}`)!.data;
    expect(blob).not.toContain('PRIVATE KEY');
    expect(server.slots.get('vault')!.data).not.toContain('laptop');

    expect(useHostsStore().secretHosts).toEqual(['box']);
    expect(await useHostsStore().getHostSecret('box')).toEqual({ privateKeyPem: plainKey.trim() + '\n' });
    expect(await vault.publicKeyOf(added.entry.keyId)).toMatch(/^ssh-ed25519 /);

    // Another device: one passphrase, and the binding + policy are there.
    newDevice();
    await useVaultGateStore().open();
    await useVaultGateStore().submitVaultPassphrase(VAULT_PASS, false);
    expect(useVaultStore().bindings).toEqual({ box: { keyId: added.entry.keyId, gatewayAuth: 'managed' } });
    expect((await useHostsStore().getHostSecret('box'))?.privateKeyPem).toContain('PRIVATE KEY');
  });

  it('the host list mirrors each binding\'s gatewayAuth (design s7), and drops it on unbind', async () => {
    await ready();
    const vault = useVaultStore();
    const r = await vault.addKey(plainKey, 'k');
    if (r.kind !== 'ok') throw new Error('add failed');
    await vault.bindHost('box', r.entry.keyId, 'managed');
    const mainHosts = async () => JSON.parse(await decryptEnvelope(server.slots.get('main')!.data, SYNC_PASS)).hosts as HostEntry[];
    expect((await mainHosts()).find((h) => h.name === 'box')?.gatewayAuth).toBe('managed');
    expect((await mainHosts()).find((h) => h.name === 'relay')?.gatewayAuth).toBeUndefined();
    await vault.bindHost('box', null);
    expect((await mainHosts()).find((h) => h.name === 'box')?.gatewayAuth).toBeUndefined();
  });

  it('an encrypted key asks for its passphrase once and is stored decrypted', async () => {
    await ready();
    const vault = useVaultStore();
    expect((await vault.addKey(encKey, 'enc')).kind).toBe('needsPassphrase');
    expect((await vault.addKey(encKey, 'enc', 'wrong')).kind).toBe('wrongPassphrase');
    const r = await vault.addKey(encKey, 'enc', KEY_PASS);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    await vault.bindHost('box', r.entry.keyId);
    const pem = (await useHostsStore().getHostSecret('box'))!.privateKeyPem!;
    const out = join(dir, 'stored');
    require('node:fs').writeFileSync(out, pem, { mode: 0o600 });
    // OpenSSH reads it with an EMPTY passphrase: other clients need only the vault.
    expect(execFileSync('ssh-keygen', ['-y', '-P', '', '-f', out]).toString()).toMatch(/^ssh-ed25519 /);
  });

  it('passwords (and relay tokens) are vault entries too; rotate moves hosts; delete unbinds', async () => {
    await ready();
    const vault = useVaultStore();
    const pw = await vault.addPassword('hunter2-relay', 'relay token');
    await vault.bindHost('relay', pw.keyId);
    expect(await useHostsStore().getHostSecret('relay')).toEqual({ password: 'hunter2-relay' });

    const a = await vault.addKey(plainKey, 'old');
    if (a.kind !== 'ok') throw new Error('add failed');
    await vault.bindHost('box', a.entry.keyId, 'both');
    const rotated = await vault.rotateKey(a.entry.keyId, otherKey, 'new');
    expect(rotated.kind).toBe('ok');
    if (rotated.kind !== 'ok') return;
    expect(vault.bindings.box).toEqual({ keyId: rotated.entry.keyId, gatewayAuth: 'both' });
    expect(vault.entries.find((e) => e.keyId === rotated.entry.keyId)?.rotatedFrom).toBe(a.entry.keyId);
    expect(server.slots.has(`vk-${a.entry.keyId}`)).toBe(false);

    // Deleting a key keeps the host's binding (a re-upload reattaches it),
    // but the host no longer counts as having a credential.
    await vault.removeKey(rotated.entry.keyId);
    expect(vault.entries.some((e) => e.keyId === rotated.entry.keyId)).toBe(false);
    expect(useHostsStore().secretHosts).toEqual(['relay']);
    expect(await useHostsStore().getHostSecret('box')).toBeUndefined();
  });

  it('a locked vault answers a session dial with the unlock sheet, never a key prompt', async () => {
    await ready();
    const vault = useVaultStore();
    const r = await vault.addKey(plainKey, 'k');
    if (r.kind !== 'ok') throw new Error('add failed');
    await vault.bindHost('box', r.entry.keyId);
    vault.lock();

    const dial = authorizeDial('session', host('box'));
    await vi.waitFor(() => expect(unlockSheet.open).toBe(true));
    await vault.unlock(VAULT_PASS, false);
    settleVaultUnlock(true);
    const grant = await dial;
    expect(grant.ok && grant.secret?.privateKeyPem).toContain('PRIVATE KEY');

    // Cancelled sheet: the dial fails with the lock message.
    vault.lock();
    const cancelled = authorizeDial('session', host('box'));
    await vi.waitFor(() => expect(unlockSheet.open).toBe(true));
    settleVaultUnlock(false);
    expect(await cancelled).toEqual({ ok: false, error: expect.stringMatching(/locked/) });
    // Background paths never raise the sheet.
    expect(await authorizeDial('forward', host('box'))).toEqual({ ok: false, error: expect.stringMatching(/locked/) });
  });

  it('the unlock sheet shares one prompt between concurrent dials', async () => {
    const a = requestVaultUnlock();
    const b = requestVaultUnlock();
    settleVaultUnlock(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(unlockSheet.open).toBe(false);
  });
});

describe('change passphrase and reset', () => {
  it('change rewraps the same key: blobs untouched, remembered devices keep working', async () => {
    const gate = useVaultGateStore();
    await gate.open();
    await gate.createVault(VAULT_PASS, true);
    const vault = useVaultStore();
    const r = await vault.addKey(plainKey, 'k');
    if (r.kind !== 'ok') throw new Error('add failed');
    const blobBefore = server.slots.get(`vk-${r.entry.keyId}`)!.data;

    await expect(vault.changePassphrase('nope', 'a brand new passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
    await vault.changePassphrase(VAULT_PASS, 'a brand new passphrase');
    expect(server.slots.get(`vk-${r.entry.keyId}`)!.data).toBe(blobBefore);

    newTab();
    expect(await useVaultGateStore().open()).toBe('ready'); // remembered DEK still valid

    newDevice();
    await useVaultGateStore().open();
    await expect(useVaultStore().unlock(VAULT_PASS, false)).rejects.toBeInstanceOf(WrongPassphraseError);
    await useVaultStore().unlock('a brand new passphrase', false);
    expect(useVaultStore().entries.map((e) => e.name)).toEqual(['k']);
  });

  it('a lock during a passphrase change waits for it; the remembered record is refreshed', async () => {
    const gate = useVaultGateStore();
    await gate.open();
    await gate.createVault(VAULT_PASS, true);
    const vault = useVaultStore();
    const before = localStorage.getItem(`ps.vaultDek.${SUB}`);
    const change = vault.changePassphrase(VAULT_PASS, 'another new passphrase');
    vault.lock(); // e.g. the Lock button mid-change
    expect(vault.unlocked).toBe(true);
    await change;
    expect(vault.unlocked).toBe(false); // the deferred lock ran afterwards
    expect(localStorage.getItem(`ps.vaultDek.${SUB}`)).not.toBe(before);
    newTab();
    expect(await useVaultGateStore().open()).toBe('ready');
  });

  it('reset wipes the keys, bumps the epoch, keeps bindings, and stale remembered keys stop working', async () => {
    await seedMain([host('box')]);
    const gate = useVaultGateStore();
    await gate.open();
    await gate.submitSyncPassphrase(SYNC_PASS);
    await gate.createVault(VAULT_PASS, true);
    const vault = useVaultStore();
    const r = await vault.addKey(plainKey, 'k');
    if (r.kind !== 'ok') throw new Error('add failed');
    await vault.bindHost('box', r.entry.keyId);
    const otherBrowserRecord = localStorage.getItem(`ps.vaultDek.${SUB}`);

    const carry = vault.carryForReset();
    await vault.reset('the new vault passphrase', { hosts: carry.hosts, syncPassphrase: carry.syncPassphrase! }, false);
    expect(JSON.parse(server.slots.get('vault')!.data).epoch).toBe(2);
    expect([...server.slots.keys()].filter((s) => s.startsWith('vk-'))).toEqual([]);
    expect(vault.entries).toEqual([]);
    expect(vault.bindings.box?.keyId).toBe(r.entry.keyId);

    // Re-uploading the same key reattaches it (content-derived keyId).
    await vault.addKey(plainKey, 'k again');
    expect(useHostsStore().secretHosts).toEqual(['box']);

    // A browser still remembering the old epoch falls back to the passphrase.
    newTab();
    localStorage.setItem(`ps.vaultDek.${SUB}`, otherBrowserRecord!);
    expect(await useVaultGateStore().open()).toBe('vault-locked');
    expect(localStorage.getItem(`ps.vaultDek.${SUB}`)).toBeNull();
    await useVaultGateStore().submitVaultPassphrase('the new vault passphrase', false);
    expect(useHostsStore().hosts.map((h) => h.name)).toEqual(['box']);
  });
});

describe('hard-cut migration of the legacy keys slot', () => {
  async function seedLegacy(account: Record<string, unknown>, local: Record<string, unknown> = {}) {
    server.slots.set('keys', { version: 3, data: await encryptToEnvelope(JSON.stringify({ v: 1, secrets: account }), SYNC_PASS) });
    if (Object.keys(local).length > 0) {
      localStorage.setItem('ps.hostKeys', await encryptToEnvelope(JSON.stringify({ v: 1, secrets: local }), SYNC_PASS));
    }
  }

  it('moves keys (decrypted) and passwords into the vault, verifies, then deletes every legacy copy', async () => {
    await seedMain([host('box'), host('enc'), host('pw'), host('local')]);
    await seedLegacy(
      {
        box: { privateKeyPem: plainKey },
        enc: { privateKeyPem: encKey, keyPassphrase: KEY_PASS },
        pw: { password: 'legacy-password' },
      },
      { local: { privateKeyPem: otherKey } },
    );
    await rememberPassphrase(SUB, SYNC_PASS);

    const gate = useVaultGateStore();
    // The pre-vault remembered sync passphrase opens the list silently.
    expect(await gate.open()).toBe('create-vault');
    await gate.createVault(SYNC_PASS, false); // "keep using my sync passphrase"
    expect(gate.step).toBe('migrate');
    await gate.migrate();
    expect(gate.failures).toEqual([]);
    expect(gate.step).toBe('ready');

    expect(server.slots.has('keys')).toBe(false);
    expect(localStorage.getItem('ps.hostKeys')).toBeNull();
    expect(localStorage.getItem(`ps.passVault.${SUB}`)).toBeNull();
    const hosts = useHostsStore();
    expect(hosts.secretHosts.sort()).toEqual(['box', 'enc', 'local', 'pw']);
    expect(await hosts.getHostSecret('pw')).toEqual({ password: 'legacy-password' });
    expect((await hosts.getHostSecret('enc'))!.privateKeyPem).not.toContain('aes256');
    // Nothing plaintext was ever pushed.
    for (const p of server.pushes) {
      expect(p.data).not.toContain('PRIVATE KEY');
      expect(p.data).not.toContain('legacy-password');
    }
  });

  it('a key whose passphrase was never saved waits for it; old copies stay until it moves', async () => {
    await seedMain([host('enc')]);
    await seedLegacy({ enc: { privateKeyPem: encKey } });
    const gate = useVaultGateStore();
    await gate.open();
    await gate.submitSyncPassphrase(SYNC_PASS);
    await gate.createVault(VAULT_PASS, false);
    await gate.migrate();
    expect(gate.failures.map((f) => [f.host, f.reason])).toEqual([['enc', 'needs-passphrase']]);
    expect(gate.step).toBe('migrate');
    expect(server.slots.has('keys')).toBe(true);

    await gate.migrate({ enc: KEY_PASS });
    expect(gate.step).toBe('ready');
    expect(server.slots.has('keys')).toBe(false);
  });

  it('a stale local cache never overrides a binding the vault already has', async () => {
    await seedMain([host('box')]);
    const gate = useVaultGateStore();
    await gate.open();
    await gate.submitSyncPassphrase(SYNC_PASS);
    await gate.createVault(VAULT_PASS, false);
    const vault = useVaultStore();
    const r = await vault.addKey(otherKey, 'current');
    if (r.kind !== 'ok') throw new Error('add failed');
    await vault.bindHost('box', r.entry.keyId);

    localStorage.setItem('ps.hostKeys', await encryptToEnvelope(JSON.stringify({ v: 1, secrets: { box: { privateKeyPem: plainKey } } }), SYNC_PASS));
    await gate.checkLegacy();
    expect(gate.step).toBe('migrate');
    await gate.migrate();
    expect(vault.bindings.box.keyId).toBe(r.entry.keyId);
    expect(localStorage.getItem('ps.hostKeys')).toBeNull();
  });
});

describe('index carries the sync passphrase', () => {
  it('unlocking the vault opens the host list without a second prompt', async () => {
    await seedMain([host('box')]);
    const gate = useVaultGateStore();
    await gate.open();
    await gate.submitSyncPassphrase(SYNC_PASS);
    await gate.createVault('separate vault passphrase', false);
    newDevice();
    await useVaultGateStore().open();
    await useVaultGateStore().submitVaultPassphrase('separate vault passphrase', false);
    expect(useVaultGateStore().step).toBe('ready');
    expect(useHostsStore().passphrase).toBe(SYNC_PASS);
    // And the host list itself is still the sync passphrase's envelope.
    await decryptEnvelope(server.slots.get('main')!.data, SYNC_PASS);
  });
});

