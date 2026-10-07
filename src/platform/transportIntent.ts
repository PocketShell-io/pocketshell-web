/**
 * Dial-transport intent for one connect: which transport a host entry (and
 * the shared caller's payload) actually asks for, resolved BEFORE any secret
 * is read, any token minted, or any socket opened.
 *
 * Why presence, not truthiness: a synced entry whose record carries gateway
 * data that fails to parse (null, a partial object, the wrong shape — or a
 * property that only holds `undefined`) is a host the user pointed at the
 * gateway. Silently falling through would dial `hostname:port` directly —
 * the exact leak the gateway exists to prevent. So a gateway MARKER is
 * detected by OWN-PROPERTY PRESENCE and must either normalize to a target or
 * refuse the dial: a present marker cannot be demoted to "no marker" by the
 * accident of its value. (`link` stays value-based on entries: a materialized
 * `link: null` is the long-standing "no link" shape the direct dial has
 * always honoured — but see `eligibleForBridge`'s twin rule, which refuses
 * rather than bridges it.)
 *
 * Payload markers (the shared `ssh.connect` payload passes `gateway`/`link`
 * values verbatim as `unknown`) carry the caller's INTENT, detected the same
 * presence-first way: payload gateway intent must land on a gateway entry
 * whose saved target AGREES with the payload's, and payload link intent must
 * land on a link entry whose saved target agrees the same way — an ordinary,
 * conflicting or mismatched resolved entry refuses rather than downgrades
 * through the fuzzy host match. Producers therefore must not materialize
 * `gateway: undefined` on ordinary payloads/entries: a present property is a
 * claim, and an unreadable claim refuses instead of dialing.
 *
 * Saved targets are validated with the shared contract's own semantics, read
 * only: a gateway marker must normalize (`normalizeGatewayTarget`) and a
 * non-null link value must pass `isLinkTransportTarget`. A SAVED target that
 * fails its guard is a host the user pointed at a transport whose shape no
 * longer reads — it refuses, exactly like a malformed marker; it never
 * degrades to a direct dial behind the user's back. (`link: null` — and an
 * absent or undefined-valued `link` — remains the long-standing "no link"
 * shape the direct dial has always honoured.)
 */
import type { HostEntry } from '@pocketshell/core';
import {
  isLinkTransportTarget,
  normalizeGatewayTarget,
  type GatewayTransportTarget,
} from '@pocketshell/core';

/** Own-property gateway marker on an object: ANY value counts — null,
 * malformed, even `undefined` (an own property holding undefined is
 * materialized presence, not absence; absence is a MISSING key). */
function hasOwnMarker(obj: object, key: 'gateway' | 'link'): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function ownValue(obj: object, key: 'gateway' | 'link'): unknown {
  return (obj as Record<string, unknown>)[key];
}

export type TransportIntent =
  | { kind: 'none' }
  | { kind: 'gateway'; target: GatewayTransportTarget }
  | { kind: 'link' }
  | { kind: 'refuse'; reason: string };

const CONFLICT =
  'This host has conflicting transport settings (both a link and a gateway target) — edit the host and keep one.';

/**
 * Resolve the dial transport. Pure: reads the entry's shape and the raw
 * payload's own properties, touches nothing else — the caller runs this
 * before any vault, broker, or socket access and treats `refuse` as final.
 */
export function resolveTransportIntent(opts: {
  entry: HostEntry;
  /** The raw `ssh.connect` payload; its own `gateway`/`link` properties are
   * the caller's intent, taken verbatim (presence is intent). */
  payload?: object;
}): TransportIntent {
  const { entry } = opts;
  const payload = opts.payload;
  const payloadGatewayPresent = payload !== undefined && hasOwnMarker(payload, 'gateway');
  const payloadLinkPresent = payload !== undefined && hasOwnMarker(payload, 'link');
  const entryWantsGateway = hasOwnMarker(entry, 'gateway');
  // An entry's link intent keeps its value shape: null has always meant "no
  // link" to the dial, and the sweep must match the dial (see module doc).
  const entryLinkValue = ownValue(entry, 'link');
  const entryHasLink = entryLinkValue !== undefined && entryLinkValue !== null;

  if (payloadGatewayPresent && payloadLinkPresent) {
    return { kind: 'refuse', reason: CONFLICT };
  }
  if (entryWantsGateway && entryHasLink) {
    return { kind: 'refuse', reason: CONFLICT };
  }
  // The caller asked for the link transport but resolution landed on a
  // gateway host (or vice versa): a disagreement between the request and the
  // matched entry is refused — never silently re-routed.
  if (payloadLinkPresent && entryWantsGateway) {
    return {
      kind: 'refuse',
      reason: `The request asks for a link dial, but host ${entry.name} is a gateway host — check which host was selected.`,
    };
  }
  // The payload's gateway intent must survive host resolution: a gateway dial
  // asked by name must not degrade into a direct dial because the fuzzy match
  // landed on an ordinary entry.
  if (payloadGatewayPresent && !entryWantsGateway) {
    return {
      kind: 'refuse',
      reason: 'The request asks for a gateway dial, but the matched host has no gateway target — check which host was selected.',
    };
  }
  if (entryWantsGateway) {
    const target = normalizeGatewayTarget(ownValue(entry, 'gateway'));
    if (target === null) {
      return {
        kind: 'refuse',
        reason: `Host ${entry.name} has an unreadable gateway target — edit the host and re-enter its device id.`,
      };
    }
    if (payloadGatewayPresent) {
      // The payload marker is present, so it must be a READABLE target that
      // agrees with the saved one: null, undefined or a string is a malformed
      // marker, and a well-formed but different target is a mismatch. None of
      // the three may be ignored.
      const payloadTarget =
        payload !== undefined ? normalizeGatewayTarget(ownValue(payload, 'gateway')) : null;
      if (payloadTarget === null) {
        return { kind: 'refuse', reason: `Host ${entry.name} was asked for with an unreadable gateway target.` };
      }
      if (payloadTarget.deviceId !== target.deviceId || payloadTarget.serverUrl !== target.serverUrl) {
        return {
          kind: 'refuse',
          reason: `The request's gateway target does not match host ${entry.name}'s saved gateway target.`,
        };
      }
    }
    return { kind: 'gateway', target };
  }
  if (entryHasLink || payloadLinkPresent) {
    // Payload link intent with an ordinary resolved entry is the same
    // downgrade trap as gateway intent — refuse rather than guess.
    if (payloadLinkPresent && !entryHasLink) {
      return {
        kind: 'refuse',
        reason: 'The request asks for a link dial, but the matched host has no link target — check which host was selected.',
      };
    }
    // The saved link must still READ as one under the shared contract's own
    // guard: any other non-null value — a string, a number, a partial object —
    // is a claim on the link transport whose shape no longer parses, and it
    // refuses instead of degrading into a direct dial. Truthiness is never
    // the test.
    const savedLink = isLinkTransportTarget(entryLinkValue) ? entryLinkValue : null;
    if (savedLink === null) {
      return {
        kind: 'refuse',
        reason: `Host ${entry.name} has an unreadable link target — edit the host and re-enter its relay details.`,
      };
    }
    if (payloadLinkPresent) {
      // Same contract as the gateway payload marker: a present payload link
      // must be a READABLE target that agrees with the saved one. Null,
      // undefined or a non-target is a malformed marker, and a well-formed
      // but different target is a mismatch. None of the three may be
      // ignored, and none may fall through to the saved target silently.
      const raw = payload !== undefined ? ownValue(payload, 'link') : undefined;
      const payloadLink = isLinkTransportTarget(raw) ? raw : null;
      if (payloadLink === null) {
        return { kind: 'refuse', reason: `Host ${entry.name} was asked for with an unreadable link target.` };
      }
      if (payloadLink.relayUrl !== savedLink.relayUrl || payloadLink.hostId !== savedLink.hostId) {
        return {
          kind: 'refuse',
          reason: `The request's link target does not match host ${entry.name}'s saved link target.`,
        };
      }
    }
    return { kind: 'link' };
  }
  return { kind: 'none' };
}
