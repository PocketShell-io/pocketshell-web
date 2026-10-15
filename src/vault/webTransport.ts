/**
 * The vault's slot transport over the web's SyncService (`/settings/{slot}`,
 * versioned, 409 on conflict). A 403 on a vault slot is the phase-2 gate
 * (`vault_verify_required`, reads and writes): reported as `gated` so the
 * store verifies first.
 */
import { SyncApiError, SyncConflictError, type SyncService } from '../api/sync';
import type { VaultSlotTransport } from '@pocketshell/core';

export function makeVaultTransport(sync: () => SyncService): VaultSlotTransport {
  return {
    async pull(slot) {
      try {
        const got = await sync().pull(slot);
        return got === null ? { kind: 'absent' } : { kind: 'ok', version: got.version, data: got.data };
      } catch (err) {
        if (err instanceof SyncApiError && err.status === 403) return { kind: 'gated' };
        throw err;
      }
    },
    async push(slot, data, baseVersion) {
      try {
        return { kind: 'ok', version: (await sync().push(slot, data, baseVersion)).version };
      } catch (err) {
        if (err instanceof SyncConflictError) return { kind: 'conflict', currentVersion: err.currentVersion };
        if (err instanceof SyncApiError && err.status === 403) return { kind: 'gated' };
        return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    },
    async delete(slot) {
      await sync().remove(slot);
    },
    async list() {
      return (await sync().list()).map((s) => ({ slot: s.slot, version: s.version }));
    },
  };
}
