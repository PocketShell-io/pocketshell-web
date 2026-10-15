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
  LEGACY_KEYS_SLOT,
  migrateLegacy,
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
      if (this.legacy !== null && hasLegacy(this.legacy)) return 'migrate';
      return 'ready';
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
      if (!hosts.unlocked) await hosts.unlock(syncPassphrase);
      this.seedSyncStore();
      await this.checkLegacy();
    },

    /** Move legacy credentials in; delete the legacy copies only when every
     * one of them made it (or nothing was left to move). */
    async migrate(keyPassphrases: Record<string, string> = {}): Promise<void> {
      if (this.legacy === null) return;
      const result = await migrateLegacy(useVaultStore().core(), this.legacy.items, keyPassphrases);
      useVaultStore().refresh();
      await useVaultStore().mirrorToHostList();
      this.failures = result.failed;
      if (result.failed.length === 0) await this.finishMigration();
      else {
        const left = new Set(result.failed.map((f) => f.host));
        this.legacy = { ...this.legacy, items: this.legacy.items.filter((i) => left.has(i.hostAlias)) };
      }
    },

    /** Also the explicit "drop what could not be moved" path. */
    async finishMigration(): Promise<void> {
      await deleteLegacy(useAuthStore(), claimsOf(useAuthStore().idToken).sub);
      this.legacy = null;
      this.failures = [];
    },

    reset(): void {
      this.$reset();
    },
  },
});
