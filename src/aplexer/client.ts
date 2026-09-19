/**
 * Client for the aplexer session manager (`a`) — the browser twin of the
 * desktop's `helper/AplexerClient.ts`, running the same commands through an
 * {@link ExecTransport} (the shared SshConnection's exec channel) and
 * parsing with the same rules (`snapshot.ts`). Every command is PATH-wrapped
 * once here ({@link pathAwareCommand}), the way the desktop's callers wrap
 * before `SshService.exec` — the transport stays a raw exec channel.
 *
 * aplexer is the MAIN session manager wherever it is installed; a host
 * without it gets today's plain-shell terminal, not a broken panel. Every
 * method here is total — it resolves a result object or an empty list, never
 * throws for anything the host does — matching the desktop's contract.
 *
 * Identity discipline: the UUID is the stable selector for kill/rename
 * (renames change the tag, never the id, so an id can never be orphaned the
 * way a name can). `start` is the one call with no id yet and addresses
 * `workspace + tag`, which the host enforces as unique among live sessions.
 */
import type { AplexerSessionRecord, AplexerSortKey, AplexerWarning } from '../shared/aplexer';
import { APLEXER_LIST_SORT } from '../shared/aplexer';
import type { SessionSummary } from '../shared/types';
import {
  pathAwareCommand,
  aplexerAckCommand,
  aplexerKillCommand,
  aplexerProbeCommand,
  aplexerRenameCommand,
  aplexerSnapshotCommand,
  aplexerStartCommand,
  aplexerWarningsCommand,
  isAplexerAckNotFound,
  isAplexerNotFound,
  isAplexerStartRefusal,
  isAplexerUnknownFlag,
} from './commands';
import { aplexerRecordToSummary, byOldestCreated, parseAplexerSnapshot } from './snapshot';
import { parseWarningsJson } from './warningsParse';
import type { ExecOutcome } from '../terminal/connection';

/** The one thing the client needs from a connection. */
export interface ExecTransport {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecOutcome>;
}

/** Outcome of {@link AplexerClient.startSession}. Never thrown. */
export interface AplexerStartOutcome {
  ok: boolean;
  /** The created session's UUID, for the join/kill/rename that follow. */
  id: string | null;
  /** The tag the host confirmed. Echoed back, like the helper's create. */
  tag: string | null;
  /**
   * True when the host refused because the pair is LIVE (a race with the
   * caller's snapshot check). The caller re-reads and treats it as a reuse,
   * rather than reporting a failure for a session that exists.
   */
  liveRefusal: boolean;
  error: string | null;
}

/** Outcome of {@link AplexerClient.killSession}. Never thrown. */
export interface AplexerKillOutcome {
  ok: boolean;
  /** True when the session was already gone — the ordinary stale-list race. */
  notFound: boolean;
  error: string | null;
}

/** Outcome of {@link AplexerClient.renameSession}. Never thrown. */
export interface AplexerRenameOutcome {
  ok: boolean;
  notFound: boolean;
  error: string | null;
}

/** Outcome of {@link AplexerClient.ackWarnings}. Never thrown. */
export interface AplexerAckOutcome {
  ok: boolean;
  /** True when the target matched nothing — another client acked first. */
  notFound: boolean;
  error: string | null;
}

export class AplexerClient {
  /**
   * `a` present on this connection. Null means "not asked yet"; false means
   * "asked and it is absent". Remembering the negative matters as much as
   * the positive: a host without aplexer must pay one probe per CONNECTION,
   * not one per five-second poll tick.
   */
  private available: boolean | null = null;

  /**
   * `--sort` support, same discipline as the availability probe: true after
   * one sorted snapshot answered, false after the CLI refused the flag (an
   * old host — every tick then goes straight to the unsorted exec), unknown
   * until one of those happens.
   */
  private sortSupported: boolean | null = null;

  constructor(private readonly transport: ExecTransport) {}

  /** Forget cached per-connection state. Call on disconnect. */
  evict(): void {
    this.available = null;
    this.sortSupported = null;
  }

  /**
   * Is `a` installed on this host? Cached, never throws — a host that
   * cannot be asked is a host without aplexer.
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    let available = false;
    try {
      const res = await this.transport.exec(pathAwareCommand(aplexerProbeCommand()));
      available = res.exitCode === 0 && res.stdout.trim().length > 0;
    } catch {
      available = false;
    }
    this.available = available;
    return available;
  }

  /**
   * Live aplexer sessions as rows in the host's own order, or null when `a`
   * is absent.
   *
   * Null vs [] is the whole contract: null means "no aplexer here", []
   * means "aplexer answered and nothing is running". A failed exec on a
   * host that HAS `a` also answers [] — the snapshot is the whole list on
   * such a host, so the tree shows empty for that poll tick and recovers on
   * the next.
   */
  async listSessions(sort: AplexerSortKey = APLEXER_LIST_SORT): Promise<SessionSummary[] | null> {
    if (!(await this.isAvailable())) return null;
    const records = await this.snapshotRecords(sort);
    return records.map(aplexerRecordToSummary);
  }

  /**
   * The raw snapshot records, or [] on any failure. Never throws.
   *
   * With [sort], the sorted command is tried first and its DOCUMENT ORDER is
   * kept — that is the feature. When the host cannot do it yet (the flag is
   * refused, remembered for the connection) or the sorted exec dies
   * mid-flight, the unsorted snapshot answers and is sorted client-side, so
   * the order a host without the flag sees is the one it always saw.
   */
  async snapshotRecords(sort?: AplexerSortKey): Promise<AplexerSessionRecord[]> {
    if (sort !== undefined && this.sortSupported !== false) {
      try {
        const res = await this.transport.exec(pathAwareCommand(aplexerSnapshotCommand(sort)));
        if (res.exitCode === 0) {
          this.sortSupported = true;
          return parseAplexerSnapshot(res.stdout);
        }
        // Remember the refusal only when it IS one: a usage error means every
        // future tick would fail the same way, while any other non-zero exit
        // may be a one-off not worth pinning the connection to the fallback.
        if (isAplexerUnknownFlag(res.stderr)) {
          this.sortSupported = false;
        }
      } catch {
        // Transport-level: fall through to the unsorted attempt this tick;
        // the capability stays unknown and the next tick asks again.
      }
    }
    try {
      const res = await this.transport.exec(pathAwareCommand(aplexerSnapshotCommand()));
      if (res.exitCode !== 0) return [];
      return byOldestCreated(parseAplexerSnapshot(res.stdout));
    } catch {
      return [];
    }
  }

  /**
   * Start a shell session for [workspace] under [tag].
   *
   * The caller checks liveness first (snapshot); a `liveRefusal` covers the
   * race where the pair went live between that check and this exec. Anything
   * else non-zero is a real failure with the host's own sentence.
   */
  async startSession(opts: { workspace: string; tag: string }): Promise<AplexerStartOutcome> {
    let res;
    try {
      res = await this.transport.exec(pathAwareCommand(aplexerStartCommand(opts.workspace, opts.tag)));
    } catch (e) {
      return { ok: false, id: null, tag: null, liveRefusal: false, error: String(e).slice(0, 300) };
    }
    if (res.exitCode === 0) {
      const record = parseSingleAplexerRecord(res.stdout);
      // The record echoes the tag back; trust it over the request the way the
      // helper create does. An unparseable body with exit 0 still created the
      // session (the host said so) — report it under the requested tag.
      return {
        ok: true,
        id: record?.id ?? null,
        tag: record?.tag ?? opts.tag,
        liveRefusal: false,
        error: null,
      };
    }
    if (isAplexerStartRefusal(res.exitCode, res.stderr)) {
      return { ok: false, id: null, tag: null, liveRefusal: true, error: res.stderr.trim() };
    }
    return {
      ok: false,
      id: null,
      tag: null,
      liveRefusal: false,
      error: res.stderr.trim() || res.stdout.trim() || `a start exited ${res.exitCode}`,
    };
  }

  /**
   * Kill the session [id]. `notFound` is the ordinary stale-list race, not
   * an error worth alarming over — the caller reports "already gone".
   */
  async killSession(id: string): Promise<AplexerKillOutcome> {
    let res;
    try {
      res = await this.transport.exec(pathAwareCommand(aplexerKillCommand(id)));
    } catch (e) {
      return { ok: false, notFound: false, error: String(e).slice(0, 300) };
    }
    if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
    if (isAplexerNotFound(res.exitCode, res.stderr)) {
      return { ok: false, notFound: true, error: `"${id}" is not running on this host any more.` };
    }
    return {
      ok: false,
      notFound: false,
      error: res.stderr.trim() || res.stdout.trim() || `a kill exited ${res.exitCode}`,
    };
  }

  /** Rename the session [id] to [tag] within its workspace. */
  async renameSession(id: string, tag: string): Promise<AplexerRenameOutcome> {
    let res;
    try {
      res = await this.transport.exec(pathAwareCommand(aplexerRenameCommand(id, tag)));
    } catch (e) {
      return { ok: false, notFound: false, error: String(e).slice(0, 300) };
    }
    if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
    if (isAplexerNotFound(res.exitCode, res.stderr)) {
      return { ok: false, notFound: true, error: 'That session is not running any more.' };
    }
    return {
      ok: false,
      notFound: false,
      error: res.stderr.trim() || res.stdout.trim() || `a rename exited ${res.exitCode}`,
    };
  }

  /**
   * Every unacknowledged crash/OOM warning on this host, or [] on any
   * failure. Never throws, and [] on a host without `a` — the same total
   * contract as the snapshot. The availability gate rides the cache the
   * listing warms, so a host without aplexer pays no exec for this per poll
   * tick.
   */
  async listWarnings(): Promise<AplexerWarning[]> {
    if (!(await this.isAvailable())) return [];
    try {
      const res = await this.transport.exec(pathAwareCommand(aplexerWarningsCommand()));
      if (res.exitCode !== 0) return [];
      return parseWarningsJson(res.stdout) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Acknowledge warnings: the whole list when [target] is null, else the one
   * whose session UUID it is. `notFound` is the benign race — the warning
   * was acked from another client between the banner's render and this
   * click — not an error worth alarming over.
   */
  async ackWarnings(target?: string): Promise<AplexerAckOutcome> {
    let res;
    try {
      res = await this.transport.exec(pathAwareCommand(aplexerAckCommand(target)));
    } catch (e) {
      return { ok: false, notFound: false, error: String(e).slice(0, 300) };
    }
    if (res.exitCode === 0) return { ok: true, notFound: false, error: null };
    if (isAplexerAckNotFound(res.exitCode, res.stderr)) {
      return { ok: false, notFound: true, error: null };
    }
    return {
      ok: false,
      notFound: false,
      error: res.stderr.trim() || res.stdout.trim() || `a ack exited ${res.exitCode}`,
    };
  }
}

/**
 * Parse `a start --json`'s single-record body.
 *
 * `start` prints one object, not the snapshot's array; rather than a second
 * record parser, reuse the array one by wrapping — with a direct-parse
 * fallback for a body that is already an object but wrapped in shell noise
 * the brackets would corrupt. The first non-empty JSON-looking line wins.
 */
function parseSingleAplexerRecord(stdout: string): AplexerSessionRecord | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    const records = parseAplexerSnapshot(JSON.stringify([parsed]));
    return records.at(0) ?? null;
  } catch {
    return null;
  }
}
