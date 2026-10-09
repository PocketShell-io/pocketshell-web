/**
 * web#4: a gateway-marked synced host must never be dialled — not as plain
 * SSH through the direct WebSocket bridge, and (with `link` beside it) not
 * over the link transport either.
 *
 * End to end on the real path: the shared connection store (core
 * packages/ui) dials a synced host through the REAL webApi, whose
 * connectHost builds the REAL SshConnection / LinkSshConnection. Both the
 * direct bridge (`config.directWsUrl`) and the link relay are local
 * WebSocket servers, so any dial is observable as an accepted socket. Only
 * the hosts/auth/pins stores and the runtime config are stubbed.
 *
 * Controls prove the servers are live: an unmarked host DOES reach the
 * bridge and a valid link host DOES reach the relay, so "0 sockets" for the
 * marked shapes is a refusal, not a dead fixture.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { WebSocketServer } from 'ws';
import { utils as sshUtils } from 'ssh2';
import { transportRefusalMessage, type HostEntry } from '@pocketshell/core';

const { cfg, store } = vi.hoisted(() => ({
  cfg: { directWsUrl: '' },
  store: {
    hosts: [] as unknown[],
    secretReads: [] as string[],
    secret: { privateKeyPem: '', password: 'relay-token' } as { privateKeyPem?: string; password?: string },
  },
}));
vi.mock('../src/config', () => ({
  config: new Proxy({}, { get: (_t, k: string) => (k === 'directWsUrl' ? cfg.directWsUrl : undefined) }),
}));
vi.mock('../src/stores/hosts', () => ({
  useHostsStore: () => ({
    get hosts() {
      return store.hosts;
    },
    getHostSecret: async (name: string) => {
      store.secretReads.push(name);
      return store.secret;
    },
  }),
}));
vi.mock('../src/stores/auth', () => ({ useAuthStore: () => ({ idToken: 'id-token' }) }));
vi.mock('../src/stores/hostPins', () => ({ useHostPinsStore: () => ({ lookup: () => null, pin: () => {} }) }));

const { provideApi } = await import('@ui/app/ipc');
const { webApi } = await import('../src/platform/webApi');
const { useConnectionStore } = await import('@ui/app/stores/connection');
provideApi(webApi);

let bridge: WebSocketServer;
let relay: WebSocketServer;
let bridgeDials = 0;
let relayDials = 0;
let relayUrl = '';

function server(onConn: () => void): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => resolve(wss));
    wss.on('connection', (ws) => {
      onConn();
      ws.close();
    });
  });
}

beforeAll(async () => {
  store.secret.privateKeyPem = sshUtils.generateKeyPairSync('ed25519').private;
  bridge = await server(() => bridgeDials++);
  relay = await server(() => relayDials++);
  cfg.directWsUrl = `ws://127.0.0.1:${(bridge.address() as { port: number }).port}/`;
  relayUrl = `ws://127.0.0.1:${(relay.address() as { port: number }).port}`;
});

afterAll(() => {
  bridge.close();
  relay.close();
});

beforeEach(() => {
  setActivePinia(createPinia());
  bridgeDials = 0;
  relayDials = 0;
  store.secretReads.length = 0;
});

function syncedHost(name: string, markers: Record<string, unknown>): HostEntry {
  const entry: Record<string, unknown> = {
    name,
    hostname: 'gw-box.example',
    port: 22,
    user: 'me',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
    ...markers,
  };
  return entry as unknown as HostEntry;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
}

const VALID_GATEWAY = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'dev-123' };
const validLink = () => ({ relayUrl, hostId: 'nat-box' });

const GATEWAY_SHAPES: Array<[string, () => Record<string, unknown>]> = [
  ['valid gateway', () => ({ gateway: VALID_GATEWAY })],
  ['null gateway', () => ({ gateway: null })],
  ['malformed gateway', () => ({ gateway: 'wss://surprise' })],
  ['link + valid gateway', () => ({ link: validLink(), gateway: VALID_GATEWAY })],
  ['link + null gateway', () => ({ link: validLink(), gateway: null })],
];

describe('web#4: connectHost refuses gateway-marked hosts before any dial', () => {
  it.each(GATEWAY_SHAPES)('%s: zero bridge and relay sockets, core refusal shown', async (_l, markers) => {
    const host = syncedHost('gw', markers());
    store.hosts = [host];
    const connection = useConnectionStore();
    const ok = await connection.connect(host);
    await settle();
    expect(ok).toBe(false);
    expect(bridgeDials).toBe(0);
    expect(relayDials).toBe(0);
    expect(store.secretReads).toEqual([]);
    expect(connection.error).toBe(transportRefusalMessage('gateway-unsupported', 'gw'));
  });

  it.each(GATEWAY_SHAPES)(
    '%s on the REQUEST alone: refused even when it resolves to an unmarked synced host',
    async (_l, markers) => {
      // A different, unmarked synced host at the same address: only the
      // request's own marker stands between this tap and a plain-SSH dial.
      store.hosts = [syncedHost('box', {})];
      const connection = useConnectionStore();
      const ok = await connection.connect(syncedHost('gw', markers()));
      await settle();
      expect(ok).toBe(false);
      expect(bridgeDials).toBe(0);
      expect(relayDials).toBe(0);
      expect(store.secretReads).toEqual([]);
      expect(connection.error).toBe(transportRefusalMessage('gateway-unsupported', 'box'));
    },
  );

  it('a stored entry carrying gateway refuses even when the request omits the marker', async () => {
    store.hosts = [syncedHost('gw', { gateway: null })];
    const res = await webApi.ssh.connect({ host: 'gw-box.example', port: 22, user: 'me' });
    await settle();
    expect(res).toEqual({ ok: false, error: transportRefusalMessage('gateway-unsupported', 'gw') });
    expect(bridgeDials + relayDials).toBe(0);
    expect(store.secretReads).toEqual([]);
  });
});

describe('web#4: link markers', () => {
  it('a malformed link marker is refused, not dialled as plain SSH', async () => {
    for (const link of [null, 'wss://relay', { relayUrl: '', hostId: 'x' }]) {
      const host = syncedHost('lk', { link });
      store.hosts = [host];
      const connection = useConnectionStore();
      expect(await connection.connect(host)).toBe(false);
      expect(connection.error).toBe(transportRefusalMessage('link-invalid', 'lk'));
    }
    await settle();
    expect(bridgeDials + relayDials).toBe(0);
    expect(store.secretReads).toEqual([]);
  });

  it('a link request that resolves to an unmarked host at the same address is refused', async () => {
    store.hosts = [syncedHost('box', {})];
    const res = await webApi.ssh.connect({ host: 'gw-box.example', port: 22, user: 'me', link: validLink() });
    await settle();
    expect(res.ok).toBe(false);
    expect(bridgeDials + relayDials).toBe(0);
    expect(store.secretReads).toEqual([]);
  });

  it('control: a valid link host still rides the link transport (one relay socket, no bridge)', async () => {
    const host = syncedHost('lk', { link: validLink() });
    store.hosts = [host];
    await useConnectionStore().connect(host);
    await settle();
    expect(relayDials).toBe(1);
    expect(bridgeDials).toBe(0);
  });
});

describe('web#4: ordinary hosts still dial', () => {
  it('control: an unmarked synced host reaches the direct bridge', async () => {
    const host = syncedHost('box', {});
    store.hosts = [host];
    await useConnectionStore().connect(host);
    await settle();
    expect(store.secretReads).toEqual(['box']);
    expect(bridgeDials).toBe(1);
    expect(relayDials).toBe(0);
  });
});
