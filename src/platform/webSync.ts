/**
 * The web's sync group: the shared Account & sync surface over the browser's
 * pieces — the GIS-backed auth store for identity, the SyncService HTTP
 * client, and web syncCrypto for the zero-knowledge envelopes. The contracts
 * are the desktop main's: pull DECRYPTS (the envelope never crosses the
 * seam), push ENCRYPTS at the last moment, a conflict comes back as a typed
 * result (the shared store re-bases and retries), and `accountHosts` is the
 * session cache of the last decrypted set — which is how the host picker
 * shows the account's hosts without ever seeing a passphrase.
 */
import type { HostEntry, SyncApplyResult, SyncPullResult, SyncPushResult, SyncStatus } from '@pocketshell/core';
import { parseSyncPayload } from '@pocketshell/core';
import { makeSyncService, NotSignedInError, SyncApiError, SyncConflictError } from '../api/sync';
import { decryptEnvelope, encryptToEnvelope, SyncCryptoError } from '../shared/syncCrypto';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';

export class WebSync {
  /** The account's hosts this session last decrypted, or null. */
  private accountHosts: HostEntry[] | null = null;

  async status(): Promise<SyncStatus> {
    const auth = useAuthStore();
    return {
      loggedIn: auth.signedIn,
      email: auth.email !== '' ? auth.email : null,
      // The browser equivalent of an OS keychain exists (the passphrase
      // vault); login never has to refuse for lack of one.
      keychainAvailable: true,
    };
  }

  /**
   * Sign in is a Google Identity Services gesture, which only the sign-in
   * surface can mount — so "Sign in" in the account panel walks the user
   * there. The promise deliberately does not resolve: the navigation is the
   * answer.
   */
  login(): Promise<string | null> {
    window.location.assign('/login');
    return new Promise(() => {});
  }

  async logout(): Promise<void> {
    useAuthStore().signOut();
    useHostsStore().signOutLocal();
    this.accountHosts = null;
  }

  /**
   * Pull the slot and decrypt it. A wrong passphrase is SyncCryptoError's
   * message — that IS the user feedback, exactly as on the desktop.
   */
  async pull(slot: string, passphrase: string): Promise<SyncPullResult> {
    const auth = useAuthStore();
    const sync = makeSyncService(auth);
    const blob = await sync.pull(slot);
    if (blob === null) return { kind: 'absent' };
    const plaintext = await decryptEnvelope(blob.data, passphrase);
    if (slot === 'main') this.accountHosts = parseSyncPayload(plaintext);
    return { kind: 'ok', version: blob.version, plaintext };
  }

  /** Encrypt at the last moment and push on [baseVersion]; a 409 is a typed
   * result, not a throw, because the caller branches on it. */
  async push(
    slot: string,
    plaintext: string,
    passphrase: string,
    baseVersion: number,
  ): Promise<SyncPushResult> {
    const auth = useAuthStore();
    const sync = makeSyncService(auth);
    try {
      const envelope = await encryptToEnvelope(plaintext, passphrase);
      const { version } = await sync.push(slot, envelope, baseVersion);
      if (slot === 'main') this.accountHosts = parseSyncPayload(plaintext);
      return { kind: 'ok', version };
    } catch (err) {
      if (err instanceof SyncConflictError) {
        return { kind: 'conflict', currentVersion: err.currentVersion };
      }
      if (err instanceof NotSignedInError || err instanceof SyncApiError || err instanceof SyncCryptoError) {
        return { kind: 'error', message: err.message };
      }
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The session cache the host picker reads — null until this session has
   * decrypted the account copy once (the desktop's contract verbatim). */
  async accountHostsList(): Promise<HostEntry[] | null> {
    return this.accountHosts;
  }

  /**
   * The write-back: the synced set offered to this browser's host list. The
   * hosts store IS the config here — upsert rides its conflict-rebasing
   * writer, and `added` names the aliases this list did not have before.
   */
  async applyHosts(hosts: HostEntry[]): Promise<SyncApplyResult> {
    const store = useHostsStore();
    const known = new Set(store.hosts.map((h) => h.name));
    const added = hosts.filter((h) => !known.has(h.name)).map((h) => h.name);
    await store.importHosts(hosts);
    return { added };
  }
}
