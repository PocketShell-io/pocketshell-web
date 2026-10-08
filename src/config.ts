/** Runtime config from /config.js, loaded before this bundle. The sync API
 * URL defaults to the desktop app's constant (src/shared/syncConfig.ts) so
 * the two clients move together; /config.js overrides for this deployment. */
import { GATEWAY_DEFAULT_SERVER_URL, SYNC_API_URL } from '@pocketshell/core';

export interface AppConfig {
  syncApiUrl: string;
  googleClientId: string;
  wsUrl: string;
  /** Browser-direct relay (wss://...). Empty = use the Lambda bridge.
   * LEGACY: no shipping dialer uses this any more — browser-direct SSH
   * rides the versioned scoped proxy below. Kept so a deployment's legacy
   * posture stays readable (the warnings sweep's custody rule ties to it). */
  directWsUrl: string;
  /**
   * The versioned scoped direct-proxy endpoint (a bare wss:// origin, the
   * public gateway) — the deployment's ADVERTISED capability for
   * browser-direct SSH. Ordinary sessions, single-tab sessions and /fwd/
   * forwarding dial `{scopedProxyUrl}/proxy/v1/ssh?host=…&port=…` and admit
   * with a broker-minted scoped token in the FIRST text frame; the sign-in
   * never rides the URL, a header, or any frame. Empty = this deployment
   * offers no scoped direct proxy: every direct-transport dial refuses with
   * the fixed update-required sentence — there is NO fallback to the legacy
   * unversioned query-token relay or the Lambda bridge.
   */
  scopedProxyUrl: string;
  /** The PocketShell gateway a "via gateway" host dials by default. */
  gatewayServerUrl: string;
  /** Development ONLY: allow ws:// gateway and scoped-direct-proxy URLs
   * (a local/docker gateway or proxy). Never set this in production — it
   * admits unencrypted transport dials. */
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
  scopedProxyUrl: raw.scopedProxyUrl ?? '',
};

export function isConfigured(): boolean {
  return config.syncApiUrl !== '' && config.googleClientId !== '';
}
