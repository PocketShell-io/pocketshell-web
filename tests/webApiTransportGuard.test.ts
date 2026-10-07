import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHash } from 'node:crypto';
import { createPinia, setActivePinia } from 'pinia';
import type { HostEntry } from '@pocketshell/core';

/**
 * The dial's transport guard, exercised through the ACTUAL webApi connect
 * path: the transport is decided from the entry's shape plus the raw
 * payload's own markers BEFORE the vault is touched, the broker is asked, or
 * any socket is opened. Every refusal below must show ZERO secret reads,
 * ZERO broker mints, ZERO direct/link connection attempts — the guard is
 * wired, not merely present.
 */

vi.hoisted(() => {
  const memoryStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => void map.clear(),
    };
  };
  const g = globalThis as Record<string, unknown>;
  g['window'] ??= { POCKETSHELL_WEB: {} };
  g['localStorage'] ??= memoryStorage();
  g['sessionStorage'] ??= memoryStorage();
});

vi.mock('../src/api/sync', () => ({
  SyncConflictError: class SyncConflictError extends Error {},
  makeSyncService: () => {
    throw new Error('sync is not used by the transport guard test');
  },
}));

const { mintCalls, GOOGLE_TOKEN, BROKER_TOKEN } = vi.hoisted(() => ({
  mintCalls: [] as unknown[],
  GOOGLE_TOKEN: 'google-signin-sentinel',
  BROKER_TOKEN: 'broker-minted.scoped.jwt',
}));

vi.mock('../src/api/gatewayToken', () => ({
  getGatewayToken: (opts: unknown) => {
    mintCalls.push(opts);
    return Promise.resolve({ token: BROKER_TOKEN, expiresAtMs: Date.now() + 300_000 });
  },
  GatewayTokenError: class GatewayTokenError extends Error {},
}));

import { config } from '../src/config';
import { useAuthStore } from '../src/stores/auth';
import { useHostPinsStore } from '../src/stores/hostPins';
import { useHostsStore } from '../src/stores/hosts';
import type { HostSecret } from '../src/stores/hosts';
import { LinkSshConnection } from '../src/terminal/linkConnection';
import { SshConnection } from '../src/terminal/connection';
import { webApi } from '../src/platform/webApi';

const GATEWAY_TARGET = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'dev-01' };
const LINK_TARGET = { relayUrl: 'wss://link-relay.example', hostId: 'host-1' } as never;
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----Z3VhcmQtdGVzdC1rZXk-BODY';

function entry(name: string, extra: Partial<HostEntry> = {}): HostEntry {
  return {
    name,
    hostname: `${name}.example`,
    port: 22,
    user: 'u',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
    ...extra,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  mintCalls.length = 0;
  config.wsUrl = 'wss://legacy-bridge.example';
  config.directWsUrl = 'wss://direct-relay.example';
  config.syncApiBase = 'https://accounts.example';
  useAuthStore().idToken = GOOGLE_TOKEN;
});

interface Harness {
  getSecret: MockInstance;
}

/** Seed the store with one host per shape (each WITH a secret, so an
 * improper secret read would succeed silently — only the not-called
 * assertions prove the guard) and wire the dial spies. */
function seed(): Harness {
  const hosts = useHostsStore();
  hosts.pulled = true;
  hosts.passphrase = 'sync-pass';
  const gatewayNull = entry('gw-null', { gateway: null as never });
  const gatewayUndefined = entry('gw-undef');
  (gatewayUndefined as Record<string, unknown>)['gateway'] = undefined;
  const gatewayGarbage = entry('gw-garbage', { gateway: 'dev-01' as never });
  const conflicting = entry('conflicted', { link: LINK_TARGET, gateway: GATEWAY_TARGET });
  const ordinary = entry('plain');
  const gatewayOk = entry('gw-ok', { gateway: GATEWAY_TARGET });
  const linkOk = entry('link-ok', { link: LINK_TARGET });
  hosts.hosts = [gatewayNull, gatewayUndefined, gatewayGarbage, conflicting, ordinary, gatewayOk, linkOk];
  const secrets: Record<string, HostSecret> = {};
  for (const h of hosts.hosts) secrets[h.name] = { privateKeyPem: KEY, password: 'relay-token' };
  hosts.secrets = secrets;
  hosts.secretHosts = Object.keys(secrets);
  const getSecret = vi.spyOn(hosts, 'getHostSecret').mockClear();
  vi.spyOn(SshConnection.prototype, 'connect').mockResolvedValue().mockClear();
  vi.spyOn(LinkSshConnection.prototype, 'connect').mockResolvedValue().mockClear();
  return { getSecret };
}

/** The zero-custody assertion every refusal must satisfy. */
function expectNothingMoved(h: Harness): void {
  expect(h.getSecret).not.toHaveBeenCalled();
  expect(mintCalls).toEqual([]);
  expect(vi.mocked(SshConnection.prototype.connect)).not.toHaveBeenCalled();
  expect(vi.mocked(LinkSshConnection.prototype.connect)).not.toHaveBeenCalled();
}

describe('invalidOrConflictingTransportRefusesBeforeSecretBrokerSocket', () => {
  it('a null gateway marker refuses — never a direct-dial fallback', async () => {
    const h = seed();
    const result = await webApi.ssh.connect({ host: 'gw-null.example', user: 'u' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unreadable gateway/);
    expectNothingMoved(h);
  });

  it('an own-property undefined gateway marker refuses — absence is a missing key, not undefined', async () => {
    const h = seed();
    const result = await webApi.ssh.connect({ host: 'gw-undef.example', user: 'u' });
    expect(result.ok).toBe(false);
    expectNothingMoved(h);
  });

  it('a malformed gateway marker refuses — never a direct-dial fallback', async () => {
    const h = seed();
    const result = await webApi.ssh.connect({ host: 'gw-garbage.example', user: 'u' });
    expect(result.ok).toBe(false);
    expectNothingMoved(h);
  });

  it('an entry with BOTH transports refuses before anything runs', async () => {
    const h = seed();
    const result = await webApi.ssh.connect({ host: 'conflicted.example', user: 'u' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/conflicting transport/i);
    expectNothingMoved(h);
  });
});

describe('payloadGatewayIntentNotDropped — the shared payload’s raw markers decide too', () => {
  it('a payload gateway marker on an ordinary matched entry refuses (no direct downgrade)', async () => {
    const h = seed();
    for (const gateway of [null, undefined, { ...GATEWAY_TARGET }]) {
      const payload: Record<string, unknown> = { host: 'plain.example', user: 'u', gateway };
      const result = await webApi.ssh.connect(payload as Parameters<typeof webApi.ssh.connect>[0]);
      expect(result.ok).toBe(false);
    }
    expectNothingMoved(h);
  });

  it('a payload gateway marker that disagrees with the saved target refuses', async () => {
    const h = seed();
    const payload = {
      host: 'gw-ok.example',
      user: 'u',
      gateway: { serverUrl: GATEWAY_TARGET.serverUrl, deviceId: 'dev-OTHER' },
    };
    const result = await webApi.ssh.connect(payload as Parameters<typeof webApi.ssh.connect>[0]);
    expect(result.ok).toBe(false);
    expectNothingMoved(h);
  });

  it('a payload link marker on a gateway entry refuses the transport disagreement', async () => {
    const h = seed();
    const payload = { host: 'gw-ok.example', user: 'u', link: { whatever: 1 } };
    const result = await webApi.ssh.connect(payload as Parameters<typeof webApi.ssh.connect>[0]);
    expect(result.ok).toBe(false);
    expectNothingMoved(h);
  });
});

describe('positive controls — valid intents still dial their own transport', () => {
  it('a valid gateway entry mints the broker token and dials with ONLY that token', async () => {
    seed();
    const pin = useHostPinsStore();
    await pin.setGatewayPin(
      GATEWAY_TARGET.deviceId,
      `SHA256:${createHash('sha256').update('lab-pairing').digest('base64').replace(/=+$/, '')}`,
    );
    const result = await webApi.ssh.connect({ host: 'gw-ok.example', user: 'u' });
    expect(result.ok).toBe(true);
    expect(mintCalls).toHaveLength(1);
    // The dial's idToken is the BROKER token — the Google sign-in never rides it.
    const dial = vi.mocked(SshConnection.prototype.connect).mock.calls.at(-1)![0];
    expect(dial.idToken).toBe(BROKER_TOKEN);
    expect(dial.idToken).not.toBe(GOOGLE_TOKEN);
    expect(dial.gateway?.deviceId).toBe(GATEWAY_TARGET.deviceId);
  });

  it('a link entry dials the link transport with the relay token', async () => {
    seed();
    const result = await webApi.ssh.connect({ host: 'link-ok.example', user: 'u' });
    expect(result.ok).toBe(true);
    expect(vi.mocked(LinkSshConnection.prototype.connect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SshConnection.prototype.connect)).not.toHaveBeenCalled();
  });

  it('an ordinary entry still dials direct — unchanged control', async () => {
    seed();
    const result = await webApi.ssh.connect({ host: 'plain.example', user: 'u' });
    expect(result.ok).toBe(true);
    const dial = vi.mocked(SshConnection.prototype.connect).mock.calls.at(-1)![0];
    expect(dial.url).toBe(config.directWsUrl);
    expect(dial.gateway).toBeUndefined();
    expect(vi.mocked(LinkSshConnection.prototype.connect)).not.toHaveBeenCalled();
  });
});
