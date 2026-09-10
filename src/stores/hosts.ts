import { defineStore } from 'pinia';
import { makeSyncService } from '../api/sync';
import { SYNC_SLOT } from '../shared/syncConfig';
import { parseSyncPayload } from '../shared/syncMerge';
import { decryptEnvelope, encryptToEnvelope } from '../shared/syncCrypto';
import type { HostEntry } from '../shared/types';
import { useAuthStore } from './auth';

const KEYS_STORAGE = 'ps.hostKeys';

/**
 * Synced hosts and the browser-local credentials that make them usable.
 *
 * The sync blob never carries key material (identityFile is a path on
 * whatever machine pushed the entry), so the web app asks for a private key
 * or password per host. Those secrets are stored ONLY in this browser,
 * encrypted with the sync passphrase using the same envelope scheme the
 * account uses — localStorage holds one more opaque envelope.
 *
 * The host list itself is the desktop app's payload verbatim: pull slot
 * `main`, open with syncCrypto (the browser twin of the desktop's
 * SyncCrypto), parse with the DESKTOP's parseSyncPayload — the same
 * degraded-parse rules, so a blob the desktop wrote is read exactly as the
 * desktop would read it.
 */
export const useHostsStore = defineStore('hosts', {
  state: () => ({
    passphrase: '',
    hosts: [] as HostEntry[],
    version: 0,
    pulled: false,
    error: '',
  }),
  getters: {
    unlocked: (s) => s.pulled && s.passphrase !== '',
  },
  actions: {
    /** Pull the account slot and decrypt it with the passphrase. */
    async unlock(passphrase: string): Promise<void> {
      const auth = useAuthStore();
      const blob = await makeSyncService(auth).pull(SYNC_SLOT);
      this.version = blob?.version ?? 0;
      if (blob === null) {
        // No account blob yet — an empty list is correct, not an error.
        this.hosts = [];
      } else {
        const plaintext = await decryptEnvelope(blob.data, passphrase);
        this.hosts = parseSyncPayload(plaintext);
      }
      this.passphrase = passphrase;
      this.pulled = true;
      this.error = '';
    },

    /** Attach (or replace) the key/password the browser will use for a host. */
    async setHostSecret(name: string, secret: { privateKeyPem?: string; password?: string }) {
      const keys = this.readKeys();
      keys[name] = secret;
      localStorage.setItem(KEYS_STORAGE, await encryptToEnvelope(JSON.stringify(keys), this.passphrase));
    },
    async getHostSecret(name: string): Promise<{ privateKeyPem?: string; password?: string } | undefined> {
      const keys = await this.readKeysDecrypted();
      return keys[name];
    },
    readKeys(): Record<string, { privateKeyPem?: string; password?: string }> {
      try {
        return JSON.parse(localStorage.getItem(KEYS_STORAGE) ?? '{}');
      } catch {
        return {};
      }
    },
    async readKeysDecrypted(): Promise<Record<string, { privateKeyPem?: string; password?: string }>> {
      const raw = localStorage.getItem(KEYS_STORAGE);
      if (raw === null || this.passphrase === '') return {};
      try {
        return JSON.parse(await decryptEnvelope(raw, this.passphrase));
      } catch {
        // Wrong passphrase after a change, or garbage — treat as empty; the
        // user can re-attach secrets, nothing leaves the browser either way.
        return {};
      }
    },

    signOutLocal() {
      this.passphrase = '';
      this.hosts = [];
      this.pulled = false;
      this.error = '';
    },
  },
});
