import { defineStore } from 'pinia';
import { claimsOf } from '../auth/google';

/** Signed-in Google identity. The ID token lives in sessionStorage — it
 * expires hourly by design and the signature is checked on every API hop. */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    idToken: sessionStorage.getItem('ps.idToken') ?? '',
    email: sessionStorage.getItem('ps.email') ?? '',
  }),
  getters: {
    signedIn: (s) => s.idToken !== '',
  },
  actions: {
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
