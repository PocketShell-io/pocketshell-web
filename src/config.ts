/** Runtime config from /config.js, loaded before this bundle. The sync API
 * URL defaults to the desktop app's constant (src/shared/syncConfig.ts) so
 * the two clients move together; /config.js overrides for this deployment. */
import { SYNC_API_URL } from './shared/syncConfig';

export interface AppConfig {
  syncApiUrl: string;
  googleClientId: string;
  wsUrl: string;
}

declare global {
  interface Window {
    POCKETSHELL_WEB?: Partial<AppConfig>;
  }
}

const raw = window.POCKETSHELL_WEB ?? {};

export const config: AppConfig = {
  syncApiUrl: raw.syncApiUrl ?? SYNC_API_URL,
  googleClientId: raw.googleClientId ?? '',
  wsUrl: raw.wsUrl ?? '',
};

export function isConfigured(): boolean {
  return config.syncApiUrl !== '' && config.googleClientId !== '';
}
