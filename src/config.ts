/** Runtime config from /config.js, loaded before this bundle. The sync API
 * URL defaults to the desktop app's constant (src/shared/syncConfig.ts) so
 * the two clients move together; /config.js overrides for this deployment. */
import { GATEWAY_DEFAULT_SERVER_URL, SYNC_API_URL } from '@pocketshell/core';

export interface AppConfig {
  syncApiUrl: string;
  googleClientId: string;
  wsUrl: string;
  /** Browser-direct relay (wss://...). Empty = use the Lambda bridge. */
  directWsUrl: string;
  /** The PocketShell gateway a "via gateway" host dials by default. */
  gatewayServerUrl: string;
  /** Development ONLY: allow ws:// gateway URLs (a local/docker gateway).
   * Never set this in production — it admits unencrypted gateway dials. */
  gatewayAllowInsecureWs: boolean;
  /**
   * The trusted account-service base the browser exchanges the sign-in at
   * for a short-lived gateway credential (`POST {syncApiBase}/gateway/token`).
   * FRONTEND-OWNED trust: the exchange URL comes from here and nowhere else —
   * never from gateway input, the dial target, or a ready frame. Kept
   * independent of `syncApiUrl` so a sync-endpoint override cannot silently
   * move where credentials are minted.
   */
  syncApiBase: string;
}

declare global {
  interface Window {
    POCKETSHELL_WEB?: Partial<AppConfig>;
  }
}

/** The independently trusted account service (the auth broker's host).
 * Frontend-owned; the only source of the gateway-token exchange URL. */
export const TRUSTED_SYNC_API_BASE = 'https://a7sota2qic.execute-api.eu-west-1.amazonaws.com';

// Guarded so node-env unit tests can import modules that reach config
// transitively (the aplexer runner imports the bridge for its types).
const raw = (typeof window === 'undefined' ? undefined : window.POCKETSHELL_WEB) ?? {};

export const config: AppConfig = {
  syncApiUrl: raw.syncApiUrl ?? SYNC_API_URL,
  googleClientId: raw.googleClientId ?? '',
  wsUrl: raw.wsUrl ?? '',
  directWsUrl: raw.directWsUrl ?? '',
  gatewayServerUrl: raw.gatewayServerUrl ?? GATEWAY_DEFAULT_SERVER_URL,
  gatewayAllowInsecureWs: raw.gatewayAllowInsecureWs ?? false,
  syncApiBase: raw.syncApiBase ?? TRUSTED_SYNC_API_BASE,
};

export function isConfigured(): boolean {
  return config.syncApiUrl !== '' && config.googleClientId !== '';
}
