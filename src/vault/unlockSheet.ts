/**
 * The connect-time unlock sheet's state. A dial that finds the vault locked
 * calls `requestVaultUnlock` and waits: the sheet (VaultUnlockSheet.vue,
 * mounted once by main.ts) asks for the passphrase and settles the promise
 * with whether the vault is now open. Concurrent dials share one sheet.
 */
import { reactive } from 'vue';

export const unlockSheet = reactive({
  open: false,
  reason: '',
});

let waiters: ((ok: boolean) => void)[] = [];

export function requestVaultUnlock(reason?: Error): Promise<boolean> {
  unlockSheet.reason = reason?.message ?? '';
  unlockSheet.open = true;
  return new Promise((resolve) => waiters.push(resolve));
}

export function settleVaultUnlock(ok: boolean): void {
  unlockSheet.open = false;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve(ok);
}
