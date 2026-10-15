import { defineStore } from 'pinia';
import { makeSyncService } from '../api/sync';
import { claimsOf } from '../auth/google';
import { useAuthStore } from './auth';
import {
  clampVaultName,
  KeyVaultStore,
  VAULT_KDF_DEFAULT,
  type GatewayAuthPolicy as GatewayAuth,
  type HostKeyBinding,
  type VaultAddKeyResult as AddKeyResult,
  type VaultKeyEntry,
  type VaultWriteResult,
} from '@pocketshell/core';
import { forgetDek, hasRememberedDek, recallRecord, rememberRecord } from '../vault/deviceRemember';
import { makeServerVerifier } from '../vault/serverVerifier';
import { makeVaultTransport } from '../vault/webTransport';
import {
  describeApplyFailure,
  gatewayAuthInvocation,
  parseGatewayAuthReport,
  type GatewayAuthReport,
} from '../vault/gatewayPolicy';
import type { HostEntry } from '@pocketshell/core';

/** `corrupt`: a vault exists but its header cannot be read; only a reset helps. */
export type VaultPhase = 'unknown' | 'absent' | 'locked' | 'unlocked' | 'corrupt';

export type { VaultSecret } from '@pocketshell/core';
import type { VaultSecret } from '@pocketshell/core';

/** A dial needed the vault and it is locked: the UI shows the unlock sheet. */
export class VaultLockedError extends Error {
  constructor(message = 'Your key vault is locked. Unlock it to connect.') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

export class WrongPassphraseError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("That passphrase didn't unlock your vault.");
    this.name = 'WrongPassphraseError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Test seam: Argon2id memory for NEW vaults (unlock always uses the header). */
export const vaultTuning = { kdf: { ...VAULT_KDF_DEFAULT } as { m: number; t: number; p: number } };

/**
 * The one KeyVaultStore of the signed-in account. Module scope, not store
 * state: the DEK it holds never reaches devtools, serialisation or
 * reactivity. Rebuilt when the account changes.
 */
let core: { sub: string; store: KeyVaultStore; off: () => void } | null = null;
let coreFactory: ((sub: string) => KeyVaultStore) | null = null;
/** A passphrase change or reset is rewriting the header: a lock must wait
 * for it (locking mid-write can leave the vault unreadable). */
let headerOps = 0;
let lockDeferred = false;

/** Test seam: build the core store over fakes. */
export function setKeyVaultFactoryForTests(factory: ((sub: string) => KeyVaultStore) | null): void {
  coreFactory = factory;
  core?.off();
  core = null;
}

function accountSub(): string {
  return claimsOf(useAuthStore().idToken).sub;
}

export function describeWriteFailure(r: Exclude<VaultWriteResult, { kind: 'ok' }> | { kind: 'tooLarge' }): string {
  switch (r.kind) {
    case 'locked':
      return 'Your vault is locked. Unlock it and try again.';
    case 'gated':
      return 'Enter your vault passphrase again to change the vault on this device.';
    case 'vaultChanged':
      return 'Your vault was reset on another device. Unlock it again with the new passphrase.';
    case 'indexFull':
      return 'Your vault is full (8 KB index limit). Remove a key you no longer use and try again.';
    case 'tooLarge':
      return 'That key is too large for the vault (8 KB per key).';
    case 'conflictLimit':
      return 'Your vault kept changing on another device. Try again.';
    case 'error':
      return r.message;
  }
}

/** A vault written by a newer format: update the app, never reset it. */
export const UNSUPPORTED_VERSION_MESSAGE =
  'Your vault was created by a newer version of PocketShell. Reload this page to update the app; do not reset the vault.';

function throwIfFailed(r: VaultWriteResult): void {
  if (r.kind !== 'ok') throw new Error(describeWriteFailure(r));
}

/**
 * The account key vault on the web (design: pocketshell-key-vault.md,
 * sections 3-5): a reactive face over core's KeyVaultStore plus the parts
 * only a browser has — the account it belongs to, the remembered vault key
 * in IndexedDB, and the HTTP transport. Key blobs are decrypted only by
 * `secretFor` (connect), into memory.
 */
export const useVaultStore = defineStore('vault', {
  state: () => ({
    phase: 'unknown' as VaultPhase,
    entries: [] as VaultKeyEntry[],
    bindings: {} as Record<string, HostKeyBinding>,
    /** This browser holds a remembered vault key for this account. */
    remembered: false,
    /** Epoch ms before which Unlock stays disabled (backoff / server lock). */
    retryAt: 0,
    /** Hosts whose key or policy changed and whose host agent has not been
     * told yet ("Apply to host"). Kept per account in localStorage (host
     * names only), so a reload does not lose the reminder. */
    pendingApply: [] as string[],
  }),
  getters: {
    unlocked: (s) => s.phase === 'unlocked',
  },
  actions: {
    core(): KeyVaultStore {
      const sub = accountSub();
      if (core === null || core.sub !== sub) {
        core?.off();
        const store =
          coreFactory?.(sub) ??
          new KeyVaultStore({
            transport: makeVaultTransport(() => makeSyncService(useAuthStore())),
            verifier: makeServerVerifier(() => useAuthStore().getIdToken()),
            kdf: vaultTuning.kdf,
          });
        core = { sub, store, off: store.subscribe(() => this.refresh()) };
      }
      return core.store;
    },

    /** Copy the core store's non-secret view into reactive state. */
    refresh(): void {
      const store = core?.store;
      if (!store) return;
      if (store.state === 'unlocked') {
        if (this.phase !== 'unlocked') this.loadPending();
        this.phase = 'unlocked';
        this.entries = store.listKeys();
        this.bindings = store.listHostBindings();
      } else {
        if (this.phase === 'unlocked') this.phase = 'locked';
        this.entries = [];
        this.bindings = {};
      }
    },

    syncPassphrase(): string {
      return core?.store.getSyncPassphrase() ?? '';
    },

    async probe(): Promise<VaultPhase> {
      const r = await this.core().probe();
      if (r.kind === 'error') throw new Error(r.message);
      if (r.kind === 'unsupportedVersion') throw new Error(UNSUPPORTED_VERSION_MESSAGE);
      if (r.kind === 'corrupt') {
        this.phase = 'corrupt';
        return this.phase;
      }
      if (r.kind === 'noVault') this.phase = 'absent';
      // gated: a vault exists but stays hidden until a verify — locked.
      else this.phase = this.core().state === 'unlocked' ? 'unlocked' : 'locked';
      try {
        this.remembered = hasRememberedDek(accountSub());
      } catch {
        this.remembered = false;
      }
      this.refresh();
      return this.phase;
    },

    /** The silent path: the vault key remembered on this device. */
    async unlockRemembered(): Promise<boolean> {
      const sub = accountSub();
      const record = await recallRecord(sub);
      if (record === null) {
        this.remembered = false;
        return false;
      }
      try {
        const r = await this.core().unlockWithRememberedDek(record);
        if (r.kind === 'ok') {
          this.remembered = true;
          this.refresh();
          return true;
        }
        // stale = reset elsewhere, or the passphrase changed under a gate.
        if (r.kind === 'stale' || r.kind === 'corrupt') {
          await forgetDek(sub);
          this.remembered = false;
        }
        if (r.kind === 'rateLimited') this.retryAt = Date.now() + r.retryAfterMs;
        return false;
      } finally {
        record.dek.fill(0);
        record.auth?.fill(0);
      }
    },

    async unlock(passphrase: string, remember: boolean): Promise<void> {
      const r = await this.core().unlock(passphrase);
      switch (r.kind) {
        case 'ok':
          this.retryAt = 0;
          this.refresh();
          await this.applyRemember(remember);
          return;
        case 'wrongPassphrase':
          this.retryAt = Date.now() + r.retryAfterMs;
          throw new WrongPassphraseError(r.retryAfterMs);
        case 'backoff':
        case 'rateLimited':
          this.retryAt = Date.now() + r.retryAfterMs;
          throw new Error(
            `${r.kind === 'rateLimited' ? 'Too many attempts on this account.' : 'Too many attempts.'} Try again in ${Math.max(1, Math.ceil(r.retryAfterMs / 1000))}s.`,
          );
        case 'noVault':
          this.phase = 'absent';
          throw new Error('This account has no vault yet.');
        case 'corrupt':
          throw new Error('Your vault header could not be read. Reset the vault to start again.');
        case 'unsupportedVersion':
          throw new Error(UNSUPPORTED_VERSION_MESSAGE);
        case 'error':
          throw new Error(r.message);
      }
    },

    /** First setup; the index records the sync passphrase. */
    async create(passphrase: string, syncPassphrase: string, remember: boolean): Promise<void> {
      const r = await this.core().createVault(passphrase, { syncPassphrase });
      if (r.kind === 'exists') throw new Error('A vault was just created on another device. Reload and unlock it with that passphrase.');
      if (r.kind === 'indexFull') throw new Error(describeWriteFailure(r));
      if (r.kind === 'freshAuthRequired') throw new Error('Sign in with Google again to continue.');
      if (r.kind === 'error') throw new Error(r.message);
      this.refresh();
      await this.applyRemember(remember);
    },

    /** Per-device choice: wrap the vault key here, or make sure none is. */
    async applyRemember(remember: boolean): Promise<void> {
      const sub = accountSub();
      if (remember) {
        const record = this.core().exportRememberRecord();
        if (record !== null) {
          try {
            await rememberRecord(sub, record);
            this.remembered = true;
          } finally {
            record.dek.fill(0);
            record.auth?.fill(0);
          }
        }
      } else {
        await forgetDek(sub);
        this.remembered = false;
      }
    },

    /** Settings: "Forget on this device". The unlocked session stays. */
    async forgetDevice(): Promise<void> {
      await forgetDek(accountSub());
      this.remembered = false;
    },

    lock(): void {
      if (headerOps > 0) {
        lockDeferred = true;
        return;
      }
      core?.store.lock();
      this.refresh();
    },

    /** Run a header rewrite with locks deferred until it settles. */
    async headerOp<T>(fn: () => Promise<T>): Promise<T> {
      headerOps += 1;
      try {
        return await fn();
      } finally {
        headerOps -= 1;
        if (headerOps === 0 && lockDeferred) {
          lockDeferred = false;
          this.lock();
        }
      }
    },

    /** Sign-out forgets the remembered vault key too (design section 5). */
    async signOut(sub: string | null): Promise<void> {
      if (sub !== null) await forgetDek(sub).catch(() => undefined);
      core?.store.lock();
      core?.off();
      core = null;
      this.$reset();
    },

    /* --- keys and bindings --------------------------------------------- */

    async addKey(pem: string, name: string, keyPassphrase?: string): Promise<AddKeyResult> {
      const r = await this.core().addKey(pem, clampVaultName(name, 'SSH key'), keyPassphrase);
      this.refresh();
      return r;
    },

    async addPassword(password: string, name: string): Promise<VaultKeyEntry> {
      const r = await this.core().addPassword(password, clampVaultName(name, 'Password'));
      if (r.kind !== 'ok') throw new Error(describeWriteFailure(r));
      this.refresh();
      return r.entry;
    },

    /** Deleting a key does not revoke it on hosts: their host agents keep
     * trusting its public key until "Apply to host", so flag them. */
    async removeKey(keyId: string): Promise<void> {
      const bound = Object.entries(this.core().listHostBindings())
        .filter(([, b]) => b.keyId === keyId)
        .map(([h]) => h);
      throwIfFailed(await this.core().removeKey(keyId));
      this.markPending(bound);
    },

    async renameKey(keyId: string, name: string): Promise<void> {
      throwIfFailed(await this.core().renameKey(keyId, clampVaultName(name, 'Key')));
    },

    /** Rotate: add the new key, move every host from the old one onto it. */
    async rotateKey(oldKeyId: string, pem: string, name: string, keyPassphrase?: string): Promise<AddKeyResult> {
      const added = await this.core().addKey(pem, clampVaultName(name, 'SSH key'), keyPassphrase);
      if (added.kind !== 'ok') return added;
      if (added.entry.keyId === oldKeyId) {
        return { kind: 'invalid', message: 'That is the same key. Upload the new key to rotate to.' };
      }
      const moved = Object.entries(this.core().listHostBindings())
        .filter(([, b]) => b.keyId === oldKeyId)
        .map(([h]) => h);
      throwIfFailed(await this.core().rotateKey(oldKeyId, added.entry.keyId));
      // The old public key stays authorized on those hosts until re-pushed.
      this.markPending(moved);
      return added;
    },

    async bindHost(host: string, keyId: string | null, gatewayAuth: GatewayAuth = 'both'): Promise<void> {
      throwIfFailed(keyId === null ? await this.core().unbindHost(host) : await this.core().bindHost(host, keyId, gatewayAuth));
      this.markPending([host]);
      await this.mirrorToHostList();
    },

    /** Keep the host list's non-secret gatewayAuth flags in step with the
     * index. Best effort: the binding itself is already saved. */
    async mirrorToHostList(): Promise<void> {
      if (core === null || core.store.state !== 'unlocked') return;
      const { useHostsStore } = await import('./hosts');
      await useHostsStore()
        .mirrorGatewayAuth(core.store.listHostBindings())
        .catch(() => undefined);
    },

    markPending(hosts: string[]): void {
      this.pendingApply = [...new Set([...this.pendingApply, ...hosts])];
      this.persistPending();
    },

    persistPending(): void {
      try {
        const key = `ps.vaultPendingApply.${accountSub()}`;
        if (this.pendingApply.length === 0) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(this.pendingApply));
      } catch {
        // Storage unavailable: the reminder lives for this session only.
      }
    },

    loadPending(): void {
      try {
        const raw = localStorage.getItem(`ps.vaultPendingApply.${accountSub()}`);
        const list: unknown = raw === null ? [] : JSON.parse(raw);
        this.pendingApply = Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string') : [];
      } catch {
        this.pendingApply = [];
      }
    },

    async setSyncPassphrase(passphrase: string): Promise<void> {
      throwIfFailed(await this.core().setSyncPassphrase(passphrase));
    },

    async publicKeyOf(keyId: string): Promise<string | null> {
      return this.core().getPublicKey(keyId);
    },

    /** Host → binding → blob → plaintext, in memory. Throws VaultLockedError
     * when locked; null when the host has no binding or its key is gone. */
    async secretFor(host: string): Promise<VaultSecret | null> {
      if (core === null || this.phase !== 'unlocked') throw new VaultLockedError();
      const r = await this.core().decryptKeyForHost(host);
      switch (r.kind) {
        case 'key':
          return { kind: 'key', pem: r.pem };
        case 'password':
          return { kind: 'password', password: r.password };
        case 'locked':
          this.refresh();
          throw new VaultLockedError();
        case 'gated':
          // The server wants a fresh verify and the silent one failed.
          throw new VaultLockedError('Enter your vault passphrase to use your keys on this device.');
        case 'unbound':
        case 'missingKey':
          return null;
        case 'corrupt':
          throw new Error(`The vault key for ${host} could not be decrypted. Upload it again.`);
        case 'error':
          throw new Error(r.message);
      }
    },

    /**
     * Push this host's gateway policy and its vault public key to the host
     * agent over a fresh SSH session (W5). Needs a working credential for
     * the host already; a `managed`-only host must be bootstrapped from the
     * host itself or with `both` first.
     */
    async applyGatewayPolicy(entry: HostEntry): Promise<GatewayAuthReport> {
      const binding = this.bindings[entry.name];
      const policy = binding?.gatewayAuth ?? 'host';
      const keys: { keyId: string; publicKey: string }[] = [];
      if (binding && policy !== 'host') {
        const publicKey = await this.publicKeyOf(binding.keyId);
        if (publicKey === null) throw new Error('This host has no vault SSH key to trust. Pick a key (not a password) first.');
        keys.push({ keyId: binding.keyId, publicKey });
      }
      const { command, stdin } = gatewayAuthInvocation(policy, keys);
      const { execOnHost } = await import('../platform/webApi');
      const out = await execOnHost(entry, command, stdin);
      if (!out.ok) throw new Error(out.error);
      const report = out.exitCode === 0 ? parseGatewayAuthReport(out.stdout) : null;
      if (report === null) throw new Error(describeApplyFailure(out.exitCode, out.stderr));
      this.pendingApply = this.pendingApply.filter((h) => h !== entry.name);
      this.persistPending();
      return report;
    },

    /* --- passphrase lifecycle ------------------------------------------ */

    async changePassphrase(current: string, next: string): Promise<void> {
      const r = await this.headerOp(async () => {
        const res = await this.core().changePassphrase(current, next);
        // AUTH changed with the passphrase: refresh what this device
        // remembers, before any deferred lock drops the key.
        if (res.kind === 'ok' && this.remembered) await this.applyRemember(true);
        return res;
      });
      if (r.kind === 'ok') {
        // The server verifier could not be updated yet: retry once quietly;
        // core retries again on the next unlock.
        if (r.verifierPending) void this.core().retryVerifierPublish().catch(() => undefined);
        return;
      }
      if (r.kind === 'passphraseChangedElsewhere') {
        this.lock();
        throw new Error('Your vault passphrase was just changed on another device. Unlock with the new passphrase, then try again.');
      }
      if (r.kind === 'wrongPassphrase') throw new WrongPassphraseError(r.retryAfterMs);
      if (r.kind === 'backoff') throw new Error(`Too many attempts. Try again in ${Math.ceil(r.retryAfterMs / 1000)}s.`);
      throw new Error(describeWriteFailure(r));
    },

    /**
     * Forgot passphrase. The caller has re-authenticated with Google (the
     * fresh ID token is already the auth store's). `carry` keeps bindings and
     * the sync passphrase; keys must be uploaded again.
     */
    async reset(
      passphrase: string,
      carry: { hosts: Record<string, HostKeyBinding>; syncPassphrase: string },
      remember: boolean,
    ): Promise<void> {
      const sub = accountSub();
      await forgetDek(sub);
      this.remembered = false;
      const r = await this.headerOp(async () => {
        const res = await this.core().resetVault(passphrase, carry);
        if (res.kind === 'ok') await this.applyRemember(remember);
        return res;
      });
      if (r.kind === 'unsupportedVersion') throw new Error(UNSUPPORTED_VERSION_MESSAGE);
      if (r.kind === 'freshAuthRequired') throw new Error('Sign in with Google again (within the last 5 minutes) to reset the vault.');
      if (r.kind === 'exists') throw new Error('A new vault was just created on another device. Reload and unlock it.');
      if (r.kind === 'indexFull') throw new Error(describeWriteFailure(r));
      if (r.kind === 'error') throw new Error(r.message);
      this.retryAt = 0;
      this.refresh();
      // Reset keys stay authorized on the hosts until the new ones are pushed.
      this.markPending(Object.keys(carry.hosts));
    },

    /** Bindings + sync passphrase this tab can carry over a reset. */
    carryForReset(): { hosts: Record<string, HostKeyBinding>; syncPassphrase: string | null } {
      if (core === null || core.store.state !== 'unlocked') return { hosts: {}, syncPassphrase: null };
      return { hosts: core.store.listHostBindings(), syncPassphrase: core.store.getSyncPassphrase() };
    },
  },
});
