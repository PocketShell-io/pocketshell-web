import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { HostEntry } from '@pocketshell/core';

/**
 * The warnings-sweep credential-custody guard (Astra review, round two).
 *
 * The warnings store's ONLY transport is the LEGACY Lambda bridge, which
 * receives a host's SSH key inside its `connect` frame. That frame may carry
 * a key ONLY for a host whose actual dial transport is that bridge:
 *
 *  - gateway hosts: NEVER (their key authenticates end-to-end through the
 *    gateway and must not reach other infrastructure);
 *  - plain hosts while a direct relay is configured (`config.directWsUrl`
 *    non-empty): NEVER — those hosts dial end-to-end from the browser;
 *  - plain hosts on a deployment with NO direct relay (`directWsUrl === ''`):
 *    the legacy deployment keeps its historical sweep — the configuration
 *    itself is the explicit choice of the Lambda transport;
 *  - link hosts: unchanged (their bridge-frame secret is the shared link
 *    token, not a private key).
 *
 * Every exclusion fires BEFORE the secret is decrypted, across sweep, ack,
 * unlock-recall and navigation refresh — all of which funnel through this
 * store's `sweep()`/`linkFor`. There is no fallback: a sweep miss stays a
 * miss, and nothing here dials the gateway.
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
    throw new Error('sync is not used by the warnings guard test');
  },
}));

import { BridgeSession } from '../src/terminal/bridge';
import { config } from '../src/config';
import { useAuthStore } from '../src/stores/auth';
import { useHostsStore } from '../src/stores/hosts';
import { useWarningsStore } from '../src/stores/warnings';
import type { HostSecret } from '../src/stores/hosts';

const GATEWAY_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----b3BlbnNzaC1rZXktdjEAAAAA-GATEWAY-KEY';
const PLAIN_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----cGxhaW4taG9zdC1rZXk-BASE64BODY';
const NORMAL_PASSWORD = 'normal-host-password';

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

const GATEWAY_TARGET = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'dev-01' };

interface Seed {
  gateway: HostEntry;
  plain: HostEntry;
  link: HostEntry;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  // BOTH URLs configured — the default scenario under review. (The scoped
  // direct proxy defaults to unconfigured; tests that deploy one set it
  // explicitly.)
  config.wsUrl = 'wss://legacy-bridge.example';
  config.directWsUrl = 'wss://direct-relay.example';
  config.scopedProxyUrl = '';
  const auth = useAuthStore();
  auth.idToken = 'sweep-token';
});

/** Seed an unlocked session: a gateway host (key), a plain direct host
 * (key), and a link host (relay token as its password). */
function seedHosts(): Seed {
  const hosts = useHostsStore();
  hosts.pulled = true;
  hosts.passphrase = 'sync-pass';
  const gateway = entry('gateway-box', { gateway: GATEWAY_TARGET });
  const plain = entry('plain-box');
  const link = entry('link-box', { link: { relayUrl: 'wss://link-relay.example', hostId: 'host-1' } as never });
  hosts.hosts = [gateway, plain, link];
  const secrets: Record<string, HostSecret> = {
    'gateway-box': { privateKeyPem: GATEWAY_KEY },
    'plain-box': { privateKeyPem: PLAIN_KEY },
    'link-box': { password: NORMAL_PASSWORD },
  };
  hosts.secrets = secrets;
  hosts.secretHosts = Object.keys(secrets);
  return { gateway, plain, link };
}

/** Track every bridge session by its URL and the auth kind it would carry —
 * the custody question is exactly "which SECRET reached the bridge". */
function spyBridgeOpens(): { opens: { url: string; authKind: string | null }[]; open: ReturnType<typeof vi.spyOn> } {
  const opens: { url: string; authKind: string | null }[] = [];
  const open = vi.spyOn(BridgeSession.prototype, 'open').mockImplementation(async function (
    this: BridgeSession,
    opts: { auth?: { kind?: string } },
  ) {
    opens.push({ url: (this as unknown as { url: string }).url, authKind: opts?.auth?.kind ?? null });
    throw new Error('lab: no bridge');
  });
  return { opens, open };
}

describe('the warnings sweep never uploads custody-protected keys to the bridge', () => {
  it('linkFor refuses a gateway host BEFORE the secret is even loaded', async () => {
    seedHosts();
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    expect(await warnings.linkFor('gateway-box')).toBeNull();
    expect(getSecret).not.toHaveBeenCalledWith('gateway-box');
  });

  it('with BOTH urls set, no KEY reaches the bridge — only the link token sweeps', async () => {
    seedHosts();
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    const { opens, open } = spyBridgeOpens();
    try {
      await warnings.sweep();
      // The one bridge session is the LINK host's relay token — no private
      // key frame exists, and no key-carrying secret was even decrypted.
      expect(opens).toEqual([{ url: config.wsUrl, authKind: 'password' }]);
      expect(getSecret).not.toHaveBeenCalledWith('gateway-box');
      expect(getSecret).not.toHaveBeenCalledWith('plain-box');
      expect(warnings.byHost['gateway-box']).toBeUndefined();
      expect(warnings.byHost['plain-box']).toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it('plain hosts still sweep on a deployment with no direct relay — the legacy bridge is their transport there', async () => {
    seedHosts();
    config.directWsUrl = '';
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    const { opens, open } = spyBridgeOpens();
    try {
      const link = await warnings.linkFor('plain-box');
      expect(link).not.toBeNull();
      expect(link!.auth).toEqual({ kind: 'key', privateKey: PLAIN_KEY });
      await warnings.sweep();
      // The plain host's KEY frame rode the legacy bridge; the gateway host
      // was never touched.
      expect(opens).toContainEqual({ url: config.wsUrl, authKind: 'key' });
      expect(getSecret).not.toHaveBeenCalledWith('gateway-box');
    } finally {
      open.mockRestore();
    }
  });

  it('the gateway key is never handed to any BridgeSession — sweep and ack alike', async () => {
    seedHosts();
    const { opens, open } = spyBridgeOpens();
    try {
      const warnings = useWarningsStore();
      await warnings.sweep();
      await warnings.ack('gateway-box', 'some-session');
      // Legacy deployment too: every bridge open rides the legacy URL, and
      // no open carries a gateway host's key (there is no gateway host open).
      config.directWsUrl = '';
      await warnings.sweep();
      for (const o of opens) expect(o.url).toBe(config.wsUrl);
      expect(warnings.byHost['gateway-box']).toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it('a sweep failure produces no fallback dial anywhere — a miss stays a miss', async () => {
    seedHosts();
    config.directWsUrl = '';
    const warnings = useWarningsStore();
    const { open } = spyBridgeOpens();
    try {
      await warnings.sweep();
      // The plain host's bridge run failed: no retry, no gateway, no other
      // transport — the host simply stays out of the map.
      expect(warnings.byHost['plain-box']).toBeUndefined();
      expect(warnings.sweeping).toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  it('link hosts keep their historical bridge sweep (their secret is the link token)', async () => {
    seedHosts();
    const warnings = useWarningsStore();
    const link = await warnings.linkFor('link-box');
    expect(link).not.toBeNull();
    expect(link!.auth).toEqual({ kind: 'password', password: NORMAL_PASSWORD });
  });

  it('a host that becomes custody-excluded loses its stale bridge warnings', async () => {
    seedHosts();
    const warnings = useWarningsStore();
    warnings.byHost['gateway-box'] = [{ session: 'old', kind: 'oom', workspace: 'w', tag: 't', detail: 'd', created_at_ms: 1 }];
    warnings.byHost['plain-box'] = [{ session: 'old2', kind: 'crash', workspace: 'w', tag: 't', detail: 'd', created_at_ms: 2 }];
    await warnings.sweep();
    // Gateway host: gone. Plain host while a direct relay is configured: gone.
    expect(warnings.byHost['gateway-box']).toBeUndefined();
    expect(warnings.byHost['plain-box']).toBeUndefined();
  });

  it('unlock/auto-recall semantics: an unlocked host list sweeps safely without any manual step', async () => {
    seedHosts();
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    const { opens, open } = spyBridgeOpens();
    try {
      await warnings.sweep();
      expect(getSecret).not.toHaveBeenCalledWith('gateway-box');
      expect(getSecret).not.toHaveBeenCalledWith('plain-box');
      // Only the link token ever moved.
      expect(opens.every((o) => o.authKind === 'password')).toBe(true);
    } finally {
      open.mockRestore();
    }
  });
});

describe('linkHostBridgesOnlyItsRelayToken — never the stale SSH key on the record', () => {
  /** A link host whose credential record still carries BOTH secrets: the
   * shared relay token (password slot — the transport's real secret) and a
   * stale SSH private key from its pre-link life. */
  function seedStaleKeyLinkHost(secret: HostSecret): void {
    const hosts = useHostsStore();
    hosts.pulled = true;
    hosts.passphrase = 'sync-pass';
    const link = entry('link-box', { link: { relayUrl: 'wss://link-relay.example', hostId: 'host-1' } as never });
    hosts.hosts = [link];
    hosts.secrets = { 'link-box': secret };
    hosts.secretHosts = Object.keys(hosts.secrets);
  }

  it('linkHostWithStalePrivateKeyBridgesExactlyTheToken — both secrets present, only the token moves', async () => {
    seedStaleKeyLinkHost({ privateKeyPem: PLAIN_KEY, password: NORMAL_PASSWORD });
    const warnings = useWarningsStore();
    const { opens, open } = spyBridgeOpens();
    try {
      const link = await warnings.linkFor('link-box');
      expect(link).not.toBeNull();
      // EXACTLY the relay token — the key never appears in any shape.
      expect(link!.auth).toEqual({ kind: 'password', password: NORMAL_PASSWORD });
      await warnings.sweep();
      expect(opens).toEqual([{ url: config.wsUrl, authKind: 'password' }]);
      // Every actual warning action runs the same policy: ack and ack-all
      // bridge the token, never the key.
      warnings.byHost['link-box'] = [{ session: 's1', kind: 'oom', workspace: 'w', tag: 't', detail: 'd', created_at_ms: 1 }];
      await warnings.ack('link-box', 's1');
      await warnings.ackAll('link-box');
      expect(opens.every((o) => o.authKind === 'password' && o.url === config.wsUrl)).toBe(true);
    } finally {
      open.mockRestore();
    }
  });

  it('linkHostWithoutTokenNeverBridgesItsKey — key alone is nothing to connect with', async () => {
    seedStaleKeyLinkHost({ privateKeyPem: PLAIN_KEY });
    const warnings = useWarningsStore();
    const { opens, open } = spyBridgeOpens();
    try {
      // No token → no runner link at all: no key fallback, no upload.
      expect(await warnings.linkFor('link-box')).toBeNull();
      await warnings.sweep();
      await warnings.ack('link-box', 'some-session');
      await warnings.ackAll('link-box');
      expect(opens).toEqual([]);
      expect(warnings.byHost['link-box']).toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it('the legacy plain-host contract is untouched — key-or-password as ever', async () => {
    const hosts = useHostsStore();
    hosts.pulled = true;
    hosts.passphrase = 'sync-pass';
    hosts.hosts = [entry('plain-box')];
    hosts.secrets = { 'plain-box': { privateKeyPem: PLAIN_KEY, password: NORMAL_PASSWORD } };
    hosts.secretHosts = Object.keys(hosts.secrets);
    config.directWsUrl = ''; // the legacy deployment chose the bridge
    config.scopedProxyUrl = ''; // and it has no scoped direct proxy either
    const warnings = useWarningsStore();
    const link = await warnings.linkFor('plain-box');
    // bridgeAuthOf's historical priority (key over password) preserved for
    // the transport that actually authenticates with it.
    expect(link!.auth).toEqual({ kind: 'key', privateKey: PLAIN_KEY });
  });

  it('a plain host on a SCOPED deployment never bridges — the scoped proxy replaced the direct relay', async () => {
    const hosts = useHostsStore();
    hosts.pulled = true;
    hosts.passphrase = 'sync-pass';
    hosts.hosts = [entry('plain-box')];
    hosts.secrets = { 'plain-box': { privateKeyPem: PLAIN_KEY, password: NORMAL_PASSWORD } };
    hosts.secretHosts = Object.keys(hosts.secrets);
    // The deployment the migration produces: the scoped direct proxy is the
    // one browser-direct transport; the legacy direct relay is gone. The
    // plain host's dial goes through the scoped proxy — its key must stay
    // out of the bridge exactly as direct-relay hosts' keys always did.
    config.directWsUrl = '';
    config.scopedProxyUrl = 'wss://scoped-proxy.example';
    const warnings = useWarningsStore();
    const { opens, open } = spyBridgeOpens();
    try {
      const link = await warnings.linkFor('plain-box');
      expect(link).toBeNull();
      await warnings.sweep();
      expect(opens).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });
});

describe('nullLinkDirectHostNeverUploadsCredentials — the sweep matches the DIAL, not the shape', () => {
  /** Extra host shapes the presence rules exist for: a materialized
   * `link: null` (the dial ignores it and goes DIRECT), a malformed gateway
   * marker (null), and a conflicting entry (link AND gateway). */
  function seedPresence(): void {
    const hosts = useHostsStore();
    hosts.pulled = true;
    hosts.passphrase = 'sync-pass';
    const nullLink = entry('null-link');
    (nullLink as Record<string, unknown>)['link'] = null;
    const malformedGateway = entry('gw-malformed', { gateway: null as never });
    const undefinedGateway = entry('gw-undefined');
    (undefinedGateway as Record<string, unknown>)['gateway'] = undefined;
    const conflicting = entry('conflicted', {
      link: { relayUrl: 'wss://link-relay.example', hostId: 'host-1' } as never,
      gateway: GATEWAY_TARGET,
    });
    hosts.hosts = [nullLink, malformedGateway, undefinedGateway, conflicting];
    const secrets: Record<string, HostSecret> = {
      'null-link': { privateKeyPem: PLAIN_KEY },
      'gw-malformed': { privateKeyPem: GATEWAY_KEY },
      'gw-undefined': { privateKeyPem: GATEWAY_KEY },
      conflicted: { privateKeyPem: GATEWAY_KEY },
    };
    hosts.secrets = secrets;
    hosts.secretHosts = Object.keys(secrets);
  }

  it('a host whose link is null dials DIRECT — the bridge never receives its key or password', async () => {
    seedPresence();
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    const { opens, open } = spyBridgeOpens();
    try {
      expect(await warnings.linkFor('null-link')).toBeNull();
      expect(getSecret).not.toHaveBeenCalledWith('null-link');
      await warnings.sweep();
      // With BOTH urls configured the null-link host must not appear at the
      // bridge at all — no key frame, no password frame, nothing.
      expect(opens).toEqual([]);
      expect(getSecret).not.toHaveBeenCalledWith('null-link');
      expect(warnings.byHost['null-link']).toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it('malformed and conflicting gateway markers exclude a host from every bridge path', async () => {
    seedPresence();
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    const { opens, open } = spyBridgeOpens();
    try {
      // Presence, not truthiness: null and undefined-valued markers exclude.
      for (const name of ['gw-malformed', 'gw-undefined', 'conflicted']) {
        expect(await warnings.linkFor(name)).toBeNull();
      }
      await warnings.sweep();
      await warnings.ack('gw-malformed', 'some-session');
      await warnings.ackAll('conflicted');
      for (const name of ['gw-malformed', 'gw-undefined', 'conflicted']) {
        expect(getSecret).not.toHaveBeenCalledWith(name);
        expect(warnings.byHost[name]).toBeUndefined();
      }
      expect(opens).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });

  it('on a legacy deployment (no direct relay) the null-link host keeps the historical sweep', async () => {
    seedPresence();
    config.directWsUrl = '';
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    const { opens, open } = spyBridgeOpens();
    try {
      const link = await warnings.linkFor('null-link');
      expect(link).not.toBeNull();
      expect(link!.auth).toEqual({ kind: 'key', privateKey: PLAIN_KEY });
      await warnings.sweep();
      // The malformed/conflicting gateway shapes stay excluded even here;
      // only the null-link (direct-transported) host sweeps.
      expect(opens).toEqual([{ url: config.wsUrl, authKind: 'key' }]);
      expect(getSecret).not.toHaveBeenCalledWith('gw-malformed');
      expect(getSecret).not.toHaveBeenCalledWith('gw-undefined');
      expect(getSecret).not.toHaveBeenCalledWith('conflicted');
    } finally {
      open.mockRestore();
    }
  });
});
