import { describe, expect, it } from 'vitest';
import { assembleSyncSet, parseSyncPayload } from '@pocketshell/core';
import type { HostEntry } from '@pocketshell/core';

// A subset of the desktop repo's tests/unit/syncMerge.test.ts, running
// against the VENDORED copy — the web app must read the account blob with
// exactly the desktop's rules.

function host(name: string, hostname = `${name}.example.com`, port = 22): HostEntry {
  return {
    name,
    hostname,
    port,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
  };
}

describe('parseSyncPayload (the web reads what the desktop wrote)', () => {
  it('parses the payload shape the desktop serializes', () => {
    expect(parseSyncPayload(JSON.stringify({ hosts: [host('a'), host('b')] })).map((h) => h.name)).toEqual(['a', 'b']);
  });

  it('degrades to an EMPTY list for a non-payload blob, not an error', () => {
    expect(parseSyncPayload('not json')).toEqual([]);
    expect(parseSyncPayload(JSON.stringify({ something: [] }))).toEqual([]);
    expect(parseSyncPayload(JSON.stringify({ hosts: 'nope' }))).toEqual([]);
  });

  it('drops entries without a name or hostname, keeps the rest', () => {
    const out = parseSyncPayload(
      JSON.stringify({ hosts: [{ name: 'ok', hostname: 'ok.example.com' }, { name: 'broken' }, null] }),
    );
    expect(out.map((h) => h.name)).toEqual(['ok']);
  });
});

describe('assembleSyncSet (shared merge rules)', () => {
  it('sends only the ticked aliases', () => {
    const out = assembleSyncSet([host('a'), host('b'), host('c')], [], ['b']);
    expect(out.map((h) => h.name)).toEqual(['b']);
  });

  it('prefers the LOCAL entry when both sides have a ticked alias', () => {
    const out = assembleSyncSet([host('a', 'local.example.com', 22)], [host('a', 'remote.example.com', 2222)], ['a']);
    expect(out[0]!.hostname).toBe('local.example.com');
    expect(out[0]!.port).toBe(22);
  });

  it('honours the ticked order and tolerates duplicates', () => {
    const out = assembleSyncSet([host('a'), host('b')], [], ['b', 'a', 'b']);
    expect(out.map((h) => h.name)).toEqual(['b', 'a']);
  });
});
