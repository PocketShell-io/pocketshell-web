import { defineStore } from 'pinia';
import { syncApi } from '../api/sync';
import { decryptEnvelope, encryptEnvelope } from '../crypto/envelope';
import type { HostEntry } from '../types';

const SLOT = 'main';
const KEYS_STORAGE = 'ps.hostKeys';

/**
 * Synced hosts and the browser-local credentials that make them usable.
 *
 * The sync blob never carries key material (identityFile is a path on
 * whatever machine pushed the entry), so the web app asks for a private key
 * or password per host. Those secrets are stored ONLY in this browser,
 * encrypted with the sync passphrase using the same envelope scheme the
 * account uses — localStorage holds one more opaque envelope.
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
    /** Pull slot `main` and decrypt with the passphrase. */
    async unlock(idToken: string, passphrase: string): Promise<void> {
      const blob = await syncApi.getSlot(idToken, SLOT);
      this.version = blob?.version ?? 0;
      if (blob === null) {
        // No account blob yet — an empty list is correct, not an error.
        this.hosts = [];
        this.passphrase = passphrase;
        this.pulled = true;
        return;
      }
      const plaintext = await decryptEnvelope(blob.data, passphrase);
      this.hosts = parseHosts(plaintext);
      this.passphrase = passphrase;
      this.pulled = true;
      this.error = '';
    },

    /** Attach (or replace) the key/password the browser will use for a host. */
    async setHostSecret(name: string, secret: { privateKeyPem?: string; password?: string }) {
      const keys = this.readKeys();
      keys[name] = secret;
      localStorage.setItem(KEYS_STORAGE, await encryptEnvelope(JSON.stringify(keys), this.passphrase));
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

/** Same degraded parse as the desktop: not-a-payload → empty list. */
function parseHosts(plaintext: string): HostEntry[] {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const hosts = (parsed as Record<string, unknown>)['hosts'];
    if (!Array.isArray(hosts)) return [];
    return hosts.filter(
      (h): h is HostEntry =>
        typeof h === 'object' &&
        h !== null &&
        typeof (h as HostEntry).name === 'string' &&
        typeof (h as HostEntry).hostname === 'string',
    );
  } catch {
    return [];
  }
}
