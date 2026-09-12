import { describe, expect, it } from 'vitest';
import { normalizeHostDraft, upsertHost } from '../src/hostForm';
import type { HostEntry } from '../src/shared/types';

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

describe('normalizeHostDraft (the web creates entries the desktop can write back)', () => {
  it('builds a full entry with defaults for the fields the form does not ask', () => {
    const out = normalizeHostDraft({ name: ' box ', hostname: 'example.com', port: '', user: ' alexey ' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entry).toEqual({
      name: 'box',
      hostname: 'example.com',
      port: 22,
      user: 'alexey',
      identityFile: null,
      proxyJump: null,
      forwardAgent: false,
      localForwards: [],
      remoteForwards: [],
      fromConfig: false,
    });
  });

  it('keeps the desktop-owned fields of the entry it edits', () => {
    const base = { ...host('box'), identityFile: '~/.ssh/id_ed25519', forwardAgent: true };
    const out = normalizeHostDraft({ name: 'box', hostname: 'moved.example.com', port: '2222', user: 'alexey' }, base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entry.port).toBe(2222);
    expect(out.entry.hostname).toBe('moved.example.com');
    expect(out.entry.identityFile).toBe('~/.ssh/id_ed25519');
    expect(out.entry.forwardAgent).toBe(true);
    expect(out.entry.fromConfig).toBe(true);
  });

  it('rejects what the desktop config write-back would reject', () => {
    expect(normalizeHostDraft({ name: '', hostname: 'x.example.com', port: '', user: '' }).ok).toBe(false);
    expect(normalizeHostDraft({ name: 'two words', hostname: 'x.example.com', port: '', user: '' }).ok).toBe(false);
    expect(normalizeHostDraft({ name: 'a', hostname: '', port: '', user: '' }).ok).toBe(false);
    expect(normalizeHostDraft({ name: 'a', hostname: 'two words', port: '', user: '' }).ok).toBe(false);
    expect(normalizeHostDraft({ name: 'a', hostname: 'x.example.com', port: '', user: 'two words' }).ok).toBe(false);
    expect(normalizeHostDraft({ name: 'a', hostname: 'x.example.com', port: '0', user: '' }).ok).toBe(false);
    expect(normalizeHostDraft({ name: 'a', hostname: 'x.example.com', port: '99999', user: '' }).ok).toBe(false);
    expect(normalizeHostDraft({ name: 'a', hostname: 'x.example.com', port: '22.5', user: '' }).ok).toBe(false);
    expect(normalizeHostDraft({ name: 'a', hostname: 'x.example.com', port: 'abc', user: '' }).ok).toBe(false);
  });
});

describe('upsertHost', () => {
  it('appends a name the list lacks and replaces an existing one in place', () => {
    const list = [host('a'), host('b')];
    expect(upsertHost(list, host('c')).map((h) => h.name)).toEqual(['a', 'b', 'c']);
    const edited = host('b', 'moved.example.com');
    const out = upsertHost(list, edited);
    expect(out.map((h) => h.name)).toEqual(['a', 'b']);
    expect(out[1]!.hostname).toBe('moved.example.com');
    // The input list is left untouched.
    expect(list[1]!.hostname).toBe('b.example.com');
  });
});
