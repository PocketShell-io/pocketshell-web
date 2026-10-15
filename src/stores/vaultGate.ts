import { defineStore } from 'pinia';
import { generateSyncPassphrase, SYNC_SLOT, vaultPassphraseReusesSync, type HostKeyBinding } from '@pocketshell/core';
import { useSyncStore } from '@ui/app/stores/sync';
import { makeSyncService } from '../api/sync';
import { claimsOf } from '../auth/google';
import { forgetPassphrase, recallPassphrase } from '../shared/passphraseVault';
import { useAuthStore } from './auth';
import { useHostsStore } from './hosts';
import { useVaultStore } from './vault';
import {
  deleteLegacy,
  hasLegacy,
  hasUnreadable,
  LEGACY_KEYS_SLOT,
  legacyItems,
  migrateLegacy,
  openLegacyWith,
  readLegacy,
  type LegacyState,
  type MigrationFailure,
} from '../vault/legacyMigration';

/**
 * Which screen the account needs next. One passphrase opens everything: the
 * vault index carries the sync passphrase, so a vault unlock also opens the
 * host list. The other steps exist for the upgrade and for edge cases.
 */
export type GateStep =
  | 'checking'
  /** The vault exists and is locked: ask for the vault passphrase. */
  | 'vault-locked'
  /** No vault yet but a host list exists (pre-vault account), or the sync
   * passphrase in the index no longer opens `main`: ask for it. */
  | 'sync-passphrase'
  /** No vault yet and the host list is open (or there is none): create it. */
  | 'create-vault'
  /** Vault open, legacy credentials still around: move them in. */
  | 'migrate'
  /** The vault passphrase also opens the host list (set up by an older
   * build): offer to re-encrypt the list under a generated passphrase. */
  | 'resecure'
  /** The account could not be opened at all (gate.error says why). */
  | 'error'
  | 'ready';

/**
 * The web's account-opening sequence over the vault and hosts stores:
 * silent open (remembered vault key), the passphrase steps, first setup and
 * the one-time legacy migration.
 */
export const useVaultGateStore = defineStore('vaultGate', {
  state: () => ({
    checked: false,
    mainExists: false,
    legacy: null as LegacyState | null,
    failures: [] as MigrationFailure[],
    /** The user chose to continue without the unreadable old copies (this
     * session only; they are kept and offered again next time). */
    legacyDeferred: false,
    /** The vault passphrase just typed also opens `main` (decision #7). */
    needsResecure: false,
    resecureDeferred: false,
    error: '',
  }),
  getters: {
    step(): GateStep {
      const vault = useVaultStore();
      const hosts = useHostsStore();
      if (!this.checked) return 'checking';
      if (vault.phase === 'unknown') return this.error !== '' ? 'error' : 'checking';
      if (vault.phase === 'locked') return 'vault-locked';
      if (vault.phase === 'absent') {
        return hosts.unlocked || !this.mainExists ? 'create-vault' : 'sync-passphrase';
      }
      if (!hosts.unlocked) return 'sync-passphrase';
      if (this.needsResecure && !this.resecureDeferred) return 'resecure';
      if (this.legacy !== null && this.legacyPending) return 'migrate';
      return 'ready';
    },
    /** Something legacy still needs moving, deleting or the user's answer. */
    legacyPending(): boolean {
      const l = this.legacy;
      if (l === null || !hasLegacy(l)) return false;
      const readLeft = l.account.state === 'read' || l.local.state === 'read';
      return readLeft || (hasUnreadable(l) && !this.legacyDeferred);
    },
    /** Why an old copy was kept, for the migration card. */
    legacyNotice(): string {
      const l = this.legacy;
      if (l === null) return '';
      if (l.account.state === 'unreadable' && l.account.reason === 'fetch') {
        return 'Your old saved keys on the account could not be read right now (the server did not answer). They are kept; this runs again next time.';
      }
      if (hasUnreadable(l)) {
        return 'Some old saved keys could not be read with your current sync passphrase. They are kept. If you changed the sync passphrase, enter the old one to move them.';
      }
      return '';
    },
  },
  actions: {
    /** The silent part: probe, try the remembered key, open the host list. */
    async open(): Promise<GateStep> {
      const vault = useVaultStore();
      const hosts = useHostsStore();
      this.error = '';
      try {
        const slots = await makeSyncService(useAuthStore()).list();
        this.mainExists = slots.some((s) => s.slot === SYNC_SLOT);
        await vault.probe();
        if (vault.phase === 'locked') await vault.unlockRemembered();
        if (vault.phase === 'absent' && !hosts.unlocked && this.mainExists) {
          // A pre-vault browser may still remember the sync passphrase: open
          // the list with it so the upgrade starts at "create your vault".
          await this.openWithLegacyRemembered();
        }
        await this.afterVault();
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        // The list call failing must not strand the page: fall back to the
        // header probe alone.
        if (vault.phase === 'unknown') await vault.probe().catch(() => undefined);
      } finally {
        this.checked = true;
      }
      return this.step;
    },

    async openWithLegacyRemembered(): Promise<void> {
      const sub = claimsOf(useAuthStore().idToken).sub;
      const saved = await recallPassphrase(sub);
      if (saved === null || saved === '') return;
      try {
        await useHostsStore().unlock(saved);
      } catch {
        await forgetPassphrase(sub);
      }
    },

    /** Once the vault is open: the host list from the index's sync
     * passphrase, the shared Account page seeded, legacy checked. */
    async afterVault(): Promise<void> {
      const vault = useVaultStore();
      const hosts = useHostsStore();
      if (!vault.unlocked) return;
      // The pre-vault remembered SYNC passphrase is superseded by the
      // remembered vault key: once the vault opens, it goes.
      await forgetPassphrase(claimsOf(useAuthStore().idToken).sub).catch(() => undefined);
      if (!hosts.unlocked) {
        const sp = vault.syncPassphrase();
        if (sp === '' && this.mainExists) return; // ask for it (sync-passphrase step)
        try {
          await hosts.unlock(sp);
        } catch {
          this.error = 'Your host list uses a different passphrase now (changed on another device). Enter the sync passphrase once to update your vault.';
          return;
        }
      }
      this.seedSyncStore();
      await this.checkLegacy();
    },

    seedSyncStore(): void {
      const hosts = useHostsStore();
      try {
        const sync = useSyncStore();
        if (sync.passphrase === '') sync.passphrase = hosts.passphrase;
      } catch {
        // The shared store is optional here (tests mount without it).
      }
    },

    async checkLegacy(): Promise<void> {
      const hosts = useHostsStore();
      if (!hosts.unlocked) return;
      const hasLocal = localStorage.getItem('ps.hostKeys') !== null;
      let hasSlot = true;
      try {
        const slots = await makeSyncService(useAuthStore()).list();
        hasSlot = slots.some((s) => s.slot === LEGACY_KEYS_SLOT);
      } catch {
        // Unknown: readLegacy finds out.
      }
      if (!hasLocal && !hasSlot) {
        this.legacy = null;
        return;
      }
      this.legacy = await readLegacy(hosts.passphrase, useAuthStore());
      this.failures = [];
    },

    async submitVaultPassphrase(passphrase: string, remember: boolean): Promise<void> {
      await useVaultStore().unlock(passphrase, remember);
      await this.afterVault();
      // An older build let the vault passphrase double as the sync one.
      this.needsResecure = await vaultPassphraseReusesSync(passphrase, { syncPassphrase: useVaultStore().syncPassphrase() });
    },

    /** Decision #7's check for a NEW vault passphrase. */
    async assertNotSync(passphrase: string, syncPassphrase: string | null): Promise<void> {
      const hosts = useHostsStore();
      const reuses = await vaultPassphraseReusesSync(passphrase, {
        syncPassphrase,
        opensHostList: this.mainExists ? (p) => hosts.opensHostList(p) : undefined,
      });
      if (reuses) {
        throw new Error(
          'Choose a vault passphrase different from your sync passphrase. The host list is protected more weakly, so sharing one passphrase would expose your keys.',
        );
      }
    },

    /** Change the vault passphrase (never to the sync passphrase). */
    async changePassphrase(current: string, next: string): Promise<void> {
      await this.assertNotSync(next, useVaultStore().syncPassphrase() || null);
      await useVaultStore().changePassphrase(current, next);
      this.needsResecure = false;
    },

    /**
     * Re-encrypt the host list under a generated sync passphrase and record
     * it in the index. `main` first, then the index; if the index write
     * fails, `main` goes back to the old passphrase so nothing is stranded.
     */
    async resecureHostList(): Promise<void> {
      const hosts = useHostsStore();
      const vault = useVaultStore();
      const old = hosts.passphrase;
      const fresh = generateSyncPassphrase();
      await hosts.reencrypt(fresh);
      try {
        await vault.setSyncPassphrase(fresh);
      } catch (err) {
        hosts.passphrase = fresh;
        await hosts.reencrypt(old).catch(() => undefined);
        throw err;
      }
      try {
        useSyncStore().passphrase = fresh;
      } catch {
        // optional
      }
      this.needsResecure = false;
    },

    deferResecure(): void {
      this.resecureDeferred = true;
    },

    /**
     * Forgot passphrase, after a fresh Google sign-in. The sync passphrase
     * the new vault records: the one this tab knows (`known`), one the user
     * typed and that opens the host list (`enter`), or — `forgot`, or no
     * host list at all — a generated one, the old list being deleted.
     */
    async resetVault(
      passphrase: string,
      sync: { mode: 'known' } | { mode: 'enter'; passphrase: string } | { mode: 'forgot' },
      remember: boolean,
    ): Promise<void> {
      const hosts = useHostsStore();
      const vault = useVaultStore();
      const carry = vault.carryForReset();
      const known = carry.syncPassphrase ?? (hosts.unlocked ? hosts.passphrase : null);
      let syncPassphrase: string;
      let wipeHostList = false;
      if (sync.mode === 'known' && known !== null && known !== '') {
        syncPassphrase = known;
      } else if (sync.mode === 'enter' && this.mainExists) {
        if (!(await hosts.opensHostList(sync.passphrase))) {
          throw new Error("That sync passphrase doesn't open your host list. Nothing was reset.");
        }
        syncPassphrase = sync.passphrase;
      } else {
        syncPassphrase = generateSyncPassphrase();
        wipeHostList = this.mainExists;
      }
      if (!wipeHostList) await this.assertNotSync(passphrase, syncPassphrase);
      await vault.reset(passphrase, { hosts: carry.hosts as Record<string, HostKeyBinding>, syncPassphrase }, remember);
      if (wipeHostList) {
        await makeSyncService(useAuthStore()).remove(SYNC_SLOT);
        this.mainExists = false;
      }
      hosts.signOutLocal();
      await hosts.unlock(syncPassphrase);
      this.needsResecure = false;
      this.seedSyncStore();
      await this.checkLegacy();
    },

    /** The sync passphrase step: opens `main`; keeps the vault index in step. */
    async submitSyncPassphrase(passphrase: string): Promise<void> {
      const vault = useVaultStore();
      await useHostsStore().unlock(passphrase);
      this.error = '';
      if (vault.unlocked) await vault.setSyncPassphrase(passphrase);
      this.seedSyncStore();
      if (vault.unlocked) await this.checkLegacy();
    },

    /** First setup. The vault records the sync passphrase of an existing
     * host list (and must differ from it); an account without one gets a
     * generated sync passphrase, held only in the vault index. */
    async createVault(passphrase: string, remember: boolean): Promise<void> {
      const hosts = useHostsStore();
      const existing = hosts.unlocked && this.mainExists ? hosts.passphrase : null;
      await this.assertNotSync(passphrase, existing);
      const syncPassphrase = existing ?? generateSyncPassphrase();
      if (hosts.unlocked && hosts.passphrase !== syncPassphrase) hosts.signOutLocal();
      await useVaultStore().create(passphrase, syncPassphrase, remember);
      await forgetPassphrase(claimsOf(useAuthStore().idToken).sub).catch(() => undefined);
      if (!hosts.unlocked) await hosts.unlock(syncPassphrase);
      this.seedSyncStore();
      await this.checkLegacy();
    },

    /** Move the READ legacy copies in; delete them only when every one of
     * their credentials made it. Unreadable copies are never touched here. */
    async migrate(keyPassphrases: Record<string, string> = {}): Promise<void> {
      if (this.legacy === null) return;
      const items = legacyItems(this.legacy);
      const result = await migrateLegacy(useVaultStore().core(), items, keyPassphrases);
      useVaultStore().refresh();
      await useVaultStore().mirrorToHostList();
      this.failures = result.failed;
      if (result.failed.length === 0) {
        this.legacy = await deleteLegacy(this.legacy, useAuthStore());
      }
    },

    /** Retry the copies this sync passphrase did not open with an old one. */
    async openLegacyWith(passphrase: string): Promise<void> {
      if (this.legacy === null) return;
      this.legacy = await openLegacyWith(this.legacy, passphrase);
    },

    /** "Skip these": drop the credentials that would not move from the
     * read copies (the user confirmed); unreadable copies stay. */
    async finishMigration(): Promise<void> {
      if (this.legacy === null) return;
      this.legacy = await deleteLegacy(this.legacy, useAuthStore());
      this.failures = [];
    },

    /** Explicit, confirmed: also delete the copies that could not be read. */
    async deleteUnreadableLegacy(): Promise<void> {
      if (this.legacy === null) return;
      this.legacy = await deleteLegacy(this.legacy, useAuthStore(), { unreadable: true });
    },

    /** Continue without the unreadable copies for this session. */
    deferLegacy(): void {
      this.legacyDeferred = true;
    },

    reset(): void {
      this.$reset();
    },
  },
});
