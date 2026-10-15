/**
 * "Remember on this device" for the key vault: the vault's DEK — and the
 * AUTH value that answers the phase-2 verify, so a gated server still opens
 * for a remembered device — never the passphrase, is encrypted with an AES-GCM key generated NON-extractable in
 * this browser's IndexedDB, one per Google account `sub` — the same pattern
 * as passphraseVault.ts. Script can use that key through crypto.subtle but
 * never read it, so the record in localStorage is useless anywhere else.
 *
 * The record carries the vault's `vaultId` and `epoch` in the clear: after a
 * reset (new vault, bumped epoch) the store reports it stale, it is deleted
 * and the passphrase asked for. Every failure fails closed the same way.
 */
import { b64url, fromB64url } from './b64';
import type { VaultRememberRecord as RememberRecord } from '@pocketshell/core';

const DB_NAME = 'pocketshell-vault';
const DB_STORE = 'keys';
const RECORD_PREFIX = 'ps.vaultDek.';

interface StoredRecord {
  v: 1;
  vaultId: string;
  epoch: number;
  iv: string;
  ct: string;
}

export function dekRecordKey(sub: string): string {
  return RECORD_PREFIX + sub;
}

export function hasRememberedDek(sub: string): boolean {
  return localStorage.getItem(dekRecordKey(sub)) !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the vault database'));
  });
}

function idb<T>(db: IDBDatabase, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const req = run(tx.objectStore(DB_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('vault database request failed'));
  });
}

async function deviceKey(sub: string, create: boolean): Promise<CryptoKey | null> {
  const name = `dek-${sub}`;
  const db = await openDb();
  try {
    const existing = await idb<CryptoKey | undefined>(db, (s) => s.get(name));
    if (existing instanceof CryptoKey) return existing;
    if (!create) return null;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb(db, (s) => s.put(key, name));
    return key;
  } finally {
    db.close();
  }
}

const aad = (sub: string) => new TextEncoder().encode(`pocketshell-web/remember|${sub}`);

/**
 * Wrap the store's remember record (DEK + AUTH) under this browser's device
 * key. The caller's copy of the raw bytes is wiped here.
 */
export async function rememberRecord(sub: string, record: RememberRecord): Promise<void> {
  const key = (await deviceKey(sub, true))!;
  const plain = new TextEncoder().encode(
    JSON.stringify({ dek: b64url(record.dek), ...(record.auth ? { auth: b64url(record.auth) } : {}) }),
  );
  record.dek.fill(0);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(sub) }, key, plain);
    const stored: StoredRecord = {
      v: 1,
      vaultId: record.vaultId,
      epoch: record.epoch,
      iv: b64url(iv),
      ct: b64url(new Uint8Array(ct)),
    };
    localStorage.setItem(dekRecordKey(sub), JSON.stringify(stored));
  } finally {
    plain.fill(0);
  }
}

/** The remembered record, or null. Anything that does not open is deleted;
 * the store answers `stale` for another vault or epoch. */
export async function recallRecord(sub: string): Promise<RememberRecord | null> {
  const raw = localStorage.getItem(dekRecordKey(sub));
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as Partial<StoredRecord>;
    if (r.v !== 1 || typeof r.vaultId !== 'string' || typeof r.epoch !== 'number' || typeof r.iv !== 'string' || typeof r.ct !== 'string') {
      throw new Error('malformed remembered vault record');
    }
    const key = await deviceKey(sub, false);
    if (key === null) throw new Error('the device key is gone');
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64url(r.iv) as BufferSource, additionalData: aad(sub) },
        key,
        fromB64url(r.ct) as BufferSource,
      ),
    );
    try {
      const inner = JSON.parse(new TextDecoder().decode(plain)) as { dek?: string; auth?: string };
      if (typeof inner.dek !== 'string') throw new Error('no key in the remembered record');
      return {
        vaultId: r.vaultId,
        epoch: r.epoch,
        dek: fromB64url(inner.dek),
        ...(typeof inner.auth === 'string' ? { auth: fromB64url(inner.auth) } : {}),
      };
    } finally {
      plain.fill(0);
    }
  } catch {
    await forgetDek(sub);
    return null;
  }
}

/** "Forget on this device", a stale record, and sign-out: both halves go. */
export async function forgetDek(sub: string): Promise<void> {
  localStorage.removeItem(dekRecordKey(sub));
  try {
    const db = await openDb();
    try {
      await idb(db, (s) => s.delete(`dek-${sub}`));
    } finally {
      db.close();
    }
  } catch {
    // No IndexedDB: the localStorage half is already gone, which is enough.
  }
}
