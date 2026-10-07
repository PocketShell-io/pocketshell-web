import { describe, expect, it } from 'vitest';
import { normalizeHostDraft, upsertHost } from '../src/hostForm';
import type { HostEntry } from '@pocketshell/core';

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

describe('normalizeHostDraft: the gateway fields', () => {
  const GATEWAY = 'wss://gateway.pocketshell.io';

  it('a device id with no URL makes the host a gateway host on the canonical gateway', () => {
    const out = normalizeHostDraft({
      name: 'home',
      hostname: 'home.example.com',
      port: '',
      user: 'alexey',
      gatewayDeviceId: ' home-laptop ',
      gatewayUrl: '',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entry.gateway).toEqual({ serverUrl: GATEWAY, deviceId: 'home-laptop' });
  });

  it('an explicit gateway URL is normalized (https:// spelling included)', () => {
    const out = normalizeHostDraft({
      name: 'home',
      hostname: 'home.example.com',
      port: '',
      user: '',
      gatewayDeviceId: 'dev-01',
      gatewayUrl: 'https://gw.selfhosted.example',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entry.gateway).toEqual({ serverUrl: 'wss://gw.selfhosted.example', deviceId: 'dev-01' });
  });

  it('a broken gateway URL or device id names its field', () => {
    const badUrl = normalizeHostDraft({
      name: 'home',
      hostname: 'h',
      port: '',
      user: '',
      gatewayDeviceId: 'dev-01',
      gatewayUrl: 'wss://gw.selfhosted.example/api/v1/hosts/x/ssh?token=leak',
    });
    expect(badUrl).toMatchObject({ ok: false, field: 'gatewayUrl' });
    const badId = normalizeHostDraft({
      name: 'home',
      hostname: 'h',
      port: '',
      user: '',
      gatewayDeviceId: 'bad id',
      gatewayUrl: '',
    });
    expect(badId).toMatchObject({ ok: false, field: 'gatewayDeviceId' });
  });

  it('editing a gateway host to an empty device id removes gateway mode entirely', () => {
    const base = host('home');
    base.gateway = { serverUrl: GATEWAY, deviceId: 'dev-01' };
    const out = normalizeHostDraft(
      { name: 'home', hostname: 'home.example.com', port: '', user: '', gatewayDeviceId: '', gatewayUrl: '' },
      base,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect('gateway' in out.entry).toBe(false);
  });

  it('a gateway host survives the sync payload round-trip with its target intact', () => {
    const out = normalizeHostDraft({
      name: 'home',
      hostname: 'home.example.com',
      port: '22',
      user: 'alexey',
      gatewayDeviceId: 'dev-01',
      gatewayUrl: '',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [parsed] = upsertHost([], out.entry);
    expect(parsed!.gateway).toEqual({ serverUrl: GATEWAY, deviceId: 'dev-01' });
  });
});
