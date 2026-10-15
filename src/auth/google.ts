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
  /** Issued-at; the vault reset's freshness check falls back to it. */
  iat?: number;
  /** When the user last actively authenticated, when Google includes it. */
  auth_time?: number;
}

/** Options for `google.accounts.id.initialize`, exported for tests. */
export interface GsiInitOptions {
  client_id: string;
  callback: (r: { credential: string }) => void;
  ux_mode: 'popup';
  use_fedcm_for_button: boolean;
  use_fedcm_for_prompt: boolean;
  itp_support: boolean;
}

interface GsiIdApi {
  initialize(opts: GsiInitOptions): void;
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

/**
 * GIS options. FedCM matters most on phones. Without it the button opens
 * Google's web sign-in page, and a fresh web sign-in ends with Google's own
 * cookie hop to accounts.google.<the account's country TLD>/accounts/SetSID.
 * For some countries that host no longer exists (accounts.google.ru is
 * NXDOMAIN), so the user is stranded on a DNS error after signing in.
 * FedCM uses the browser's native account chooser instead (the device's Google
 * accounts on Android Chrome), with no web sign-in page and no ccTLD hop.
 * Browsers without FedCM fall back to the classic popup. Every URL we load is
 * accounts.google.com; the ccTLD host only ever comes from Google's redirect.
 */
export function gsiInitOptions(clientId: string, onIdToken: (idToken: string) => void): GsiInitOptions {
  return {
    client_id: clientId,
    callback: (r) => onIdToken(r.credential),
    ux_mode: 'popup',
    use_fedcm_for_button: true,
    use_fedcm_for_prompt: true,
    itp_support: true,
  };
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
  gsi.initialize(gsiInitOptions(config.googleClientId, onIdToken));
  // GIS draws the personalized button ("Continue as <name> <email>") at its
  // natural content width — up to 400px — when renderButton gets no width,
  // which overflows the auth card's slot. Pass the slot container's measured
  // width, clamped to the GIS-documented 200–400 bounds (400 when layout is
  // not measurable yet).
  const measured = (el.parentElement ?? el).clientWidth || el.clientWidth || 400;
  const width = Math.min(400, Math.max(200, measured));
  gsi.renderButton(el, { theme: 'filled_black', size: 'large', text: 'signin_with', width });
  return true;
}
