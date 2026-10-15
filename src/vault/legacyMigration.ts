/**
 * The hard cut from the legacy credential store to the key vault.
 *
 * Before the vault, the web kept one record per host name ({privateKeyPem,
 * keyPassphrase, password}) encrypted with the SYNC passphrase, in two
 * places: the account's `keys` slot and this browser's `ps.hostKeys` cache.
 * On the first vault unlock after the upgrade both are read and merged (the
 * account wins per host), moved into the vault with core's
 * migrateLegacyKeys (keys decrypted with their own passphrase, passwords as
 * password entries, existing bindings untouched), every moved credential is
 * read back out of the vault, and only then are the legacy copies deleted —
 * together with the remembered sync passphrase this browser may hold
 * (`ps.passVault.<sub>`), which the remembered vault key replaces.
 */
import {
  LEGACY_KEYS_SLOT,
  migrateLegacyKeys,
  parseLegacyKeysSlot,
  type KeyVaultStore,
  type LegacyMigrationItem,
} from '@pocketshell/core';
import { makeSyncService, type SyncService, type TokenSource } from '../api/sync';
import { decryptEnvelope } from '../shared/syncCrypto';
import { forgetPassphrase } from '../shared/passphraseVault';

export { LEGACY_KEYS_SLOT };
export const LEGACY_LOCAL_KEY = 'ps.hostKeys';

export interface LegacyState {
  items: LegacyMigrationItem[];
  /** The account slot existed (it is deleted after a verified migration). */
  hasSlot: boolean;
  hasLocal: boolean;
}

export interface MigrationFailure {
  host: string;
  reason: 'needs-passphrase' | 'bad-passphrase' | 'error';
  message: string;
}

export interface MigrationResult {
  migrated: string[];
  failed: MigrationFailure[];
}

async function itemsOf(envelope: string, syncPassphrase: string): Promise<LegacyMigrationItem[]> {
  try {
    const parsed = parseLegacyKeysSlot(await decryptEnvelope(envelope, syncPassphrase));
    return parsed.kind === 'ok' ? parsed.items : [];
  } catch {
    // Not openable with this passphrase, or junk: nothing to move.
    return [];
  }
}

/** Read both legacy sources with the sync passphrase; the account's
 * records win per host over this browser's cache. */
export async function readLegacy(syncPassphrase: string, auth: TokenSource, svc?: SyncService): Promise<LegacyState> {
  const sync = svc ?? makeSyncService(auth);
  const blob = await sync.pull(LEGACY_KEYS_SLOT).catch(() => null);
  const account = blob === null ? [] : await itemsOf(blob.data, syncPassphrase);
  const raw = localStorage.getItem(LEGACY_LOCAL_KEY);
  const local = raw === null ? [] : await itemsOf(raw, syncPassphrase);
  const accountHosts = new Set(account.map((i) => i.hostAlias));
  return {
    items: [...account, ...local.filter((i) => !accountHosts.has(i.hostAlias))],
    hasSlot: blob !== null,
    hasLocal: raw !== null,
  };
}

export function hasLegacy(state: LegacyState): boolean {
  return state.hasSlot || state.hasLocal;
}

/**
 * Move the items into the (unlocked) vault, then read every moved one back.
 * `keyPassphrases` supplies a key passphrase the legacy record lacked.
 */
export async function migrateLegacy(
  store: KeyVaultStore,
  items: LegacyMigrationItem[],
  keyPassphrases: Record<string, string> = {},
): Promise<MigrationResult> {
  const withPass = items.map((i) =>
    i.kind === 'key' && keyPassphrases[i.hostAlias] ? { ...i, keyPassphrase: keyPassphrases[i.hostAlias] } : i,
  );
  const report = await migrateLegacyKeys(store, withPass);
  const failed: MigrationFailure[] = [];
  const migrated: string[] = [];
  for (const o of report.outcomes) {
    if (o.status === 'needsPassphrase') {
      failed.push({ host: o.hostAlias, reason: 'needs-passphrase', message: 'This key is encrypted. Enter its passphrase to move it into the vault.' });
    } else if (o.status === 'wrongPassphrase') {
      failed.push({ host: o.hostAlias, reason: 'bad-passphrase', message: 'The saved key passphrase does not open this key. Enter the right one.' });
    } else if (o.status === 'failed') {
      failed.push({ host: o.hostAlias, reason: 'error', message: o.message });
    } else if (o.status === 'migrated') {
      // Verify: the vault must hand back the same kind of credential.
      const back = await store.decryptKey(o.keyId);
      if (back.kind === o.kind) migrated.push(o.hostAlias);
      else failed.push({ host: o.hostAlias, reason: 'error', message: 'The migrated credential did not read back from the vault.' });
    }
  }
  return { migrated, failed };
}

/** Delete every legacy copy. Only after a verified migration (or when the
 * user explicitly drops what could not be moved). */
export async function deleteLegacy(auth: TokenSource, sub: string, svc?: SyncService): Promise<void> {
  const sync = svc ?? makeSyncService(auth);
  await sync.remove(LEGACY_KEYS_SLOT);
  localStorage.removeItem(LEGACY_LOCAL_KEY);
  await forgetPassphrase(sub).catch(() => undefined);
}
