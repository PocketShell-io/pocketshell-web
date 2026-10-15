import { defineStore } from 'pinia';
import { makeSyncService, SyncConflictError } from '../api/sync';
import { SYNC_SLOT } from '@pocketshell/core';
import { parseSyncPayload, serializeSyncPayload } from '@pocketshell/core';
import { decryptEnvelope, encryptToEnvelope } from '../shared/syncCrypto';
import { mirrorGatewayAuth, type HostEntry, type HostKeyBinding } from '@pocketshell/core';
import { upsertHost } from '../hostForm';
import { useAuthStore } from './auth';
import { useVaultStore } from './vault';

/**
 * A host's credential as the dial paths consume it, resolved from the key
 * vault on connect and held in memory only. `password` doubles as a link
 * host's relay token.
 */
export interface HostSecret {
  privateKeyPem?: string;
  password?: string;
}

/**
 * Synced hosts: the desktop app's payload verbatim. Pull slot `main`, open
 * with syncCrypto (the browser twin of the desktop's SyncCrypto), parse with
 * the DESKTOP's parseSyncPayload — the same degraded-parse rules, so a blob
 * the desktop wrote is read exactly as the desktop would read it. saveHost
 * makes the web a writer too: a host created here rides the same slot, and
 * a desktop picks it up on its next sync (the pull's auto-tick).
 *
 * Credentials are NOT here any more: they live in the account key vault
 * (stores/vault.ts), bound to hosts by name, and are decrypted only on
 * connect. The sync passphrase itself comes out of the vault index, so one
 * passphrase unlocks both. Nothing plaintext is ever written to storage.
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
    /** Names of hosts bound to a vault entry (empty while the vault is locked). */
    secretHosts(): string[] {
      const vault = useVaultStore();
      if (!vault.unlocked) return [];
      const ids = new Set(vault.entries.map((e) => e.keyId));
      return Object.entries(vault.bindings)
        .filter(([, b]) => ids.has(b.keyId))
        .map(([name]) => name);
    },
  },
  actions: {
    /** Pull `main` and decrypt it with the sync passphrase. */
    async unlock(passphrase: string): Promise<void> {
      const sync = makeSyncService(useAuthStore());
      const blob = await sync.pull(SYNC_SLOT);
      this.version = blob?.version ?? 0;
      // No account blob yet: an empty list is correct, not an error.
      this.hosts = blob === null ? [] : parseSyncPayload(await decryptEnvelope(blob.data, passphrase));
      this.passphrase = passphrase;
      this.pulled = true;
      this.error = '';
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

    /**
     * Mirror the vault's per-host gateway policy onto the synced entries
     * (design s7), so the host agent side and other clients can read it
     * without the vault. Pushes only when something changed.
     */
    async mirrorGatewayAuth(bindings: Record<string, HostKeyBinding>): Promise<void> {
      if (!this.unlocked) return;
      const next = mirrorGatewayAuth(this.hosts, bindings);
      const changed = next.filter((h, i) => h.gatewayAuth !== this.hosts[i]?.gatewayAuth);
      if (changed.length > 0) await this.pushUpserted(changed);
    },

    /** The host's credential, decrypted from the vault into memory.
     * Throws VaultLockedError while the vault is locked. */
    async getHostSecret(name: string): Promise<HostSecret | undefined> {
      const secret = await useVaultStore().secretFor(name);
      if (secret === null) return undefined;
      return secret.kind === 'key' ? { privateKeyPem: secret.pem } : { password: secret.password };
    },

    signOutLocal() {
      // In-memory state only; the vault store forgets its own session.
      this.passphrase = '';
      this.hosts = [];
      this.pulled = false;
      this.error = '';
    },
  },
});
