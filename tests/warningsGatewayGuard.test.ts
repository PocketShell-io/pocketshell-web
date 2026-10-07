import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { HostEntry } from '@pocketshell/core';

/**
 * The gateway credential-custody guard on the warnings sweep (Astra review).
 *
 * The warnings store's ONLY transport is the LEGACY Lambda bridge, which
 * receives a host's SSH key inside its `connect` frame. A gateway host's key
 * exists for end-to-end authentication through the gateway and must NEVER be
 * handed to that bridge — no matter which URLs are configured, and no matter
 * whether the sweep runs from unlock, auto-recall, in-session navigation, or
 * an ack click. This regression pins exactly that, with BOTH the legacy
 * bridge URL and the direct-relay URL set, over the store every automatic
 * path funnels into (HostsView mount → fresh unlock → auto-recall all call
 * `warnings.sweep()`; acks go through `ackWith` → `linkFor`).
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
const NORMAL_PASSWORD = 'normal-host-password';

function entry(name: string, gateway?: HostEntry['gateway']): HostEntry {
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
    ...(gateway ? { gateway } : {}),
  };
}

const GATEWAY_TARGET = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'dev-01' };

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  // BOTH URLs configured — the guard must not depend on which one exists.
  config.wsUrl = 'wss://legacy-bridge.example';
  config.directWsUrl = 'wss://direct-relay.example';
  const auth = useAuthStore();
  auth.idToken = 'sweep-token';
});

/** Seed the hosts store as an unlocked session with two credentialed hosts. */
function seedHosts(): void {
  const hosts = useHostsStore();
  hosts.pulled = true;
  hosts.passphrase = 'sync-pass';
  hosts.hosts = [entry('gateway-box', GATEWAY_TARGET), entry('plain-box')];
  const secrets: Record<string, HostSecret> = {
    'gateway-box': { privateKeyPem: GATEWAY_KEY },
    'plain-box': { password: NORMAL_PASSWORD },
  };
  hosts.secrets = secrets;
  hosts.secretHosts = Object.keys(secrets);
}

describe('the warnings sweep never uploads gateway host keys to the bridge', () => {
  it('linkFor refuses a gateway host BEFORE the secret is even loaded', async () => {
    seedHosts();
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    const link = await warnings.linkFor('gateway-box');
    expect(link).toBeNull();
    expect(getSecret).not.toHaveBeenCalledWith('gateway-box');
  });

  it('a sweep with BOTH urls set opens bridge sessions for the plain host only', async () => {
    seedHosts();
    const open = vi.spyOn(BridgeSession.prototype, 'open').mockRejectedValue(new Error('lab: no bridge'));
    try {
      const warnings = useWarningsStore();
      await warnings.sweep();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it('the gateway key is never handed to any BridgeSession — sweep and ack alike', async () => {
    seedHosts();
    const openedFor: string[] = [];
    const open = vi.spyOn(BridgeSession.prototype, 'open').mockImplementation(async function (this: BridgeSession) {
      openedFor.push((this as unknown as { url: string }).url);
      throw new Error('lab: no bridge');
    });
    try {
      const warnings = useWarningsStore();
      await warnings.sweep();
      await warnings.ack('gateway-box', 'some-session');
      // Every bridge session went to the legacy bridge only (never some
      // gateway endpoint), and exactly once — the plain host's sweep.
      expect(openedFor).toEqual([config.wsUrl]);
      expect(open).toHaveBeenCalledTimes(1);
      // Nothing in the warnings map pretends the gateway host answered.
      expect(warnings.byHost['gateway-box']).toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it('a plain host still sweeps — the guard does not over-block', async () => {
    seedHosts();
    const open = vi.spyOn(BridgeSession.prototype, 'open').mockRejectedValue(new Error('lab: no bridge'));
    try {
      const warnings = useWarningsStore();
      // The plain host's link is built with ITS OWN secret, never the key.
      const link = await warnings.linkFor('plain-box');
      expect(link).not.toBeNull();
      expect(link!.auth).toEqual({ kind: 'password', password: NORMAL_PASSWORD });
      await warnings.sweep();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it('auto-recall semantics: an unlocked host list sweeps safely without any manual step', async () => {
    // The unlock/auto-recall flows (HostsView mount, silent vault unlock)
    // all land on sweep() with the same store state this test seeds —
    // there is no separate background transport.
    seedHosts();
    const warnings = useWarningsStore();
    const hosts = useHostsStore();
    const getSecret = vi.spyOn(hosts, 'getHostSecret');
    const open = vi.spyOn(BridgeSession.prototype, 'open').mockRejectedValue(new Error('lab: no bridge'));
    try {
      await warnings.sweep();
      expect(getSecret).not.toHaveBeenCalledWith('gateway-box');
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it('a host that becomes a gateway host loses its stale bridge warnings', async () => {
    seedHosts();
    const warnings = useWarningsStore();
    warnings.byHost['gateway-box'] = [{ session: 'old', kind: 'oom', workspace: 'w', tag: 't', detail: 'd', created_at_ms: 1 }];
    await warnings.sweep();
    expect(warnings.byHost['gateway-box']).toBeUndefined();
  });
});
