import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The app stores SSH credentials encrypted in the browser and, on connect,
// sends them once over the authenticated WebSocket to the bridge, which
// uses them in memory (verified against the aws-infra Lambda source). The
// public copy must keep saying exactly that: these tests fail if an
// absolute "keys never leave your browser" claim sneaks back in. The
// marketing surfaces (landing, blog, FAQ) moved to the pocketshell-site
// repo, which carries the same checks against its own copy.

const USER_FACING = [
  'index.html',
  'src/views/HostsView.vue',
  'README.md',
] as const;

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('public claims match the credential-transfer model', () => {
  it('no surface claims credentials are "never uploaded"', () => {
    for (const file of USER_FACING) {
      expect(read(file).match(/never uploaded/gi) ?? [], file).toEqual([]);
    }
  });

  it('the hosts screen says credentials go to the bridge only on connect', () => {
    expect(read('src/views/HostsView.vue')).toContain('sent to the bridge only when you connect');
  });

  it('the config import pins its precise locality claim (the FILE stays; ticked hosts sync encrypted)', () => {
    const view = read('src/views/HostsView.vue');
    expect(view).toContain('the file itself never leaves it');
    expect(view).toContain('the config file stays in this browser');
    // The passphrase rides the same protection as the key it unlocks.
    expect(view).toContain('stored encrypted alongside it and used only when you connect');
  });

  it('the README security model keeps the verified bridge and logging facts', () => {
    const readme = read('README.md').replace(/\s+/g, ' ');
    expect(readme).toContain('rides the already authenticated WebSocket to the bridge');
    expect(readme).toContain('never logged, never persisted');
    expect(readme).toContain('no access logging configured');
  });
});
