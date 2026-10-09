/**
 * The ONE gate every web dial passes before it reads a host's credential or
 * opens a socket (web#4, core #3059).
 *
 * The web has three ways to reach a host, each with its own transports:
 *   - `session`    — `webApi.ssh.connect` (terminal, files, agents, and the
 *                    shared store's reconnect): ordinary SSH through the
 *                    direct WebSocket bridge, or `LinkSshConnection` for a
 *                    link host. No gateway transport yet.
 *   - `bridgeExec` — the hosts list's warnings sweep and acks, over the
 *                    Lambda bridge: ordinary SSH only.
 *   - `forward`    — `/fwd/<host>:<port>/` through a direct-WebSocket
 *                    `HostChannel`: ordinary SSH only.
 *
 * The decision itself is core's shared `unsupportedTransport`, asked with the
 * dial path's real capabilities; the refusal text is core's too. Nothing here
 * reads a secret until that decision has passed, so a gateway- or link-marked
 * host never sends its key — or a link host's relay token — anywhere a plain
 * SSH dial would take it.
 */
import { unsupportedTransport, type HostEntry, type TransportCapabilities } from '@pocketshell/core';
import { useHostsStore, type HostSecret } from '../stores/hosts';

export const WEB_DIAL_PATHS = {
  session: { gateway: false, link: true },
  bridgeExec: { gateway: false, link: false },
  forward: { gateway: false, link: false },
} as const satisfies Record<string, TransportCapabilities>;

export type WebDialPath = keyof typeof WEB_DIAL_PATHS;

export type DialGrant =
  | { ok: true; transport: 'ssh' | 'link'; secret: HostSecret | undefined }
  | { ok: false; error: string };

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/**
 * The name to put in a request's refusal: the alias the request names, else
 * the address-resolved entry's name ONLY when that entry carries exactly the
 * request's transport markers (then it is the host the user tapped). An
 * address match alone proves nothing — an unmarked host at the same address
 * must never be named as "reached through the gateway".
 */
export function requestLabel(
  request: { hostAlias?: string; link?: unknown; gateway?: unknown },
  entry: HostEntry | undefined,
): string | null {
  if (request.hostAlias !== undefined && request.hostAlias !== '') return request.hostAlias;
  if (entry === undefined) return null;
  const markers = (o: object) =>
    JSON.stringify(['link', 'gateway'].map((k) => (hasOwn(o, k) ? [k, (o as Record<string, unknown>)[k] ?? null] : null)));
  return markers(request) === markers(entry) ? entry.name : null;
}

/**
 * Whether a connect REQUEST may be dialled at all on `path`, before it is
 * even resolved to a synced entry: the request's own markers decide on their
 * own, because an address-resolved entry may be a different, unmarked host.
 * `label` names the host the user asked for (never the resolved entry).
 */
export function refuseRequest(path: WebDialPath, request: object, label: string | null): string | null {
  const decision = unsupportedTransport(request, WEB_DIAL_PATHS[path], label);
  return decision.refused ? decision.message : null;
}

/**
 * Authorize a dial to the synced `entry` on `path` and only then hand out its
 * credential. `request` is the connect request that resolved to the entry,
 * when there is one; its markers are re-checked here so no caller can skip
 * them.
 */
export async function authorizeDial(
  path: WebDialPath,
  entry: HostEntry,
  request: { request: object; label: string | null } | null = null,
): Promise<DialGrant> {
  if (request !== null) {
    const asked = refuseRequest(path, request.request, request.label);
    if (asked !== null) return { ok: false, error: asked };
  }
  const stored = unsupportedTransport(entry, WEB_DIAL_PATHS[path]);
  if (stored.refused) return { ok: false, error: stored.message };
  if (request !== null && hasOwn(request.request, 'link') && !hasOwn(entry, 'link')) {
    // A link host's hostname is display-only: dialling the unmarked entry
    // that happens to share it would be plain SSH to the wrong place.
    return { ok: false, error: `“${entry.name}” is not the relay-link host this dial asked for. Nothing was dialled.` };
  }
  const secret = await useHostsStore().getHostSecret(entry.name);
  return { ok: true, transport: hasOwn(entry, 'link') ? 'link' : 'ssh', secret };
}
