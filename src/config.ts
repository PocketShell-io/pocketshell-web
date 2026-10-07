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
}

declare global {
  interface Window {
    POCKETSHELL_WEB?: Partial<AppConfig>;
  }
}

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
};

export function isConfigured(): boolean {
  return config.syncApiUrl !== '' && config.googleClientId !== '';
}
