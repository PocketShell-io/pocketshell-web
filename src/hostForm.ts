import type { HostEntry } from '@pocketshell/core';
import { GATEWAY_DEFAULT_SERVER_URL, normalizeGatewayServerUrl, normalizeGatewayTarget } from '@pocketshell/core';

/**
 * The web-side host form: validating what a browser user submits and the
 * one-entry merge into the synced list. Pure, so tests drive it without
 * Pinia or the network.
 *
 * This module is WEB-ONLY — syncMerge now ships in @pocketshell/core (one
 * implementation for desktop and web), and the web creating a host is a
 * web-only capability, so the helpers live here instead.
 *
 * Validation mirrors the desktop's coerceHostEntries (shared/sync.ts) — the
 * rules an entry must survive before it can be written back to
 * ~/.ssh/config — because an entry created here has to make that trip
 * intact on the next desktop sync.
 */

export interface HostDraft {
  name: string;
  hostname: string;
  /** As typed — '' means the default port. */
  port: string;
  user: string;
  /** Gateway dial (a NAT'd host running the gateway agent): the device id
   * to reach. '' = not a gateway host. */
  gatewayDeviceId: string;
  /** Gateway base URL; '' = the canonical production gateway. */
  gatewayUrl: string;
}

/** A validated draft → a HostEntry the sync payload can carry, or why not.
 * The error variant optionally names the offending field so the form can tie
 * its alert back to the input (the port field's aria-invalid state). */
export type NormalizedDraft =
  | { ok: true; entry: HostEntry }
  | { ok: false; error: string; field?: 'name' | 'hostname' | 'user' | 'port' | 'gatewayDeviceId' | 'gatewayUrl' };

export function normalizeHostDraft(draft: HostDraft, base?: HostEntry): NormalizedDraft {
  const name = draft.name.trim();
  const hostname = draft.hostname.trim();
  const user = draft.user.trim();
  if (name === '' || hostname === '') return { ok: false, error: 'Name and hostname are both required.' };
  // Neither may contain whitespace: the desktop's config writer emits them
  // on `Host <name>` / `HostName <hostname>` / `User <user>` lines.
  if (/\s/.test(name) || /\s/.test(hostname) || /\s/.test(user)) {
    return { ok: false, error: 'Name, hostname, and user must not contain whitespace.' };
  }
  let port = 22;
  if (draft.port.trim() !== '') {
    port = Number(draft.port.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: 'Port must be a whole number from 1 to 65535.', field: 'port' };
    }
  }
  // Gateway mode: a device id makes this a gateway host; the URL field may
  // stay empty (the canonical gateway applies). Clearing the device id on an
  // edit removes gateway mode — a direct host again. The fields tolerate
  // older drafts (and the desktop-twin shape) that predate gateway mode.
  const gatewayDeviceId = (draft.gatewayDeviceId ?? '').trim();
  let gateway: HostEntry['gateway'];
  if (gatewayDeviceId !== '') {
    const rawUrl = (draft.gatewayUrl ?? '').trim();
    const serverUrl = normalizeGatewayServerUrl(rawUrl === '' ? GATEWAY_DEFAULT_SERVER_URL : rawUrl);
    if (serverUrl === null) {
      return { ok: false, error: 'The gateway address must look like wss://gateway.pocketshell.io.', field: 'gatewayUrl' };
    }
    const target = normalizeGatewayTarget({ serverUrl, deviceId: gatewayDeviceId });
    if (target === null) {
      return {
        ok: false,
        error: 'The device id is letters, digits, dots, dashes, colons or underscores — as the host showed at enrollment.',
        field: 'gatewayDeviceId',
      };
    }
    gateway = target;
  }
  return {
    ok: true,
    entry: {
      name,
      hostname,
      port,
      user,
      // Fields the form does not ask for carry over from the entry being
      // edited (a desktop-owned identityFile path must survive an edit);
      // a fresh create starts from the all-empty shape.
      identityFile: base?.identityFile ?? null,
      proxyJump: base?.proxyJump ?? null,
      forwardAgent: base?.forwardAgent ?? false,
      localForwards: base?.localForwards ?? [],
      remoteForwards: base?.remoteForwards ?? [],
      fromConfig: base?.fromConfig ?? false,
      ...(gateway !== undefined ? { gateway } : {}),
    },
  };
}

/** The list with `entry` taking over its name — an append when the name is
 * new, an in-place replacement otherwise (the list order is the user's). */
export function upsertHost(hosts: readonly HostEntry[], entry: HostEntry): HostEntry[] {
  const at = hosts.findIndex((host) => host.name === entry.name);
  if (at === -1) return [...hosts, entry];
  const out = hosts.slice();
  out[at] = entry;
  return out;
}
