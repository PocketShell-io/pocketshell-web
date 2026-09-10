/**
 * Google sign-in via GIS (accounts.google.com/gsi/client). The browser gets
 * the same artifact the desktop app holds after its loopback flow: a Google
 * ID token whose `aud` is our OAuth client ID — the web needs its own
 * "Web application" client with this origin registered; the desktop
 * credential is a different client type and cannot issue browser tokens.
 */
import { config } from '../config';

export interface GoogleIdClaims {
  sub: string;
  email: string;
  exp: number;
}

interface GsiIdApi {
  initialize(opts: { client_id: string; callback: (r: { credential: string }) => void }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
  prompt(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GsiIdApi } };
  }
}

/** Decode the JWT payload locally — signature/audience/expiry are enforced
 * server-side by the API Gateway authorizer and the bridge; this is UI only. */
export function claimsOf(idToken: string): GoogleIdClaims {
  const payload = idToken.split('.')[1];
  const json = decodeURIComponent(
    atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
      .split('')
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join(''),
  );
  const claims = JSON.parse(json) as GoogleIdClaims;
  return claims;
}

export async function renderLoginButton(
  el: HTMLElement,
  onIdToken: (idToken: string) => void,
): Promise<boolean> {
  if (!config.googleClientId) return false;
  for (let waited = 0; !window.google?.accounts?.id && waited < 5000; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const gsi = window.google?.accounts?.id;
  if (!gsi) throw new Error('Google sign-in script failed to load');
  gsi.initialize({
    client_id: config.googleClientId,
    callback: (r) => onIdToken(r.credential),
  });
  gsi.renderButton(el, { theme: 'filled_black', size: 'large', text: 'signin_with' });
  return true;
}
