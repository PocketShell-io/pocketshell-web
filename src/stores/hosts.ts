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
 * The second settings slot the secrets envelope lives in. The desktop only
 * ever reads/writes `main` (its parser has never seen this slot), so keys
 * roam between browsers without any desktop change — the same opaque-blob
 * treatment the account list gets, verified against the aws-infra sync API
 * (slot names are client-chosen; the server stores ciphertext only).
 */
const KEYS_SLOT = 'keys';

/**
 * What one host's synced credential record holds, encrypted at rest under
 * the sync passphrase. `passphrase` is the PRIVATE KEY's passphrase (an
 * encrypted OpenSSH key needs it before a session can use the key) — not to
 * be confused with the sync passphrase, which never leaves this module.
 */
export interface HostSecret {
  privateKeyPem?: string;
  password?: string;
  keyPassphrase?: string;
}

/**
 * Synced hosts and the credentials that make them usable — on every device.
 *
 * The host list is the desktop app's payload verbatim: pull slot `main`,
 * open with syncCrypto (the browser twin of the desktop's SyncCrypto),
 * parse with the DESKTOP's parseSyncPayload — the same degraded-parse rules,
 * so a blob the desktop wrote is read exactly as the desktop would read it.
 * saveHost makes the web a writer too: a host created here rides the same
 * slot, and a desktop picks it up on its next sync (the pull's auto-tick).
 *
 * Secrets used to live only in this browser (`ps.hostKeys`), which made a
 * key uploaded here useless on the tablet. They now ride the SAME scheme in
 * the second slot (`keys`): client-encrypted with the sync passphrase, the
 * server stores just another opaque envelope it can never open. The local
 * envelope stays as the offline cache and the migration source — on unlock
 * the two are merged (the account's entry wins per host; entries only this
 * browser had are pushed up), so an upgrade uploads the old keys once and
 * every later device gets them from the account. A session still sends the
 * secret once, over the authenticated transport, only when connecting.
 */
export const useHostsStore = defineStore('hosts', {
  state: () => ({
    passphrase: '',
    hosts: [] as HostEntry[],
    version: 0,
    pulled: false,
    error: '',
    /** Names of hosts that have a key or password, here or in the account. */
    secretHosts: [] as string[],
    /** The merged credential map this session works from. */
    secrets: {} as Record<string, HostSecret>,
    keyVersion: 0,
    /** This browser holds the sync passphrase in the passphraseVault, so the
     * topbar can offer to forget it. Storage itself lives in the vault. */
    passphraseRemembered: false,
  }),
  getters: {
    unlocked: (s) => s.pulled && s.passphrase !== '',
  },
  actions: {
    /** Pull both slots and decrypt them with the passphrase. The two pulls
     * (and the two PBKDF2 derivations behind them) run concurrently, so
     * unlocking costs the same wall time as before the keys slot. */
    async unlock(passphrase: string): Promise<void> {
      const auth = useAuthStore();
      const sync = makeSyncService(auth);
      // A keys-slot failure (5xx, offline API after a cached sign-in) must
      // not take the host list down: fall back to this browser's cache.
      const [blob, keysBlob] = await Promise.all([
        sync.pull(SYNC_SLOT),
        sync.pull(KEYS_SLOT).catch(() => null),
      ]);
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

      let synced: Record<string, HostSecret> = {};
      if (keysBlob !== null) {
        try {
          synced = parseSecretsPayload(await decryptEnvelope(keysBlob.data, passphrase));
        } catch {
          synced = {}; // wrong passphrase is impossible here (main opened fine) — treat as empty
        }
      }
      const local = await this.readLocalSecrets();
      const merged = mergedSecrets(local, synced);
      this.secrets = merged;
      this.keyVersion = keysBlob?.version ?? 0;
      await this.writeLocalCache();
      await this.refreshSecretNames();
      // Anything only this browser had goes to the account exactly once —
      // the merge after the next unlock is then a no-op.
      if (JSON.stringify(merged) !== JSON.stringify(synced)) {
        await this.pushSecrets(merged).catch(() => {
          // Non-fatal: the cache still works here, and the next unlock
          // retries the upload. Nothing plaintext ever surfaced either way.
        });
      }
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

    /** Names of hosts that currently have a usable key or password. */
    async refreshSecretNames(): Promise<void> {
      this.secretHosts = Object.keys(this.secrets).filter((name) => {
        const s = this.secrets[name];
        return (s.privateKeyPem ?? '') !== '' || (s.password ?? '') !== '';
      });
    },

    /** Attach (or replace) the key/passphrase used for a host — this device
     * AND the account, so every other device picks it up on next unlock.
     * Passing an empty secret clears the stored one. */
    async setHostSecret(name: string, secret: HostSecret) {
      const keys = { ...(await this.currentSecrets()) };
      keys[name] = secret;
      this.secrets = keys;
      await this.writeLocalCache();
      await this.pushSecrets(keys);
      await this.refreshSecretNames();
    },

    /** Delete a host's credential here and in the account, on explicit user
     * action. The synced host list is untouched. Other devices drop it on
     * their next unlock merge (the account no longer has it; a stale LOCAL
     * copy on a device that never re-unlocks is out of scope). */
    async removeHostSecret(name: string) {
      const keys = { ...(await this.currentSecrets()) };
      delete keys[name];
      this.secrets = keys;
      await this.writeLocalCache();
      await this.pushSecrets(keys);
      await this.refreshSecretNames();
    },
    async getHostSecret(name: string): Promise<HostSecret | undefined> {
      return (await this.currentSecrets())[name];
    },

    /** The session's merged map, falling back to the local cache before the
     * first unlock (the Key dialog can run pre-unlock, as it always has). */
    async currentSecrets(): Promise<Record<string, HostSecret>> {
      if (this.pulled) return this.secrets;
      return this.readLocalSecrets();
    },

    async readLocalSecrets(): Promise<Record<string, HostSecret>> {
      const raw = localStorage.getItem(KEYS_STORAGE);
      if (raw === null || this.passphrase === '') return {};
      try {
        return parseSecretsPayload(await decryptEnvelope(raw, this.passphrase));
      } catch {
        // Wrong passphrase after a change, or garbage — treat as empty; the
        // user can re-attach secrets, nothing leaves the browser either way.
        return {};
      }
    },

    /** The local cache: what makes the app work when the sync API is down. */
    async writeLocalCache(): Promise<void> {
      if (this.passphrase === '') return;
      localStorage.setItem(KEYS_STORAGE, await encryptToEnvelope(serializeSecretsPayload(this.secrets), this.passphrase));
    },

    /** Push the secrets map to the account slot; on a 409 (another device
     * saved a key meanwhile) re-base and re-apply OUR entries per host — the
     * same whole-entry rule the host list uses, never a half-merged secret. */
    async pushSecrets(target: Record<string, HostSecret>): Promise<void> {
      const sync = makeSyncService(useAuthStore());
      let base = target;
      let baseVersion = this.keyVersion;
      for (let attempt = 0; ; attempt++) {
        const envelope = await encryptToEnvelope(serializeSecretsPayload(base), this.passphrase);
        try {
          const { version } = await sync.push(KEYS_SLOT, envelope, baseVersion);
          this.secrets = base;
          this.keyVersion = version;
          return;
        } catch (err) {
          if (!(err instanceof SyncConflictError) || attempt >= 2) throw err;
          const blob = await sync.pull(KEYS_SLOT);
          if (blob === null) throw new Error('your synced keys changed on the server — reload and try again');
          const fresh = parseSecretsPayload(await decryptEnvelope(blob.data, this.passphrase));
          base = mergedSecrets(target, fresh);
          baseVersion = blob.version;
        }
      }
    },

    signOutLocal() {
      // In-memory state only. The encrypted caches stay in localStorage —
      // they are useless without the sync passphrase, and the next sign-in
      // unlocks them again. A per-host "Remove key" (or clearing site data)
      // is the explicit deletion path.
      this.passphrase = '';
      this.hosts = [];
      this.pulled = false;
      this.error = '';
      this.secretHosts = [];
      this.secrets = {};
      this.keyVersion = 0;
      // The vault itself survives sign-out: the saved passphrase is bound to
      // this browser AND this Google account, so the next sign-in with the
      // same account auto-unlocks. The topbar's Forget is the explicit path.
      this.passphraseRemembered = false;
    },
  },
});

/** The account's record wins per host; a key only this browser had survives
 * the merge so unlock can upload it. Whole records, never half-merged. */
function mergedSecrets(local: Record<string, HostSecret>, synced: Record<string, HostSecret>): Record<string, HostSecret> {
  const out: Record<string, HostSecret> = {};
  for (const name of Object.keys(local)) out[name] = local[name];
  for (const name of Object.keys(synced)) out[name] = synced[name];
  return out;
}

/** The plaintext inside the keys envelope — versioned for the same reason
 * the host payload shape is. */
function serializeSecretsPayload(secrets: Record<string, HostSecret>): string {
  return JSON.stringify({ v: 1, secrets });
}

/** Degraded parse, same philosophy as parseSyncPayload: anything that is not
 * a plausible secrets map parses to an EMPTY map, not an error — a blob is
 * user data from possibly an older build. */
function parseSecretsPayload(plaintext: string): Record<string, HostSecret> {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const raw = (parsed as Record<string, unknown>)['secrets'];
    if (typeof raw !== 'object' || raw === null) return {};
    const out: Record<string, HostSecret> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const secret: HostSecret = {};
      for (const field of ['privateKeyPem', 'password', 'keyPassphrase'] as const) {
        if (typeof v[field] === 'string') secret[field] = v[field] as string;
      }
      out[name] = secret;
    }
    return out;
  } catch {
    return {};
  }
}
