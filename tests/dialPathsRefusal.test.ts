/**
 * web#4 round 2: the dial paths OTHER than connectHost go through the same
 * refusal (src/platform/dialGate.ts, core's unsupportedTransport) before any
 * credential is read:
 *
 *  1. the /app warnings sweep (and its acks) over the Lambda bridge — it runs
 *     automatically on unlock, and used to send gateway hosts' keys and a link
 *     host's relay token (as an SSH password) to their display hostnames;
 *  2. the /fwd/<host>:<port>/ forwarder's direct-WebSocket HostChannel.
 *
 * Real code under test: the warnings store, aplexer/warnings' BridgeSession,
 * the forwarder and its HostChannel. The Lambda bridge and the direct relay
 * are local WebSocket servers that record every connection and every frame.
 * Only the hosts/auth stores, the runtime config and the service-worker
 * plumbing are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { WebSocketServer, type WebSocket } from 'ws';
import { utils as sshUtils } from 'ssh2';
import { transportRefusalMessage, type TransportRefusalReason } from '@pocketshell/core';

type Secret = { privateKeyPem?: string; password?: string };
const { cfg, store } = vi.hoisted(() => ({
  cfg: { wsUrl: '', directWsUrl: '' },
  store: {
    hosts: [] as Record<string, unknown>[],
    secrets: {} as Record<string, Secret>,
    secretReads: [] as string[],
  },
}));
vi.mock('../src/config', () => ({
  config: new Proxy({}, { get: (_t, k: string) => (cfg as Record<string, string>)[k] ?? '' }),
}));
vi.mock('../src/stores/hosts', () => ({
  useHostsStore: () => ({
    get hosts() {
      return store.hosts;
    },
    get secrets() {
      store.secretReads.push('<secrets map>');
      return store.secrets;
    },
    get secretHosts() {
      return Object.keys(store.secrets);
    },
    unlocked: true,
    getHostSecret: async (n: string) => {
      store.secretReads.push(n);
      return store.secrets[n];
    },
  }),
}));
vi.mock('../src/stores/auth', () => ({
  useAuthStore: () => ({ idToken: 'id-token', signedIn: true, getIdToken: () => 'id-token' }),
}));

const RELAY_TOKEN = 'RELAY-TOKEN-SECRET';
const VALID_GATEWAY = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'dev-123' };
const VALID_LINK = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };

/** Every marked shape, its host name, and the reason core refuses it with. */
const MARKED: Array<[string, Record<string, unknown>, TransportRefusalReason]> = [
  ['gw-valid', { gateway: VALID_GATEWAY }, 'gateway-unsupported'],
  ['gw-null', { gateway: null }, 'gateway-unsupported'],
  ['gw-malformed', { gateway: 'wss://surprise' }, 'gateway-unsupported'],
  ['lk-gw', { link: VALID_LINK, gateway: VALID_GATEWAY }, 'gateway-unsupported'],
  ['lk', { link: VALID_LINK }, 'link-unsupported'],
  ['lk-null', { link: null }, 'link-unsupported'],
];

let pem = '';
let bridge: WebSocketServer;
let direct: WebSocketServer;
const bridgeFrames: string[] = [];
let bridgeDials = 0;
const directQueries: string[] = [];

function server(onConn: (ws: WebSocket, url: string) => void): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => resolve(wss));
    wss.on('connection', (ws, req) => onConn(ws, req.url ?? ''));
  });
}

beforeAll(async () => {
  pem = sshUtils.generateKeyPairSync('ed25519').private;
  bridge = await server((ws) => {
    bridgeDials++;
    ws.on('message', (m) => {
      bridgeFrames.push(String(m));
      ws.close();
    });
  });
  direct = await server((ws, url) => {
    directQueries.push(url);
    ws.close();
  });
  cfg.wsUrl = `ws://127.0.0.1:${(bridge.address() as { port: number }).port}/`;
  cfg.directWsUrl = `ws://127.0.0.1:${(direct.address() as { port: number }).port}/`;
});

afterAll(() => {
  bridge.close();
  direct.close();
});

beforeEach(() => {
  setActivePinia(createPinia());
  bridgeFrames.length = 0;
  bridgeDials = 0;
  directQueries.length = 0;
  store.secretReads.length = 0;
});

function host(name: string, markers: Record<string, unknown>): Record<string, unknown> {
  return { name, hostname: `${name}.example`, port: 22, user: 'me', ...markers };
}

/** A marked host's credential: link hosts hold the relay token, others a key. */
function secretFor(markers: Record<string, unknown>): Secret {
  return Object.prototype.hasOwnProperty.call(markers, 'link') ? { password: RELAY_TOKEN } : { privateKeyPem: pem };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe('web#4: the /app warnings sweep never dials a transport-marked host', () => {
  it('sweeps every credentialed host, but only the unmarked one reaches the bridge', async () => {
    store.hosts = [...MARKED.map(([name, markers]) => host(name, markers)), host('plain', {})];
    store.secrets = Object.fromEntries([
      ...MARKED.map(([name, markers]) => [name, secretFor(markers)] as const),
      ['plain', { privateKeyPem: pem }],
    ]);
    const { useWarningsStore } = await import('../src/stores/warnings');
    await Promise.race([useWarningsStore().sweep(), settle(4000)]);
    await settle();
    // Exactly one bridge connection: the unmarked control.
    expect(bridgeDials).toBe(1);
    expect(bridgeFrames).toHaveLength(1);
    expect(JSON.parse(bridgeFrames[0]!)).toMatchObject({ type: 'connect', host: 'plain.example' });
    // No marked host's credential was even read, let alone sent.
    expect(store.secretReads).toEqual(['plain']);
    expect(bridgeFrames.join('\n')).not.toContain(RELAY_TOKEN);
  });

  it.each(MARKED)('%s: linkFor (sweep and acks) refuses before reading the secret', async (name, markers) => {
    store.hosts = [host(name, markers)];
    store.secrets = { [name]: secretFor(markers) };
    const { useWarningsStore } = await import('../src/stores/warnings');
    const warnings = useWarningsStore();
    expect(await warnings.linkFor(name)).toBeNull();
    await warnings.ackAll(name);
    await warnings.ack(name, 'session-1');
    await settle();
    expect(bridgeDials).toBe(0);
    expect(store.secretReads).toEqual([]);
  });
});

describe('web#4: /fwd/<host>:<port>/ never dials a transport-marked host', () => {
  let port1: MessagePort | null = null;
  let nextId = 1;

  beforeAll(async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: async () => undefined,
        addEventListener: () => {},
        controller: {
          postMessage: (_m: unknown, ports: MessagePort[]) => {
            port1 = ports[0]!;
          },
        },
      },
    });
    const { startForwarder } = await import('../src/forward/forwarder');
    startForwarder();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    port1?.close();
  });

  async function fetchForward(hostName: string): Promise<{ status: number; body: string }> {
    expect(port1).not.toBeNull();
    const id = nextId++;
    const reply = new Promise<{ status: number; body: string }>((resolve) => {
      port1!.onmessage = (e: MessageEvent) => {
        const data = e.data as { id: number; status: number; body: Uint8Array | null };
        if (data.id !== id) return;
        resolve({ status: data.status, body: data.body === null ? '' : new TextDecoder().decode(data.body) });
      };
    });
    port1!.postMessage({ id, method: 'GET', url: `https://web.pocketshell.io/fwd/${hostName}:8080/`, headers: [], body: null });
    return Promise.race([reply, settle(5000).then(() => ({ status: -1, body: 'timeout' }))]);
  }

  it.each(MARKED)('%s: refused with core\'s text, zero direct-WS dials, no secret read', async (name, markers, reason) => {
    store.hosts = [host(name, markers)];
    store.secrets = { [name]: secretFor(markers) };
    const res = await fetchForward(name);
    await settle();
    expect(directQueries).toEqual([]);
    expect(store.secretReads).toEqual([]);
    expect(res.status).toBe(503);
    expect(res.body).toContain(transportRefusalMessage(reason, name));
  });

  it('control: an unmarked keyed host DOES dial the direct relay', async () => {
    store.hosts = [host('plain', {})];
    store.secrets = { plain: { privateKeyPem: pem } };
    await fetchForward('plain');
    await settle();
    expect(directQueries).toHaveLength(1);
    expect(directQueries[0]).toContain('host=plain.example');
  });
});
