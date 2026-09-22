/**
 * Client for the aplexer session manager (`a`) — the browser twin of the
 * desktop's `helper/AplexerClient`, running the SHARED core
 * (`shared/aplexerClientCore.ts`) against the workspace connection's exec
 * channel. The command lines, the refusal classifiers, the capability
 * caches, and the total (never-throw) contracts are the desktop's exact
 * code; what remains here is the browser shell: one core, one transport.
 *
 * aplexer is the MAIN session manager wherever it is installed; a host
 * without it gets the plain-shell terminal, not a broken panel.
 */
import type { AplexerSessionRecord, AplexerSortKey, AplexerWarning } from '@pocketshell/core';
import { APLEXER_LIST_SORT } from '@pocketshell/core';
import type { SessionSummary } from '@pocketshell/core';
import {
  AplexerCore,
  type AplexerAckOutcome,
  type AplexerKillOutcome,
  type AplexerRenameOutcome,
  type AplexerStartOutcome,
} from '@pocketshell/core';
import type { ExecOutcome } from '../terminal/connection';

export type {
  AplexerAckOutcome,
  AplexerKillOutcome,
  AplexerRenameOutcome,
  AplexerStartOutcome,
};

/** The one thing the client needs from a connection. */
export interface ExecTransport {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecOutcome>;
}

export class AplexerClient {
  /** The shared brain, pointed at this connection's exec channel. */
  private readonly core: AplexerCore;

  constructor(transport: ExecTransport) {
    this.core = new AplexerCore({ exec: (command) => transport.exec(command) });
  }

  /** Forget cached per-host state. Call on disconnect. */
  evict(): void {
    this.core.evict();
  }

  /** Is `a` installed on this host? Cached, never throws. */
  async isAvailable(): Promise<boolean> {
    return this.core.isAvailable();
  }

  /** Live sessions in the host's own order, or null when `a` is absent. */
  async listSessions(sort: AplexerSortKey = APLEXER_LIST_SORT): Promise<SessionSummary[] | null> {
    return this.core.listSessions(sort);
  }

  /** The raw snapshot records, or [] on any failure. Never throws. */
  async snapshotRecords(sort?: AplexerSortKey): Promise<AplexerSessionRecord[]> {
    return this.core.snapshotRecords(sort);
  }

  /** Start a shell session for [workspace] under [tag]. Never throws. */
  async startSession(opts: { workspace: string; tag: string }): Promise<AplexerStartOutcome> {
    return this.core.startSession(opts);
  }

  /** Kill the session [id]. `notFound` is the ordinary stale-list race. */
  async killSession(id: string): Promise<AplexerKillOutcome> {
    return this.core.killSession(id);
  }

  /** Rename the session [id] to [tag] within its workspace. */
  async renameSession(id: string, tag: string): Promise<AplexerRenameOutcome> {
    return this.core.renameSession(id, tag);
  }

  /** Every unacknowledged crash/OOM warning, newest first, or []. */
  async listWarnings(): Promise<AplexerWarning[]> {
    return this.core.listWarnings();
  }

  /** Acknowledge warnings: the whole list when [target] is null, else one. */
  async ackWarnings(target?: string): Promise<AplexerAckOutcome> {
    return this.core.ackWarnings(target);
  }
}
