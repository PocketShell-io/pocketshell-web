import { describe, expect, it } from 'vitest';
import { gsiInitOptions } from '../src/auth/google';

describe('Google sign-in (GIS) options', () => {
  it('uses FedCM for the button and the prompt, so phones never go through the web sign-in ccTLD hop', () => {
    const opts = gsiInitOptions('client-id', () => {});
    expect(opts).toMatchObject({
      client_id: 'client-id',
      ux_mode: 'popup',
      use_fedcm_for_button: true,
      use_fedcm_for_prompt: true,
    });
  });

  it('hands the ID token to the caller', () => {
    let got = '';
    gsiInitOptions('c', (t) => (got = t)).callback({ credential: 'tok' });
    expect(got).toBe('tok');
  });

  it('the page only ever loads Google from accounts.google.com', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const hosts = [...html.matchAll(/https:\/\/([a-z0-9.-]*google[a-z0-9.-]*)/gi)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toBe('accounts.google.com');
  });
});
