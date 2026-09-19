/**
 * Pure parsers for the aplexer CLI's machine-readable output, and the
 * snapshot-record → panel-row mapping.
 *
 * Ported from the desktop's `helper/aplexerParsers.ts` (the whole file minus
 * the warnings parser — this repo's `warnings.ts` already owns that
 * contract). The contract is `a snapshot --json`: a bare JSON array of
 * session records, each carrying at least the required `session-v1` fields.
 * Rows come back in the host's own order — with `--sort` the requested key,
 * and on a host that has no `--sort` its newest-created-first default. All
 * functions are pure — string in, data out, no I/O.
 */
import type { SessionAgentKind, SessionSummary } from '../shared/types';
import type { AplexerSessionRecord } from '../shared/aplexer';

/**
 * Records oldest-created first, ties in document order (Array#sort is
 * stable).
 *
 * The fallback order for a host whose `a` predates `--sort`: its unsorted
 * default is newest-first, and oldest-first is what such a host showed in
 * the panel before the flag existed.
 */
export function byOldestCreated(records: AplexerSessionRecord[]): AplexerSessionRecord[] {
  return [...records].sort((a, b) => a.created_at_ms - b.created_at_ms);
}

/**
 * Parse `a snapshot --json` into records. Unknown/truncated output -> [].
 *
 * Rows that are not objects, or that lack the identity triple
 * (`id`/`workspace`/`tag`), are dropped individually rather than failing the
 * batch: one corrupt record must not hide every session on the host. Dead
 * rows are dropped too — a terminal `phase`, or `worker_alive: false` —
 * because a dead record is not a session the panel can open, and
 * `a prune`/`a kill` own its removal host-side.
 */
export function parseAplexerSnapshot(stdout: string): AplexerSessionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AplexerSessionRecord[] = [];
  for (const row of parsed) {
    const record = parseAplexerRecord(row);
    if (record) out.push(record);
  }
  return out;
}

/** One snapshot element, or null when it is not a live session record. */
function parseAplexerRecord(row: unknown): AplexerSessionRecord | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const doc = row as Record<string, unknown>;
  const id = doc['id'];
  const workspace = doc['workspace'];
  const tag = doc['tag'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof workspace !== 'string' || workspace.length === 0) return null;
  if (typeof tag !== 'string' || tag.length === 0) return null;
  const phase = typeof doc['phase'] === 'string' ? doc['phase'] : '';
  const workerAlive = doc['worker_alive'];
  // A worker killed without recording an exit leaves `phase: 'running'`
  // forever — liveness is the pair, never the phase alone. A terminal phase
  // kills the row regardless of what `worker_alive` claims: a row reading
  // `exited` AND live is contradictory host data, and the snapshot must not
  // list something the panel cannot open. Records without the enrichment
  // are old-host rows; their phase is all there is.
  if (isTerminalPhase(phase)) return null;
  if (workerAlive === false) return null;
  const createdMs = typeof doc['created_at_ms'] === 'number' ? doc['created_at_ms'] : NaN;
  const activityMs = typeof doc['last_activity_ms'] === 'number' ? doc['last_activity_ms'] : NaN;
  const cwdRaw = doc['cwd'];
  const cwd = typeof cwdRaw === 'string' && cwdRaw.length > 0 ? cwdRaw : null;
  const engineRaw = doc['engine'];
  const engine = typeof engineRaw === 'string' ? engineRaw : '';
  const profileRaw = doc['profile'];
  const profile = typeof profileRaw === 'string' ? profileRaw : null;
  return {
    id,
    workspace,
    tag,
    engine,
    ...(profile ? { profile } : {}),
    cwd,
    phase,
    ...(typeof workerAlive === 'boolean' ? { worker_alive: workerAlive } : {}),
    created_at_ms: Number.isFinite(createdMs) ? createdMs : 0,
    ...(Number.isFinite(activityMs) ? { last_activity_ms: activityMs } : {}),
  };
}

/** Phases after which no worker work remains. Mirrors the spec §20 set. */
function isTerminalPhase(phase: string): boolean {
  return phase === 'exited' || phase === 'failed';
}

/**
 * Map a declared aplexer engine id to the panel's agent kind — the same
 * vocabulary mapping the desktop's `agentKindFromTmuxOption` performs
 * (`claude`, `codex`, `opencode`, `grok`, `shell`; both clients ported it
 * from the same PocketShell registry). Unknown engines read as "we did not
 * launch this" (null).
 */
export function agentKindFromEngine(engine: string): SessionAgentKind | null {
  switch (engine.trim().toLowerCase()) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'grok':
      return 'grok';
    case 'shell':
      return 'shell';
    default:
      return null;
  }
}

/**
 * An aplexer record as a session row.
 *
 * `name` carries the tag: display, tab identity, rename labelling all read
 * `name`. `path` carries the workspace — the grouping key — falling back to
 * the workload cwd when the workspace is ever unusable, so the row always
 * files under a real folder with no name-heuristic inference. `attached` is
 * always false: the snapshot carries no client count, and a row that never
 * claims attachment is a row whose dot is sometimes missing, while the
 * reverse would mark dead rows live.
 */
export function aplexerRecordToSummary(record: AplexerSessionRecord): SessionSummary {
  return {
    name: record.tag,
    created: Math.floor(record.created_at_ms / 1000),
    activity:
      record.last_activity_ms != null
        ? Math.floor(record.last_activity_ms / 1000)
        : Math.floor(record.created_at_ms / 1000),
    attached: false,
    path: record.workspace || record.cwd || null,
    agentKind: agentKindFromEngine(record.engine),
    backend: 'aplexer',
    workspace: record.workspace,
    tag: record.tag,
    aplexerId: record.id,
    ...(record.profile ? { profile: record.profile } : {}),
    ...(record.phase ? { aplexerPhase: record.phase } : {}),
  };
}
