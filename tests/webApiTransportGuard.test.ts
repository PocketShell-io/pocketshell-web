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
  const linkGarbage = entry('link-garbage', { link: 'wss://garbage.example' as never });
  hosts.hosts = [gatewayNull, gatewayUndefined, gatewayGarbage, conflicting, ordinary, gatewayOk, linkOk, linkGarbage];
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

describe('malformedSavedLinkRefusesBeforeSecretBrokerSocket — link shapes get the gateway guard too', () => {
  it('a saved link that fails the shared guard refuses — never a direct-dial fallback', async () => {
    const h = seed();
    for (const link of ['wss://garbage.example', 1, { relayUrl: 'wss://link-relay.example' }]) {
      const hosts = useHostsStore();
      const victim = hosts.hosts.find((x) => x.name === 'link-garbage')!;
      (victim as Record<string, unknown>)['link'] = link;
      const result = await webApi.ssh.connect({ host: 'link-garbage.example', user: 'u' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/unreadable link target/);
      expectNothingMoved(h);
    }
  });

  it('a payload link marker that is unreadable or DISAGREES with the saved target refuses', async () => {
    const h = seed();
    for (const link of [null, undefined, 1, { relayUrl: 'wss://other-relay.example', hostId: 'host-1' }]) {
      const payload: Record<string, unknown> = { host: 'link-ok.example', user: 'u', link };
      const result = await webApi.ssh.connect(payload as Parameters<typeof webApi.ssh.connect>[0]);
      expect(result.ok).toBe(false);
      expectNothingMoved(h);
    }
  });

  it('a payload link target that AGREES with the saved one still dials the link transport', async () => {
    seed();
    const payload = { host: 'link-ok.example', user: 'u', link: { ...LINK_TARGET } };
    const result = await webApi.ssh.connect(payload as Parameters<typeof webApi.ssh.connect>[0]);
    expect(result.ok).toBe(true);
    expect(vi.mocked(LinkSshConnection.prototype.connect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SshConnection.prototype.connect)).not.toHaveBeenCalled();
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

// --- selected-host resolution ------------------------------------------------
//
// The original defect: endpoint-first resolution picked the FIRST record
// matching hostname+port, so two named accounts sharing one SSH endpoint made
// a dial for B read A's secret and inherit A's user/transport (the old e2e
// hid it by moving the keyless record to another port). The rules now:
//
//   a) a SUPPLIED selected-host identity (own-property `selectedHost`, the
//      selected record's `hostEntryId`) is authoritative — it must resolve
//      uniquely and agree with the requested hostname, effective port, and
//      nonempty user; unknown, duplicate, malformed or disagreeing refuse
//      before any secret read. It is never the privateKeyPath: that stays a
//      real identity-file path (the desktop reads it with readFileSync).
//   b) unnamed callers (today's shared UI, whose payload is derived FROM the
//      selected record) resolve against hostname + effective port + nonempty
//      user + identity-file agreement, and ONLY a single compatible record
//      connects — zero or several refuse.

const SHARED_HOST = 'shared.example';
const SHARED_PORT = 2202;
const KEY_A = '-----BEGIN OPENSSH PRIVATE KEY-----a-key-body';
const KEY_B = '-----BEGIN OPENSSH PRIVATE KEY-----b-key-body';

/** Two (or more) named records on ONE endpoint — the collision shape. */
function seedShared(
  records: Array<Pick<HostEntry, 'name' | 'user' | 'identityFile'> & { secret?: HostSecret | null; link?: unknown; gateway?: unknown }>,
): Harness {
  const hosts = useHostsStore();
  hosts.pulled = true;
  hosts.passphrase = 'sync-pass';
  const entries = records.map((r) => {
    const e = entry(r.name, {
      hostname: SHARED_HOST,
      port: SHARED_PORT,
      user: r.user,
      ...(r.identityFile !== undefined ? { identityFile: r.identityFile } : {}),
      ...(r.link !== undefined ? { link: r.link as never } : {}),
      ...(r.gateway !== undefined ? { gateway: r.gateway as never } : {}),
    });
    return e;
  });
  hosts.hosts = entries;
  const secrets: Record<string, HostSecret> = {};
  for (const r of records) {
    if (r.secret !== null) secrets[r.name] = r.secret ?? { privateKeyPem: KEY_A, password: 'relay-token' };
  }
  // Give each record a distinguishable key so a borrow is OBSERVABLE.
  records.forEach((r, i) => {
    if (secrets[r.name]?.privateKeyPem === KEY_A) {
      secrets[r.name] = { ...secrets[r.name], privateKeyPem: `-----BEGIN OPENSSH PRIVATE KEY-----key-${r.name}` };
    }
    void i;
  });
  hosts.secrets = secrets;
  hosts.secretHosts = Object.keys(secrets);
  const getSecret = vi.spyOn(hosts, 'getHostSecret').mockClear();
  vi.spyOn(SshConnection.prototype, 'connect').mockResolvedValue().mockClear();
  vi.spyOn(LinkSshConnection.prototype, 'connect').mockResolvedValue().mockClear();
  return { getSecret };
}

function connectPayload(extra: Record<string, unknown> = {}): Parameters<typeof webApi.ssh.connect>[0] {
  return { host: SHARED_HOST, port: SHARED_PORT, user: 'u', ...extra } as Parameters<
    typeof webApi.ssh.connect
  >[0];
}

describe('sameEndpointKeylessSelectionDoesNotBorrowSiblingKey', () => {
  it('a keyless sibling on a shared endpoint is refused on its OWN record — never served the first record’s key', async () => {
    // Sync order matters: A (with key) first — exactly what the old
    // endpoint-first find picked for B's dial. B carries its own identity-file
    // marker, so the unnamed rules still select B (and only B).
    const h = seedShared([
      { name: 'shared-a', user: 'u', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----a-only' } },
      { name: 'shared-b', user: 'u', identityFile: '~/.ssh/shared_b', secret: null }, // keyless
    ]);
    const result = await webApi.ssh.connect(connectPayload({ privateKeyPath: '~/.ssh/shared_b' })); // B's payload
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No key attached/);
    // The ONE secret read was B's own (the keyless check) — A's key never moved,
    // nothing was minted, nothing dialed.
    expect(h.getSecret).toHaveBeenCalledTimes(1);
    expect(h.getSecret).toHaveBeenCalledWith('shared-b');
    expect(mintCalls).toEqual([]);
    expect(vi.mocked(SshConnection.prototype.connect)).not.toHaveBeenCalled();
    expect(vi.mocked(LinkSshConnection.prototype.connect)).not.toHaveBeenCalled();
  });

  it('two same-endpoint records with different keys: the request’s identityFile picks the right secret', async () => {
    const h = seedShared([
      { name: 'manualbox', user: 'u', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----manual-only' } },
      { name: 'dockertest', user: 'u', identityFile: '~/.ssh/key_enc', secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----dock-only' } },
    ]);
    const result = await webApi.ssh.connect(
      connectPayload({ user: 'u', privateKeyPath: '~/.ssh/key_enc' }), // dockertest's payload
    );
    expect(result.ok).toBe(true);
    expect(h.getSecret).toHaveBeenCalledTimes(1);
    expect(h.getSecret).toHaveBeenCalledWith('dockertest');
    const dial = vi.mocked(SshConnection.prototype.connect).mock.calls.at(-1)![0];
    expect(dial.auth).toMatchObject({ kind: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----dock-only' });
  });
});

describe('selectedDifferentUsersSecretsTransportOnOneEndpointCorrectSelectedOnly', () => {
  it('the requested user (and its transport marker) selects the record; a user with no record refuses', async () => {
    const h = seedShared([
      { name: 'alicebox', user: 'alice', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----alice-only' } },
      {
        name: 'bobbox',
        user: 'bob',
        identityFile: null,
        secret: { password: 'bob-relay-token' },
        link: LINK_TARGET,
      },
    ]);
    // Bob's dial (link payload agreeing with bob's saved target): bob's token, no alice secret.
    const bob = await webApi.ssh.connect(connectPayload({ user: 'bob', link: { ...LINK_TARGET } }));
    expect(bob.ok).toBe(true);
    expect(h.getSecret).toHaveBeenCalledTimes(1);
    expect(h.getSecret).toHaveBeenLastCalledWith('bobbox');
    expect(vi.mocked(LinkSshConnection.prototype.connect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SshConnection.prototype.connect)).not.toHaveBeenCalled();

    // Alice's dial: direct, alice's key only.
    const hosts = useHostsStore();
    h.getSecret.mockClear();
    vi.mocked(LinkSshConnection.prototype.connect).mockClear();
    const alice = await webApi.ssh.connect(connectPayload({ user: 'alice' }));
    expect(alice.ok).toBe(true);
    expect(h.getSecret).toHaveBeenCalledTimes(1);
    expect(h.getSecret).toHaveBeenLastCalledWith('alicebox');
    const dial = vi.mocked(SshConnection.prototype.connect).mock.calls.at(-1)![0];
    expect(dial.auth).toMatchObject({ privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----alice-only' });
    expect(dial.user).toBe('alice');
    void hosts;

    // A requested user with no record on that endpoint refuses before secrets.
    h.getSecret.mockClear();
    vi.mocked(SshConnection.prototype.connect).mockClear();
    const carol = await webApi.ssh.connect(connectPayload({ user: 'carol' }));
    expect(carol.ok).toBe(false);
    expect(h.getSecret).not.toHaveBeenCalled();
    expect(vi.mocked(SshConnection.prototype.connect)).not.toHaveBeenCalled();
  });

  it('a transport marker that disagrees with the user-selected record refuses before secrets', async () => {
    const h = seedShared([
      { name: 'alicebox', user: 'alice', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----alice-only' } },
      {
        name: 'bobbox',
        user: 'bob',
        identityFile: null,
        secret: { password: 'bob-relay-token' },
        link: LINK_TARGET,
      },
    ]);
    // Bob's endpoint/user, but a link target that is not bobbox's saved one.
    const result = await webApi.ssh.connect(
      connectPayload({
        user: 'bob',
        link: { relayUrl: 'wss://other-relay.example', hostId: 'host-OTHER' } as never,
      }),
    );
    expect(result.ok).toBe(false);
    expectNothingMoved(h);
  });
});

describe('suppliedSelectedHostIdentityIsAuthoritative', () => {
  it('selectedHostNameMismatchRefusesBeforeSecrets — unknown name', async () => {
    const h = seed();
    const result = await webApi.ssh.connect({
      host: 'plain.example',
      user: 'u',
      selectedHost: 'no-such-host',
    } as Parameters<typeof webApi.ssh.connect>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no-such-host/);
    expectNothingMoved(h);
  });

  it('a duplicated selected name refuses — an ambiguous identity is no identity', async () => {
    const h = seedShared([
      { name: 'twin', user: 'u', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----twin-1' } },
      { name: 'twin', user: 'u', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----twin-2' } },
    ]);
    const result = await webApi.ssh.connect(connectPayload({ selectedHost: 'twin' }) as Parameters<typeof webApi.ssh.connect>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/twin/);
    expectNothingMoved(h);
  });

  it('a resolved name that disagrees with the requested hostname, port or user refuses', async () => {
    const h = seedShared([{ name: 'realbox', user: 'realuser', identityFile: null }]);
    for (const payload of [
      connectPayload({ host: 'other.example', selectedHost: 'realbox' }), // hostname tampered
      connectPayload({ port: SHARED_PORT + 1, selectedHost: 'realbox' }), // port tampered
      connectPayload({ user: 'someoneelse', selectedHost: 'realbox' }), // user tampered
      connectPayload({ selectedHost: '' }), // malformed identity
      connectPayload({ selectedHost: 42 }), // malformed identity
    ]) {
      const result = await webApi.ssh.connect(payload as Parameters<typeof webApi.ssh.connect>[0]);
      expect(result.ok).toBe(false);
    }
    expectNothingMoved(h);
  });

  it('an agreeing name dials THAT record with THAT record’s secret only', async () => {
    const h = seedShared([
      { name: 'abox', user: 'u', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----a-only' } },
      { name: 'bbox', user: 'u', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----b-only' } },
    ]);
    const result = await webApi.ssh.connect(
      connectPayload({ user: 'u', selectedHost: 'bbox' }) as Parameters<typeof webApi.ssh.connect>[0],
    );
    expect(result.ok).toBe(true);
    expect(h.getSecret).toHaveBeenCalledTimes(1);
    expect(h.getSecret).toHaveBeenLastCalledWith('bbox');
    const dial = vi.mocked(SshConnection.prototype.connect).mock.calls.at(-1)![0];
    expect(dial.auth).toMatchObject({ privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----b-only' });
  });

  it('a named link selection whose marker agrees dials the link transport', async () => {
    const h = seedShared([
      { name: 'plainbox', user: 'u', identityFile: null },
      { name: 'linkbox', user: 'u', identityFile: null, link: LINK_TARGET, secret: { password: 'linkbox-token' } },
    ]);
    const result = await webApi.ssh.connect(
      connectPayload({ user: 'u', selectedHost: 'linkbox', link: { ...LINK_TARGET } }) as Parameters<
        typeof webApi.ssh.connect
      >[0],
    );
    expect(result.ok).toBe(true);
    expect(vi.mocked(LinkSshConnection.prototype.connect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SshConnection.prototype.connect)).not.toHaveBeenCalled();
    expect(h.getSecret).toHaveBeenLastCalledWith('linkbox');
  });
});

describe('unnamedUnnamedUniqueLegalCallerStillConnects', () => {
  it('unnamedUniqueLegacyCallerStillConnects — including empty-user default semantics', async () => {
    const h = seedShared([{ name: 'solo', user: 'solouser', identityFile: null }]);
    const named = await webApi.ssh.connect(connectPayload({ user: 'solouser' }));
    expect(named.ok).toBe(true);
    expect(h.getSecret).toHaveBeenLastCalledWith('solo');
    // The empty requested user stays legal against an otherwise unique record.
    h.getSecret.mockClear();
    vi.mocked(SshConnection.prototype.connect).mockClear();
    const emptyUser = await webApi.ssh.connect(connectPayload({ user: '' }));
    expect(emptyUser.ok).toBe(true);
    expect(h.getSecret).toHaveBeenCalledTimes(1);
    const dial = vi.mocked(SshConnection.prototype.connect).mock.calls.at(-1)![0];
    expect(dial.user).toBe('solouser'); // the record's own user dials
  });

  it('unnamedAmbiguousCallerRefusesBeforeSecrets — indistinguishable records refuse the dial', async () => {
    const h = seedShared([
      { name: 'twin-a', user: 'u', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----twin-a' } },
      { name: 'twin-b', user: 'u', identityFile: null, secret: { privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----twin-b' } },
    ]);
    const result = await webApi.ssh.connect(connectPayload());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/share|several|ambiguous/i);
    expectNothingMoved(h);
  });

  it('an unnamed request whose identityFile matches nothing on the endpoint refuses', async () => {
    const h = seedShared([{ name: 'solo', user: 'u', identityFile: '~/.ssh/real_key' }]);
    const result = await webApi.ssh.connect(connectPayload({ privateKeyPath: '~/.ssh/other_key' }));
    expect(result.ok).toBe(false);
    expectNothingMoved(h);
  });
});
