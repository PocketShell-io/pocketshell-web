/**
 * The hard cut from the legacy credential store to the key vault.
 *
 * Before the vault, the web kept one record per host name ({privateKeyPem,
 * keyPassphrase, password}) encrypted with the SYNC passphrase, in two
 * places: the account's `keys` slot and this browser's `ps.hostKeys` cache.
 * On the first vault unlock after the upgrade each copy is read on its own
 * (absent, read, or unreadable), the read ones are merged (the account wins
 * per host) and moved into the vault with core's migrateLegacyKeys (keys
 * decrypted with their own passphrase, passwords as password entries,
 * existing bindings untouched), every moved credential is read back out of
 * the vault, and only then are the READ copies deleted. A copy that failed
 * to load, or that this sync passphrase does not open, is never deleted
 * automatically: it may hold the only copy of a key.
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

export { LEGACY_KEYS_SLOT };
export const LEGACY_LOCAL_KEY = 'ps.hostKeys';

/**
 * One legacy copy. `unreadable` is never deleted automatically: a fetch that
 * failed, or an envelope this sync passphrase does not open (an older one),
 * or a payload core refuses, may still hold the only copy of a key.
 */
export interface LegacySource {
  state: 'absent' | 'read' | 'unreadable';
  items: LegacyMigrationItem[];
  /** Why it is unreadable: the fetch failed (retry later) or it did not decrypt/parse. */
  reason?: 'fetch' | 'decrypt';
  /** The envelope, kept to retry with an older sync passphrase. */
  envelope?: string;
}

export interface LegacyState {
  account: LegacySource;
  local: LegacySource;
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

async function sourceOf(envelope: string, syncPassphrase: string): Promise<LegacySource> {
  try {
    const parsed = parseLegacyKeysSlot(await decryptEnvelope(envelope, syncPassphrase));
    if (parsed.kind === 'ok') return { state: 'read', items: parsed.items };
  } catch {
    // falls through: not openable with this passphrase
  }
  return { state: 'unreadable', items: [], reason: 'decrypt', envelope };
}

/** Read both legacy sources with the sync passphrase, each on its own. */
export async function readLegacy(syncPassphrase: string, auth: TokenSource, svc?: SyncService): Promise<LegacyState> {
  const sync = svc ?? makeSyncService(auth);
  let account: LegacySource;
  try {
    const blob = await sync.pull(LEGACY_KEYS_SLOT);
    account = blob === null ? { state: 'absent', items: [] } : await sourceOf(blob.data, syncPassphrase);
  } catch {
    account = { state: 'unreadable', items: [], reason: 'fetch' };
  }
  const raw = localStorage.getItem(LEGACY_LOCAL_KEY);
  const local = raw === null ? ({ state: 'absent', items: [] } as LegacySource) : await sourceOf(raw, syncPassphrase);
  return { account, local };
}

/** Retry the sources that did not decrypt with an older sync passphrase.
 * Throws when it opens none of them. */
export async function openLegacyWith(state: LegacyState, passphrase: string): Promise<LegacyState> {
  const retry = async (s: LegacySource) =>
    s.state === 'unreadable' && s.reason === 'decrypt' && s.envelope ? sourceOf(s.envelope, passphrase) : s;
  const next = { account: await retry(state.account), local: await retry(state.local) };
  if (next.account.state === state.account.state && next.local.state === state.local.state) {
    throw new Error("That passphrase doesn't open your old saved keys either.");
  }
  return next;
}

/** The credentials to move: every READ source, the account winning per host. */
export function legacyItems(state: LegacyState): LegacyMigrationItem[] {
  const account = state.account.state === 'read' ? state.account.items : [];
  const local = state.local.state === 'read' ? state.local.items : [];
  const accountHosts = new Set(account.map((i) => i.hostAlias));
  return [...account, ...local.filter((i) => !accountHosts.has(i.hostAlias))];
}

/** Something is left to move, delete, or ask the user about. */
export function hasLegacy(state: LegacyState): boolean {
  return state.account.state !== 'absent' || state.local.state !== 'absent';
}

export function hasUnreadable(state: LegacyState): boolean {
  return state.account.state === 'unreadable' || state.local.state === 'unreadable';
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

/**
 * Delete the legacy copies that were READ (and whose items all moved, or the
 * user chose to drop the rest). Unreadable copies stay, unless `unreadable`
 * is passed for an explicit, confirmed "delete the unreadable copies too".
 */
export async function deleteLegacy(
  state: LegacyState,
  auth: TokenSource,
  opts: { unreadable?: boolean } = {},
  svc?: SyncService,
): Promise<LegacyState> {
  const sync = svc ?? makeSyncService(auth);
  const go = (s: LegacySource) => s.state === 'read' || (opts.unreadable === true && s.state === 'unreadable');
  const next: LegacyState = { ...state };
  if (go(state.account)) {
    await sync.remove(LEGACY_KEYS_SLOT);
    next.account = { state: 'absent', items: [] };
  }
  if (go(state.local)) {
    localStorage.removeItem(LEGACY_LOCAL_KEY);
    next.local = { state: 'absent', items: [] };
  }
  return next;
}
