import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The app stores SSH credentials encrypted in the browser and, on connect,
// sends them once over the authenticated WebSocket to the bridge, which
// uses them in memory (verified against the aws-infra Lambda source). The
// public copy must keep saying exactly that: these tests fail if an
// absolute "keys never leave your browser" claim sneaks back in, or if a
// key-safety surface stops disclosing the bridge hop.

const USER_FACING = [
  'index.html',
  'src/views/LandingView.vue',
  'src/views/HostsView.vue',
  'README.md',
] as const;

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The JSON-LD FAQPage in index.html, parsed so a broken script block fails loudly. */
function jsonLdFaq(): { mainEntity: { name: string; acceptedAnswer: { text: string } }[] } {
  const html = read('index.html');
  const start = html.indexOf('<script type="application/ld+json">');
  const end = html.indexOf('</script>', start);
  return JSON.parse(html.slice(start + '<script type="application/ld+json">'.length, end));
}

describe('public claims match the credential-transfer model', () => {
  it('no surface claims credentials are "never uploaded"', () => {
    for (const file of USER_FACING) {
      expect(read(file).match(/never uploaded/gi) ?? [], file).toEqual([]);
    }
  });

  it('the JSON-LD key answer discloses the bridge hop and in-memory use', () => {
    const faq = jsonLdFaq();
    const key = faq.mainEntity.find((q) => q.name === 'Is my SSH private key safe?');
    expect(key, 'key-safety question missing from JSON-LD').toBeDefined();
    expect(key!.acceptedAnswer.text).toContain('PocketShell bridge');
    expect(key!.acceptedAnswer.text).toContain('in memory');
    expect(key!.acceptedAnswer.text).toContain('never sync');
  });

  it('the visible landing FAQ discloses the bridge hop too', () => {
    const landing = read('src/views/LandingView.vue');
    expect(landing).toContain('PocketShell bridge');
    expect(landing.match(/neither\s+stores nor logs it/)).not.toBeNull();
  });

  it('the hosts screen says credentials go to the bridge only on connect', () => {
    expect(read('src/views/HostsView.vue')).toContain('sent to the bridge only when you connect');
  });

  it('the README security model keeps the verified bridge and logging facts', () => {
    const readme = read('README.md').replace(/\s+/g, ' ');
    expect(readme).toContain('rides the already authenticated WebSocket to the bridge');
    expect(readme).toContain('never logged, never persisted');
    expect(readme).toContain('no access logging configured');
  });
});
