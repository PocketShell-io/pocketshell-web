import { defineStore } from 'pinia';
import { claimsOf } from '../auth/google';
import { NotSignedInError } from '../api/sync';

/** Signed-in Google identity. The ID token lives in sessionStorage — it
 * expires hourly by design and the signature is checked on every API hop.
 * Implements the TokenSource shape SyncService expects (the browser twin of
 * the desktop's GoogleAuth): a browser cannot refresh silently — GIS mints
 * tokens on user gesture — so forceRefresh just reports the expired
 * session and the UI routes through the login screen again. */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    idToken: sessionStorage.getItem('ps.idToken') ?? '',
    email: sessionStorage.getItem('ps.email') ?? '',
  }),
  getters: {
    signedIn: (s) => s.idToken !== '',
  },
  actions: {
    getIdToken(forceRefresh = false): string {
      if (this.idToken === '' || forceRefresh) {
        throw new NotSignedInError('session expired — sign in again');
      }
      return this.idToken;
    },
    signIn(idToken: string) {
      this.idToken = idToken;
      this.email = claimsOf(idToken).email;
      sessionStorage.setItem('ps.idToken', idToken);
      sessionStorage.setItem('ps.email', this.email);
    },
    signOut() {
      this.idToken = '';
      this.email = '';
      sessionStorage.clear();
    },
  },
});
