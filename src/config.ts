/** Runtime config from /config.js, loaded before this bundle. */
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
  syncApiUrl: raw.syncApiUrl ?? '',
  googleClientId: raw.googleClientId ?? '',
  wsUrl: raw.wsUrl ?? '',
};

export function isConfigured(): boolean {
  return config.syncApiUrl !== '' && config.googleClientId !== '';
}
