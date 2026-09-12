import type { HostEntry } from './shared/types';

/**
 * The web-side host form: validating what a browser user submits and the
 * one-entry merge into the synced list. Pure, so tests drive it without
 * Pinia or the network.
 *
 * This module is WEB-ONLY — src/shared/syncMerge.ts is a verbatim vendored
 * copy of the desktop's file (scripts/sync-shared.sh), and the web creating
 * a host is a web-only capability, so the helpers live here instead.
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
}

/** A validated draft → a HostEntry the sync payload can carry, or why not. */
export type NormalizedDraft =
  | { ok: true; entry: HostEntry }
  | { ok: false; error: string };

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
      return { ok: false, error: 'Port must be a whole number from 1 to 65535.' };
    }
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
