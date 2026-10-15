import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Review item 6: the site must only ever build against a REVIEWED core. CI
// and the deploy check out @pocketshell/core at one explicit commit, and the
// scheduled core watcher only reports drift — a core push alone never
// reaches users. Bumping the pin is a PR to this repo.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The `ref:` of the pocketshell-core checkout step in a workflow. */
function corePin(workflow: string): string | null {
  const yml = read(`.github/workflows/${workflow}`);
  const at = yml.indexOf('repository: PocketShell-io/pocketshell-core');
  if (at === -1) return null;
  // The step runs until the next `- ` list item (the next step).
  const rest = yml.slice(at);
  const end = rest.search(/\n\s+- /);
  const step = end === -1 ? rest : rest.slice(0, end);
  return /\n\s+ref: ([0-9a-f]+)\s*(?:\n|$)/.exec(step)?.[1] ?? null;
}

describe('core is pinned to a reviewed commit', () => {
  it('test and deploy check out the same full core SHA', () => {
    const test = corePin('test.yml');
    const deploy = corePin('deploy.yml');
    expect(test).toMatch(/^[0-9a-f]{40}$/);
    expect(deploy).toBe(test);
  });

  it('the scheduled core watcher never dispatches a deploy', () => {
    const yml = read('.github/workflows/sync-core.yml');
    expect(yml).not.toMatch(/gh workflow run/);
    expect(yml).not.toMatch(/actions: write/);
  });
});
