/**
 * Per-device "remember the sync passphrase" vault — the safe variant of
 * "save it on this computer": the passphrase is encrypted with an AES-GCM
 * key that is generated once per account and stored NON-extractable in this
 * browser's IndexedDB. Only the ciphertext lands in localStorage
 * (`ps.passVault.<sub>`); script (including an XSS payload) can USE the key
 * through crypto.subtle but can never read or export it, and the blob is
 * useless on any other device or for any other Google account — the key is
 * namespaced by the account's `sub`. Nothing here touches the network: the
 * sync server never receives the passphrase, encrypted or not.
 *
 * Losing either half (site data cleared on one side, a tampered blob) fails
 * closed: recall returns null and clears the stale half, and the unlock card
 * simply asks for the passphrase again.
 */

const DB_NAME = 'pocketshell-vault';
const DB_STORE = 'keys';
const BLOB_PREFIX = 'ps.passVault.';
const IV_BYTES = 12;

interface VaultBlob {
  v: 1;
  iv: string;
  ct: string;
}

/** The localStorage key holding this account's encrypted passphrase. */
export function vaultBlobKey(sub: string): string {
  return BLOB_PREFIX + sub;
}

/** True when this browser holds a saved passphrase for this account. */
export function hasVault(sub: string): boolean {
  return localStorage.getItem(vaultBlobKey(sub)) !== null;
}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the vault database'));
  });
}

function idbRequest<T>(db: IDBDatabase, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const req = run(tx.objectStore(DB_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('vault database request failed'));
  });
}

/** The account's key, generated on first use. Re-generated if the record is
 * gone but the blob somehow survived — the old blob then fails its GCM tag
 * and recall clears it. */
async function vaultKey(sub: string): Promise<CryptoKey> {
  const name = `sync-${sub}`;
  const db = await openVaultDb();
  try {
    const existing = await idbRequest<CryptoKey | undefined>(db, (store) => store.get(name));
    if (existing instanceof CryptoKey) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await idbRequest(db, (store) => store.put(key, name));
    return key;
  } finally {
    db.close();
  }
}

/** Encrypt the passphrase under this browser's per-account key and store the
 * ciphertext in localStorage. Fresh IV per call. */
export async function rememberPassphrase(sub: string, passphrase: string): Promise<void> {
  const key = await vaultKey(sub);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(passphrase),
  );
  const blob: VaultBlob = { v: 1, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
  localStorage.setItem(vaultBlobKey(sub), JSON.stringify(blob));
}

/** The saved passphrase, or null when this browser has none — or the saved
 * copy can no longer be decrypted (key cleared, blob tampered), in which
 * case the stale half is removed rather than left as a trap. */
export async function recallPassphrase(sub: string): Promise<string | null> {
  const raw = localStorage.getItem(vaultBlobKey(sub));
  if (raw === null) return null;
  try {
    const f = JSON.parse(raw) as Partial<VaultBlob>;
    if (f.v !== 1 || typeof f.iv !== 'string' || typeof f.ct !== 'string') {
      throw new Error('vault blob is not the expected shape');
    }
    const key = await vaultKey(sub);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(f.iv) as BufferSource },
      key,
      b64decode(f.ct) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    void forgetPassphrase(sub);
    return null;
  }
}

/** Remove the saved passphrase and its key from this browser — the explicit
 * "forget on this computer" path. The unlocked session is untouched. */
export async function forgetPassphrase(sub: string): Promise<void> {
  localStorage.removeItem(vaultBlobKey(sub));
  const db = await openVaultDb();
  try {
    await idbRequest(db, (store) => store.delete(`sync-${sub}`));
  } finally {
    db.close();
  }
}
