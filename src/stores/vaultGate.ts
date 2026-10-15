import { defineStore } from 'pinia';
import { SYNC_SLOT } from '@pocketshell/core';
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
    error: '',
  }),
  getters: {
    step(): GateStep {
      const vault = useVaultStore();
      const hosts = useHostsStore();
      if (!this.checked || vault.phase === 'unknown') return 'checking';
      if (vault.phase === 'locked') return 'vault-locked';
      if (vault.phase === 'absent') {
        return hosts.unlocked || !this.mainExists ? 'create-vault' : 'sync-passphrase';
      }
      if (!hosts.unlocked) return 'sync-passphrase';
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

    /** First setup. The vault records the sync passphrase this tab already
     * holds; a brand-new account's list is encrypted with the vault
     * passphrase itself. */
    async createVault(passphrase: string, remember: boolean): Promise<void> {
      const hosts = useHostsStore();
      const syncPassphrase = hosts.unlocked ? hosts.passphrase : passphrase;
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
