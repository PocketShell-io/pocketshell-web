import { describe, expect, it } from 'vitest';
import type { HostEntry } from '@pocketshell/core';
import { resolveTransportIntent } from '../src/platform/transportIntent';

/**
 * The dial-transport resolver: presence-based marker detection on the entry
 * AND the shared `ssh.connect` payload, refused BEFORE any secret read,
 * broker request, or socket. The rule under test: a PRESENT transport marker
 * can never be demoted to "no marker" by the accident of its value, and a
 * payload's intent must land on an agreeing entry — never fall through to a
 * direct dial through the fuzzy host match.
 */

function entry(extra: Partial<HostEntry> = {}): HostEntry {
  return {
    name: 'box',
    hostname: 'box.example',
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
const LINK_TARGET = { relayUrl: 'wss://link-relay.example', hostId: 'host-1' } as never;

describe('entry gateway markers are presence-based, not truthiness-based', () => {
  it('nullGatewayDoesNotFallback — a null marker refuses instead of dialing direct', () => {
    const intent = resolveTransportIntent({ entry: entry({ gateway: null as never }) });
    expect(intent.kind).toBe('refuse');
  });

  it('invalidGatewayDoesNotFallback — malformed shapes refuse: string, partial, undefined-valued', () => {
    for (const bad of [
      'wss://not-a-target',
      { deviceId: 'dev-01' } as never, // missing serverUrl
      { serverUrl: 'wss://gateway.pocketshell.io' } as never, // missing deviceId
    ]) {
      const intent = resolveTransportIntent({ entry: entry({ gateway: bad }) });
      expect(intent.kind).toBe('refuse');
    }
  });

  it('an own property holding undefined is still a marker — absence is a MISSING key', () => {
    const e = entry();
    (e as Record<string, unknown>)['gateway'] = undefined;
    expect(Object.prototype.hasOwnProperty.call(e, 'gateway')).toBe(true);
    const intent = resolveTransportIntent({ entry: e });
    expect(intent.kind).toBe('refuse');
    // And a genuinely absent key is no marker at all.
    expect(resolveTransportIntent({ entry: entry() }).kind).toBe('none');
  });

  it('a valid gateway target normalizes explicitly and resolves to the gateway transport', () => {
    const intent = resolveTransportIntent({ entry: entry({ gateway: GATEWAY_TARGET }) });
    expect(intent).toEqual({ kind: 'gateway', target: GATEWAY_TARGET });
  });
});

describe('conflicting transports refuse', () => {
  it('conflictingTransportRefused — entry carrying BOTH a link and a gateway target', () => {
    const intent = resolveTransportIntent({
      entry: entry({ link: LINK_TARGET, gateway: GATEWAY_TARGET }),
    });
    expect(intent.kind).toBe('refuse');
    if (intent.kind === 'refuse') expect(intent.reason).toMatch(/conflicting transport/i);
  });

  it('a payload asking for link on a gateway entry refuses the disagreement', () => {
    const intent = resolveTransportIntent({
      entry: entry({ gateway: GATEWAY_TARGET }),
      payload: { link: { whatever: 1 } },
    });
    expect(intent.kind).toBe('refuse');
  });

  it('a payload carrying both transport markers refuses', () => {
    const intent = resolveTransportIntent({
      entry: entry(),
      payload: { gateway: GATEWAY_TARGET, link: { whatever: 1 } },
    });
    expect(intent.kind).toBe('refuse');
  });
});

describe('payload gateway intent is never dropped or downgraded', () => {
  it('payloadGatewayIntentNotDropped — a payload gateway marker on an ORDINARY entry refuses', () => {
    for (const marker of [null, undefined, 'dev-01', GATEWAY_TARGET]) {
      const intent = resolveTransportIntent({ entry: entry(), payload: { gateway: marker } });
      expect(intent.kind).toBe('refuse');
    }
  });

  it('a structured payload target that agrees with the saved one dials the gateway', () => {
    const intent = resolveTransportIntent({
      entry: entry({ gateway: GATEWAY_TARGET }),
      payload: { gateway: { ...GATEWAY_TARGET } },
    });
    expect(intent).toEqual({ kind: 'gateway', target: GATEWAY_TARGET });
  });

  it('a structured payload target that DISAGREES refuses — no fuzzy-match reconciliation', () => {
    for (const other of [
      { serverUrl: GATEWAY_TARGET.serverUrl, deviceId: 'dev-OTHER' },
      { serverUrl: 'wss://gateway.other.example', deviceId: GATEWAY_TARGET.deviceId },
    ]) {
      const intent = resolveTransportIntent({
        entry: entry({ gateway: GATEWAY_TARGET }),
        payload: { gateway: other },
      });
      expect(intent.kind).toBe('refuse');
    }
  });

  it('a present-but-unreadable payload marker (null/undefined/string) refuses even on a valid gateway entry', () => {
    for (const marker of [null, undefined, 'dev-01']) {
      const intent = resolveTransportIntent({
        entry: entry({ gateway: GATEWAY_TARGET }),
        payload: { gateway: marker },
      });
      expect(intent.kind).toBe('refuse');
    }
  });
});

describe('link and direct intents keep their shapes', () => {
  it('a link entry resolves to the link transport', () => {
    expect(resolveTransportIntent({ entry: entry({ link: LINK_TARGET }) }).kind).toBe('link');
  });

  it('a materialized null link is NOT a link host — the dial goes direct', () => {
    expect(resolveTransportIntent({ entry: entry({ link: null as never }) }).kind).toBe('none');
  });

  it('an own link property holding undefined stays the value shape — direct, not a marker', () => {
    const e = entry();
    (e as Record<string, unknown>)['link'] = undefined;
    expect(resolveTransportIntent({ entry: e }).kind).toBe('none');
  });

  it('malformedSavedLinkRefusesNotDials — a truthy garbage link value is a claim that no longer reads', () => {
    for (const bad of [
      'wss://not-a-target',
      1,
      true,
      { relayUrl: 'wss://link-relay.example' } as never, // missing hostId
      { hostId: 'host-1' } as never, // missing relayUrl
      { relayUrl: '   ', hostId: 'host-1' } as never, // blank fields
      { relayUrl: 'wss://link-relay.example', hostId: '  ' } as never,
    ]) {
      const intent = resolveTransportIntent({ entry: entry({ link: bad as never }) });
      expect(intent.kind).toBe('refuse');
      if (intent.kind === 'refuse') expect(intent.reason).toMatch(/unreadable link target/);
    }
  });

  it('payload link intent on an entry without a link target refuses the downgrade', () => {
    expect(
      resolveTransportIntent({ entry: entry(), payload: { link: { whatever: 1 } } }).kind,
    ).toBe('refuse');
    // …including over a null link, where the payload asked and the host is not one.
    expect(
      resolveTransportIntent({ entry: entry({ link: null as never }), payload: { link: 1 } }).kind,
    ).toBe('refuse');
  });

  it('a present-but-unreadable payload link marker refuses even on a valid link entry — never silently dropped', () => {
    for (const marker of [null, undefined, 1, 'wss://x', { relayUrl: 'wss://link-relay.example' } as never]) {
      const intent = resolveTransportIntent({
        entry: entry({ link: LINK_TARGET }),
        payload: { link: marker as never },
      });
      expect(intent.kind).toBe('refuse');
      if (intent.kind === 'refuse') expect(intent.reason).toMatch(/unreadable link target/);
    }
  });

  it('a well-formed payload link that DISAGREES with the saved one refuses — no silent adoption', () => {
    for (const other of [
      { relayUrl: 'wss://other-relay.example', hostId: LINK_TARGET.hostId },
      { relayUrl: LINK_TARGET.relayUrl, hostId: 'host-OTHER' },
    ]) {
      const intent = resolveTransportIntent({
        entry: entry({ link: LINK_TARGET }),
        payload: { link: other },
      });
      expect(intent.kind).toBe('refuse');
      if (intent.kind === 'refuse') expect(intent.reason).toMatch(/does not match/);
    }
  });

  it('payload link intent landing on a link entry stays link ONLY when it agrees', () => {
    // A structured target that agrees with the saved one: link.
    expect(
      resolveTransportIntent({ entry: entry({ link: LINK_TARGET }), payload: { link: { ...LINK_TARGET } } }).kind,
    ).toBe('link');
    // The old hole — any truthy garbage (`{link: 1}`) riding a valid link
    // entry — now refuses like its gateway twin.
    expect(
      resolveTransportIntent({ entry: entry({ link: LINK_TARGET }), payload: { link: 1 } }).kind,
    ).toBe('refuse');
  });
});
