/**
 * The web's shell group: the browser twin of the desktop's SshService +
 * TmuxClientPool pair, over one SshConnection per host.
 *
 * The contract is the desktop main process's behaviour (see ipc/terminalIpc.ts):
 *
 *  - `open` runs a login-shell PTY, or [command] directly under the PTY —
 *    the shape every special pane uses;
 *  - `attachSession` is how a session TAB gets its PTY. The pool keeps one
 *    client per session tab for the life of the tab, so an attach for a tab
 *    that is already open is answered with its existing shellId and
 *    `switched: true` — no host work at all, and the terminal pane leaves
 *    its terminal alone when it sees `switched`;
 *  - the join commands come from core (`aplexerAttachCommand`,
 *    `sessionAttachCommand`) — the same spellings the desktop types, so a
 *    host cannot tell the two clients apart;
 *  - `input` honours the desktop's fence: an optional sessionName (plus
 *    workspace, for aplexer) that must match what the shell is showing, or
 *    the write is refused with an honest `false`;
 *  - `redraw` is a tmux-only repaint — an aplexer shell repaints itself on
 *    every attach, so `true` (nothing to do); a bare shell has nothing to
 *    refresh, so `false`. Never an error;
 *  - `windowSize` answers `{ kind: 'bare' }` — the honest "no tmux geometry
 *    to probe behind this shell" the desktop's reconcile loop already treats
 *    as "nothing to check".
 *
 * Exit events carry code 0: the shared pane consumes the EVENT (it marks the
 * pane gone), never the number.
 */
import type { GeometryProbe, ShellId } from '@pocketshell/core';
import { aplexerAttachCommand } from '@pocketshell/core';
import { sessionAttachCommand } from '@pocketshell/core/shared/attachCommand';
import type { SshConnection, PtyChannel } from '../terminal/connection';

/** The payload `attachSession` receives, per the core api contract. */
export interface AttachSessionRequest {
  connectionId: string;
  sessionName: string;
  cols?: number;
  rows?: number;
  backend?: 'tmux' | 'aplexer';
  workspace?: string;
  tag?: string;
  aplexerId?: string;
}

interface ShellRecord {
  shellId: ShellId;
  channel: PtyChannel;
  /** The pool key — `tmux:<name>` or `aplexer:<workspace>:<tag>`. */
  key: string;
  /** What the shell is showing: the tmux session name or the aplexer tag. */
  session: string;
  workspace?: string;
  aplexerId?: string;
  backend: 'tmux' | 'aplexer' | 'shell';
}

export type DataListener = (payload: { shellId: ShellId; data: Uint8Array }) => void;
export type ExitListener = (payload: { shellId: ShellId; exitCode: number }) => void;

export class ShellService {
  /** connectionId -> poolKey -> live shell. */
  private readonly pools = new Map<string, Map<string, ShellRecord>>();
  private nextShellId = 1;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExited(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Drop every shell of a connection (the web twin of main tearing the
   * connection record down). Channels are closed best-effort; the exit
   * events they fire are absorbed because their records are already gone. */
  evict(connectionId: string): void {
    const pool = this.pools.get(connectionId);
    this.pools.delete(connectionId);
    if (!pool) return;
    for (const record of pool.values()) {
      try {
        record.channel.close();
      } catch {
        // the connection is going down; nothing to salvage
      }
    }
  }

  async open(
    conn: SshConnection,
    connectionId: string,
    payload: { command?: string; cols?: number; rows?: number },
  ): Promise<ShellId> {
    const shellId = `shell-${this.nextShellId++}`;
    const channel = await conn.openPty({
      ...(payload.command !== undefined ? { command: payload.command } : {}),
      ...(payload.cols !== undefined ? { cols: payload.cols } : {}),
      ...(payload.rows !== undefined ? { rows: payload.rows } : {}),
      onData: (bytes) => this.emitData(shellId, bytes),
      onExit: () => this.emitExit(shellId),
      onError: () => {},
    });
    const pool = this.poolOf(connectionId);
    pool.set(shellId, {
      shellId,
      channel,
      key: shellId,
      session: '',
      backend: 'shell',
    });
    return shellId;
  }

  /**
   * Attach a session tab to its PTY. An existing live client for the same
   * session is handed back untouched (`switched: true`); anything else joins
   * fresh with the core join command for its backend.
   *
   * Identity follows the desktop pool: a tmux name is host-global, while an
   * aplexer tag repeats across workspaces — so an aplexer attach is keyed by
   * workspace+tag, with an explicit aplexerId matching outright when the row
   * carried one.
   */
  async attachSession(
    conn: SshConnection,
    connectionId: string,
    payload: AttachSessionRequest,
  ): Promise<{ shellId: ShellId; switched: boolean }> {
    const pool = this.poolOf(connectionId);
    const aplexer = payload.backend === 'aplexer';
    const tag = payload.tag ?? payload.sessionName;

    const existing = this.findExisting(pool, payload);
    if (existing) return { shellId: existing.shellId, switched: true };

    const command = aplexer
      ? aplexerAttachCommand({
          ...(payload.aplexerId ? { id: payload.aplexerId } : {}),
          workspace: payload.workspace,
          tag,
        })
      : sessionAttachCommand(payload.sessionName);
    const shellId = `shell-${this.nextShellId++}`;
    const channel = await conn.openPty({
      command,
      ...(payload.cols !== undefined ? { cols: payload.cols } : {}),
      ...(payload.rows !== undefined ? { rows: payload.rows } : {}),
      onData: (bytes) => this.emitData(shellId, bytes),
      onExit: () => {
        // The PTY died — the session was killed, exited, or the channel
        // dropped. Drop the record so the next attach joins rather than
        // handing back a dead client, then tell the pane.
        const current = pool.get(this.poolKey(aplexer, payload.workspace, tag));
        if (current?.shellId === shellId) pool.delete(current.key);
        this.emitExit(shellId);
      },
      onError: () => {},
    });
    const key = this.poolKey(aplexer, payload.workspace, tag);
    pool.set(key, {
      shellId,
      channel,
      key,
      session: tag,
      ...(payload.workspace !== undefined ? { workspace: payload.workspace } : {}),
      ...(payload.aplexerId !== undefined ? { aplexerId: payload.aplexerId } : {}),
      backend: aplexer ? 'aplexer' : 'tmux',
    });
    return { shellId, switched: false };
  }

  /**
   * Keystrokes for one shell. `sessionName` (plus `workspace`, for an
   * aplexer shell) is a FENCE, not a target: a caller still holding the shell
   * of a tab that was closed and re-joined gets an honest `false` instead of
   * writing into a stranger's pane.
   */
  async input(
    shellId: ShellId,
    data: string,
    sessionName?: string,
    workspace?: string,
  ): Promise<boolean> {
    const record = this.recordFor(shellId);
    if (!record) return false;
    if (sessionName !== undefined && sessionName !== '') {
      if (record.session !== sessionName) return false;
      if (workspace !== undefined && record.backend === 'aplexer' && record.workspace !== workspace) {
        return false;
      }
    }
    record.channel.write(data);
    return true;
  }

  async resize(shellId: ShellId, cols: number, rows: number): Promise<boolean> {
    const record = this.recordFor(shellId);
    if (!record) return false;
    record.channel.resize(rows, cols);
    return true;
  }

  /** A repaint, not a resize. Aplexer repaints on attach (true = nothing to
   * do); a bare shell has nothing to refresh (false). Never an error. */
  async redraw(shellId: ShellId): Promise<boolean> {
    const record = this.recordFor(shellId);
    if (!record) return false;
    return record.backend === 'aplexer';
  }

  /** No tmux geometry to ask behind any web shell — the ordinary `bare`
   * answer the shared pane's reconcile loop treats as "nothing to check". */
  async windowSize(_shellId: ShellId): Promise<GeometryProbe> {
    return { kind: 'bare' };
  }

  async close(shellId: ShellId): Promise<boolean> {
    const record = this.recordFor(shellId);
    if (!record) return false;
    const pool = [...this.pools.values()].find((p) => p.get(record.key) === record);
    pool?.delete(record.key);
    record.channel.close();
    return true;
  }

  // --- internals -----------------------------------------------------------

  /** Does a live shell with this id exist here? The seam routes shell-
   * addressed calls by asking every connection's service. */
  holds(shellId: ShellId): boolean {
    return this.recordFor(shellId) !== null;
  }

  private poolOf(connectionId: string): Map<string, ShellRecord> {
    let pool = this.pools.get(connectionId);
    if (!pool) {
      pool = new Map();
      this.pools.set(connectionId, pool);
    }
    return pool;
  }

  private poolKey(aplexer: boolean, workspace: string | undefined, tag: string): string {
    return aplexer ? `aplexer:${workspace ?? ''}:${tag}` : `tmux:${tag}`;
  }

  /** An attach the pool can answer without touching the host. An explicit
   * aplexerId wins outright; otherwise the pool key decides. */
  private findExisting(
    pool: Map<string, ShellRecord>,
    payload: AttachSessionRequest,
  ): ShellRecord | null {
    if (payload.aplexerId) {
      for (const record of pool.values()) {
        if (record.backend === 'aplexer' && record.aplexerId === payload.aplexerId) return record;
      }
    }
    const key = this.poolKey(
      payload.backend === 'aplexer',
      payload.workspace,
      payload.tag ?? payload.sessionName,
    );
    return pool.get(key) ?? null;
  }

  private recordFor(shellId: ShellId): ShellRecord | null {
    for (const pool of this.pools.values()) {
      for (const record of pool.values()) {
        if (record.shellId === shellId) return record;
      }
    }
    return null;
  }

  private emitData(shellId: ShellId, bytes: Uint8Array): void {
    for (const listener of this.dataListeners) listener({ shellId, data: bytes });
  }

  private emitExit(shellId: ShellId): void {
    for (const listener of this.exitListeners) listener({ shellId, exitCode: 0 });
  }
}
