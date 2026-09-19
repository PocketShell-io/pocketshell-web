/**
 * The forwarding URL scheme: /fwd/<host-alias>/<port>[/<path>].
 *
 * The host alias is the user's own synced host name (the same `Host` label
 * the lists show), so nothing needs to be globally unique or DNS-resolvable
 * — unlike a codespaces-style subdomain scheme, where every host:port pair
 * would need its own wildcard record. Everything under the prefix is routed
 * by the service worker (public/sw.js) into the app tab's SSH connection.
 */

export const FWD_PREFIX = '/fwd/';

/** One parsed /fwd/ URL: which host entry, which port, what path on it. */
export interface ForwardTarget {
  host: string;
  port: number;
  /** The path AS SENT (still percent-encoded); '' means no sub-path. */
  path: string;
}

/** Host aliases come from `Host` directives and manual entries; this is
 * deliberately narrower than a full hostname grammar — it keeps the SW's
 * routing decision unambiguous. */
const HOST_RE = /^[A-Za-z0-9._~-]+$/;

export function parseForwardPath(pathname: string): ForwardTarget | null {
  if (!pathname.startsWith(FWD_PREFIX)) return null;
  const rest = pathname.slice(FWD_PREFIX.length);
  const slash = rest.indexOf('/');
  const head = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  const colon = head.lastIndexOf(':');
  if (colon <= 0 || colon === head.length - 1) return null;
  const rawHost = head.slice(0, colon);
  const rawPort = head.slice(colon + 1);
  if (!/^\d{1,5}$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) return null;
  let host: string;
  try {
    host = decodeURIComponent(rawHost);
  } catch {
    return null;
  }
  if (!HOST_RE.test(host)) return null;
  return { host, port, path };
}

/** The URL path a forwarded app lives under. */
export function forwardPrefix(host: string, port: number): string {
  return `${FWD_PREFIX}${encodeURIComponent(host)}:${port}`;
}

/** The full URL to open for one forwarded port. */
export function forwardUrl(host: string, port: number): string {
  return `${forwardPrefix(host, port)}/`;
}
