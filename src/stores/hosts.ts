import { defineStore } from 'pinia';
import { makeSyncService, SyncConflictError } from '../api/sync';
import { SYNC_SLOT } from '../shared/syncConfig';
import { parseSyncPayload, serializeSyncPayload } from '../shared/syncMerge';
import { decryptEnvelope, encryptToEnvelope } from '../shared/syncCrypto';
import type { HostEntry } from '../shared/types';
import { upsertHost } from '../hostForm';
import { useAuthStore } from './auth';

const KEYS_STORAGE = 'ps.hostKeys';

/**
 * What this browser stores for one host, encrypted at rest under the sync
 * passphrase. `passphrase` is the PRIVATE KEY's passphrase (an encrypted
 * OpenSSH key needs it before the bridge can use the key) — not to be
 * confused with the sync passphrase, which never leaves this module.
 */
export interface HostSecret {
  privateKeyPem?: string;
  password?: string;
  keyPassphrase?: string;
}

/**
 * Synced hosts and the browser-local credentials that make them usable.
 *
 * The sync blob never carries key material (identityFile is a path on
 * whatever machine pushed the entry), so the web app asks for a private key
 * or password per host. Those secrets live only in this browser, encrypted
 * with the sync passphrase using the same envelope scheme the account uses —
 * localStorage holds one more opaque envelope. The sync server never sees
 * them; when a session starts they are sent once, over the authenticated
 * WebSocket, to the bridge, which uses them in memory to open the SSH
 * connection (verified against the aws-infra Lambda source: no persistence,
 * no logging).
 *
 * The host list itself is the desktop app's payload verbatim: pull slot
 * `main`, open with syncCrypto (the browser twin of the desktop's
 * SyncCrypto), parse with the DESKTOP's parseSyncPayload — the same
 * degraded-parse rules, so a blob the desktop wrote is read exactly as the
 * desktop would read it. saveHost makes the web a writer too: a host
 * created here rides the same slot, and a desktop picks it up on its next
 * sync (the pull's auto-tick), which is what makes web-created hosts usable
 * on the machines that were not present when they were made.
 */
export const useHostsStore = defineStore('hosts', {
  state: () => ({
    passphrase: '',
    hosts: [] as HostEntry[],
    version: 0,
    pulled: false,
    error: '',
    /** Names of hosts that have a key or password stored in this browser. */
    secretHosts: [] as string[],
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
      await this.refreshSecretNames();
    },

    /**
     * Create or update one host in the account blob — the web acting as a
     * sync writer, the counterpart of the desktop's syncNow. The write is
     * MINIMAL: the payload is the current list with the entry upserted, and
     * on a 409 (a desktop pushed since our pull) the fresh blob is re-pulled
     * and only the entry re-applied to it — never the browser's stale copy
     * of the other hosts, which would silently revert the desktop's edits.
     * A slot deleted between pull and push is an error, not a silent
     * one-entry resurrection of a wiped account.
     */
    async saveHost(entry: HostEntry): Promise<void> {
      await this.pushUpserted([entry]);
    },

    /**
     * The config import's write: every ticked entry lands in ONE envelope
     * and one push, not one push per host. On a 409 the re-based fresh blob
     * gets the whole imported set re-applied — the user just decided for all
     * of them in one act, so the batch, unlike a single stale save, is the
     * unit the conflict resolution must keep.
     */
    async importHosts(entries: HostEntry[]): Promise<void> {
      if (entries.length === 0) return;
      await this.pushUpserted(entries);
    },

    async pushUpserted(entries: HostEntry[]): Promise<void> {
      const sync = makeSyncService(useAuthStore());
      let base = this.hosts;
      let baseVersion = this.version;
      for (let attempt = 0; ; attempt++) {
        let next = base;
        for (const entry of entries) next = upsertHost(next, entry);
        const envelope = await encryptToEnvelope(serializeSyncPayload(next), this.passphrase);
        try {
          const { version } = await sync.push(SYNC_SLOT, envelope, baseVersion);
          this.hosts = next;
          this.version = version;
          return;
        } catch (err) {
          if (!(err instanceof SyncConflictError) || attempt >= 2) throw err;
          const blob = await sync.pull(SYNC_SLOT);
          if (blob === null) throw new Error('your synced list changed on the server — reload and try again');
          base = parseSyncPayload(await decryptEnvelope(blob.data, this.passphrase));
          baseVersion = blob.version;
        }
      }
    },

    /** Names of hosts that currently have a secret in this browser. */
    async refreshSecretNames(): Promise<void> {
      const keys = await this.readKeysDecrypted();
      this.secretHosts = Object.keys(keys).filter((name) => {
        const s = keys[name];
        return (s.privateKeyPem ?? '') !== '' || (s.password ?? '') !== '';
      });
    },

    /** Attach (or replace) the key/passphrase the browser will use for a host.
     * Passing an empty secret clears the stored one. */
    async setHostSecret(name: string, secret: HostSecret) {
      const keys = await this.readKeysDecrypted();
      keys[name] = secret;
      localStorage.setItem(KEYS_STORAGE, await encryptToEnvelope(JSON.stringify(keys), this.passphrase));
      await this.refreshSecretNames();
    },

    /** Delete a host's stored credential from this browser, on explicit
     * user action. The synced host list is untouched. */
    async removeHostSecret(name: string) {
      const keys = await this.readKeysDecrypted();
      delete keys[name];
      localStorage.setItem(KEYS_STORAGE, await encryptToEnvelope(JSON.stringify(keys), this.passphrase));
      await this.refreshSecretNames();
    },
    async getHostSecret(name: string): Promise<HostSecret | undefined> {
      const keys = await this.readKeysDecrypted();
      return keys[name];
    },
    async readKeysDecrypted(): Promise<Record<string, HostSecret>> {
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
      // In-memory state only. The encrypted credential envelope stays in
      // localStorage — it is useless without the sync passphrase, and the
      // next sign-in unlocks it again. A per-host "Remove key" (or clearing
      // site data) is the explicit deletion path.
      this.passphrase = '';
      this.hosts = [];
      this.pulled = false;
      this.error = '';
      this.secretHosts = [];
    },
  },
});
