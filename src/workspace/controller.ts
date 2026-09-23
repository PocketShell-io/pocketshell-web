/**
 * The sessions workspace controller: everything the host workspace view
 * shows, in one framework-free class the unit tests can drive without a DOM.
 *
 * It owns ONE SshConnection per host visit and multiplexes it the way the
 * desktop's main process does: a login-shell PTY per open session tab
 * (session joins run `a attach <uuid>` directly under the PTY — the same
 * command the desktop types, exec'd rather than typed so join latency is
 * not dominated by profile startup), plus the snapshot/warnings execs the
 * five-second poll rides.
 *
 * The panel's order contract is the desktop's (SESSIONLIST.md §6.0): the
 * host's `--sort` order is the sidebar's order, and this controller is a
 * fold of the snapshot, not a sort of it.
 */
import { aplexerAttachCommand } from '@pocketshell/core';
import type { AplexerWarning } from '../aplexer/warningsParse';
import { AplexerClient } from '../aplexer/client';
import type { AplexerStartOutcome } from '../aplexer/client';
import type { SessionSummary } from '@pocketshell/core';
import {
  buildLaunchCommand,
  groupSessionsIntoRoots,
  inferHome,
  KIND_LABELS,
  launchBlocker,
  type AgentProfile,
  type HostAgentSupport,
  type LaunchChoice,
  type SessionRootFolder,
} from '@pocketshell/core';
import { PocketshellProbe } from './agentProbe';
import { SshConnection, type KnownHostsHooks, type PtyChannel } from '../terminal/connection';
import type { BridgeAuth } from '../terminal/bridge';

/** Everything needed to reach one host. Built by the view from the synced
 * host entry + the decrypted secret; the tests build it by hand. */
export interface WorkspaceLink {
  url: string;
  idToken: string;
  host: string;
  port: number;
  user: string;
  auth: BridgeAuth;
}

/** One live session row in the sidebar. */
export interface SessionRow {
  id: string;
  tag: string;
  workspace: string;
  engine: string;
  phase: string;
  createdMs: number;
  activityMs: number;
}

/** One open terminal tab. */
export interface WorkspaceTab {
  /** `apx:<uuid>` for a session tab, `shell` for the raw-shell tab. */
  key: string;
  label: string;
  /** The workspace's trailing path component — shown under the label. */
  subtitle: string;
  engine: string;
  phase: string;
  /** The PTY channel is alive. A dead tab stays until the user closes it. */
  live: boolean;
}

export interface ControllerState {
  phase: 'connecting' | 'probing' | 'ready' | 'failed';
  /** Connection-level error (handshake, transport). */
  error: string;
  /** Short connection word for the chrome pill ("connected", "host key …"). */
  status: string;
  /** The host answers `a`. Null until probed. */
  aplexer: boolean | null;
  /**
   * The sidebar's folder tree — roots -> directories -> rows, folded by the
   * ONE derivation the desktop panel uses (core `groupSessionsIntoRoots`), so
   * both clients group a host identically. `$HOME` is inferred from the
   * session paths (the desktop's fallback), so root keys read `~/git`.
   */
  roots: SessionRootFolder[];
  /** The `$HOME` the grouping resolved, for absolute-path prefill (`+` on a root). */
  home: string | null;
  /** The folder whose workspace the tab bar shows — a `SessionDirectory.key`. */
  activeFolder: string | null;
  /** Flat rows in host order — the tab bar and status bar read this. */
  rows: SessionRow[];
  tabs: WorkspaceTab[];
  activeKey: string | null;
  warnings: AplexerWarning[] | null;
  /** The warnings list could not be refreshed this tick; shown as stale. */
  warnStale: boolean;
  /** The last failed action (start/kill/rename/launch), for the inline notice. */
  actionError: string;
  actionBusy: boolean;
  /** The launch probe is in flight — the picker says "checking…" not "no". */
  agentProbing: boolean;
  /** The host's `pocketshell agent` answer, null until first asked. */
  agentSupport: HostAgentSupport | null;
  /** The host's agent config-dir profiles for the picker. */
  agentProfiles: AgentProfile[];
  /** Snapshot age marker, bumped every poll so the view can tick ages. */
  tick: number;
}

export interface WorkspaceDeps {
  link: WorkspaceLink;
  /** Override the connection for tests. */
  makeConnection?: () => SshConnection;
  /** Host-key pinning (TOFU); built by the view from the pins store. */
  knownHosts?: KnownHostsHooks;
  pollMs?: number;
  /** How long a launch waits for its session's PTY before giving up. */
  launchTimeoutMs?: number;
}

const POLL_MS = 5_000;
/**
 * How long `launchAgentSession` waits for the new session's terminal to show
 * life before giving up on the launch — the desktop's LAUNCH_TIMEOUT_MS
 * (useSessionLaunch.ts). Generous on purpose: this is a fresh SSH channel plus
 * `a attach`, observed at 1.5-2s on a real link, so expiring means something is
 * actually wrong rather than merely slow.
 */
const LAUNCH_TIMEOUT_MS = 12_000;

export class HostWorkspaceController {
  state: ControllerState = {
    phase: 'connecting',
    error: '',
    status: 'connecting…',
    aplexer: null,
    roots: [],
    home: null,
    activeFolder: null,
    rows: [],
    tabs: [],
    activeKey: null,
    warnings: null,
    warnStale: false,
    actionError: '',
    actionBusy: false,
    agentProbing: false,
    agentSupport: null,
    agentProfiles: [],
    tick: 0,
  };

  private readonly conn: SshConnection;
  private readonly client: AplexerClient;
  private readonly probe: PocketshellProbe;
  private readonly pollMs: number;
  private readonly launchTimeoutMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private disposed = false;
  private readonly channels = new Map<string, PtyChannel>();
  /** One-shot "this PTY said something" resolvers, armed by the launch. */
  private readonly firstData = new Map<string, () => void>();
  private readonly listeners = new Set<(state: ControllerState) => void>();
  private readonly dataListeners = new Set<(key: string, bytes: Uint8Array) => void>();
  private readonly exitListeners = new Set<(key: string) => void>();

  constructor(private readonly deps: WorkspaceDeps) {
    this.conn =
      deps.makeConnection?.() ??
      new SshConnection();
    this.client = new AplexerClient(this.conn);
    this.probe = new PocketshellProbe(this.conn);
    this.pollMs = deps.pollMs ?? POLL_MS;
    this.launchTimeoutMs = deps.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
  }

  onChange(cb: (state: ControllerState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onChannelData(cb: (key: string, bytes: Uint8Array) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onChannelExit(cb: (key: string) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /** Connect, probe, list, and start the poll. Never throws. */
  async start(): Promise<void> {
    this.patch({ phase: 'connecting', status: 'connecting…' });
    try {
      await this.conn.connect({
        url: this.deps.link.url,
        idToken: this.deps.link.idToken,
        host: this.deps.link.host,
        port: this.deps.link.port,
        user: this.deps.link.user,
        auth: this.deps.link.auth,
        knownHosts: this.deps.knownHosts,
        onStatus: (s) => this.patch({ status: s }),
        onClosed: () => this.onConnectionClosed(),
      });
    } catch (e) {
      this.patch({
        phase: 'failed',
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    this.patch({ status: 'connected' });
    // A host without `a` still gets a working terminal: one raw shell tab,
    // today's behaviour with a tab bar around it.
    this.patch({ phase: 'probing' });
    const hasA = await this.client.isAvailable();
    this.patch({ aplexer: hasA });
    if (!hasA) {
      await this.openShellTab();
    }
    await this.refreshWarnings();
    await this.refreshSessions();
    this.patch({ phase: 'ready' });
    // The desktop's workspace memory, one slot shallow: the folder the user
    // had open on this host reopens (and re-attaches its first tab) on the
    // next visit. No memory of tabs-within-folder yet — the host order is
    // the accessed sort, so the top row is the tab they were most likely in.
    const saved = this.recallFolder();
    if (saved !== null && this.hasFolder(saved)) this.openFolder(saved);
    this.schedulePoll();
  }

  /**
   * Open a folder's workspace: mark it active and, unless the active tab
   * already belongs to the folder (or is the Files tab), attach its first
   * session — the host's accessed sort puts the most recent one on top, the
   * same row the desktop's restored workspace lands on.
   */
  openFolder(key: string): void {
    const dir = this.state.roots.flatMap((r) => r.directories).find((d) => d.key === key);
    if (!dir) return;
    const activeKey = this.state.activeKey;
    const inFolder =
      activeKey !== null &&
      (activeKey === 'files' ||
        dir.rows.some((r) => `apx:${r.session.aplexerId ?? ''}` === activeKey));
    this.patch({ activeFolder: key });
    this.rememberFolder(key);
    if (!inFolder && dir.rows.length > 0) {
      const first = dir.rows[0]!;
      const row = this.state.rows.find((r) => r.id === (first.session.aplexerId ?? ''));
      if (row) void this.openSession(row);
    }
  }

  private hasFolder(key: string): boolean {
    return this.state.roots.some((r) => r.directories.some((d) => d.key === key));
  }

  /** The folder key a session id files under, or null when the tree has none. */
  private folderKeyForSession(id: string): string | null {
    for (const root of this.state.roots) {
      for (const dir of root.directories) {
        if (dir.rows.some((r) => (r.session.aplexerId ?? '') === id)) return dir.key;
      }
    }
    return null;
  }

  private folderMemoryKey(): string {
    const { user, host, port } = this.deps.link;
    return `ps.folder:${user}@${host}:${port}`;
  }

  private rememberFolder(key: string): void {
    try {
      localStorage.setItem(this.folderMemoryKey(), key);
    } catch {
      // No storage (private mode, tests) — the memory just does not persist.
    }
  }

  private recallFolder(): string | null {
    try {
      return localStorage.getItem(this.folderMemoryKey());
    } catch {
      return null;
    }
  }

  /** Show a session's terminal: attach through `a attach` on a fresh PTY. */
  async openSession(row: SessionRow): Promise<void> {
    const key = `apx:${row.id}`;
    const existing = this.state.tabs.find((t) => t.key === key);
    if (existing) {
      this.setActive(key);
      return;
    }
    if (this.state.actionBusy) return;
    this.patch({ actionBusy: true, actionError: '' });
    try {
      const channel = await this.conn.openPty({
        // Exec-with-PTY: the join IS the channel, the way the desktop's
        // 'exec' command mode works — no login shell before the session.
        command: aplexerAttachCommand({ id: row.id }),
        onData: (bytes) => {
          this.armFirstData(key);
          for (const cb of this.dataListeners) cb(key, bytes);
        },
        onExit: () => this.onChannelClosed(key),
        onError: () => {},
      });
      this.channels.set(key, channel);
      this.patch({
        tabs: [
          ...this.state.tabs,
          {
            key,
            label: row.tag,
            subtitle: leafOf(row.workspace),
            engine: row.engine,
            phase: row.phase,
            live: true,
          },
        ],
        activeKey: key,
        // A session opened from anywhere (create flow, tab restore) files its
        // folder in: the sidebar marks that row, not the previously open one.
        activeFolder: this.folderKeyForSession(row.id) ?? this.state.activeFolder,
      });
    } catch (e) {
      this.patch({
        actionError: `Could not join "${row.tag}" — ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    } finally {
      this.patch({ actionBusy: false });
    }
  }

  /** The Files tab — an SFTP browser over the live connection, not a PTY.
   * One per workspace; the pane itself is the view's (it owns xterm-less
   * state), the controller only owns the tab and the connection. */
  openFilesTab(): void {
    const key = 'files';
    if (this.state.tabs.some((t) => t.key === key)) {
      this.setActive(key);
      return;
    }
    this.patch({
      tabs: [
        ...this.state.tabs,
        { key, label: 'Files', subtitle: 'sftp', engine: 'sftp', phase: 'idle', live: false },
      ],
      activeKey: key,
    });
  }

  /** The live connection, for view-owned transports (the Files pane's
   * SFTP) that must share the workspace's one dial. */
  get connection(): SshConnection {
    return this.conn;
  }

  /** The no-aplexer path's single raw shell tab. */
  async openShellTab(): Promise<void> {
    const key = 'shell';
    if (this.state.tabs.some((t) => t.key === key)) {
      this.setActive(key);
      return;
    }
    const channel = await this.conn.openPty({
      onData: (bytes) => {
        this.armFirstData(key);
        for (const cb of this.dataListeners) cb(key, bytes);
      },
      onExit: () => this.onChannelClosed(key),
      onError: () => {},
    });
    this.channels.set(key, channel);
    this.patch({
      tabs: [
        ...this.state.tabs,
        { key, label: 'shell', subtitle: '', engine: 'shell', phase: 'running', live: true },
      ],
      activeKey: key,
    });
  }

  setActive(key: string): void {
    if (this.state.tabs.some((t) => t.key === key)) this.patch({ activeKey: key });
  }

  closeTab(key: string): void {
    this.channels.get(key)?.close();
    this.channels.delete(key);
    const tabs = this.state.tabs.filter((t) => t.key !== key);
    const activeKey =
      this.state.activeKey === key ? (tabs.at(-1)?.key ?? null) : this.state.activeKey;
    this.patch({ tabs, activeKey });
  }

  /**
   * Create a session in [workspace] under [tag], refresh, and open it.
   * The host has the final say on the tag (it echoes what it used).
   */
  async createSession(workspace: string, tag: string): Promise<AplexerStartOutcome> {
    this.patch({ actionBusy: true, actionError: '' });
    let outcome: AplexerStartOutcome;
    try {
      outcome = await this.client.startSession({ workspace, tag });
      if (!outcome.ok && !outcome.liveRefusal) {
        this.patch({ actionError: outcome.error ?? 'could not create the session' });
        return outcome;
      }
      await this.refreshSessions();
    } finally {
      this.patch({ actionBusy: false });
    }
    const created = this.state.rows.find(
      (r) =>
        (outcome.id !== null && r.id === outcome.id) ||
        (r.workspace === workspace && r.tag === (outcome.tag ?? tag)),
    );
    if (created) await this.openSession(created);
    else if (outcome.liveRefusal) {
      // The pair was already live before we asked; find and open it.
      const live = this.state.rows.find((r) => r.workspace === workspace && r.tag === tag);
      if (live) await this.openSession(live);
    }
    return outcome;
  }

  /** Stop a session: signal the workload and drop the record. */
  async killSession(row: SessionRow): Promise<void> {
    this.patch({ actionBusy: true, actionError: '' });
    try {
      const outcome = await this.client.killSession(row.id);
      if (!outcome.ok && !outcome.notFound) {
        this.patch({ actionError: outcome.error ?? 'could not stop the session' });
        return;
      }
      await this.refreshSessions();
    } finally {
      this.patch({ actionBusy: false });
    }
  }

  /** Rename a session's tag within its workspace. */
  async renameSession(row: SessionRow, tag: string): Promise<void> {
    this.patch({ actionBusy: true, actionError: '' });
    try {
      const outcome = await this.client.renameSession(row.id, tag);
      if (!outcome.ok && !outcome.notFound) {
        this.patch({ actionError: outcome.error ?? 'could not rename the session' });
        return;
      }
      const key = `apx:${row.id}`;
      this.patch({
        tabs: this.state.tabs.map((t) => (t.key === key ? { ...t, label: tag } : t)),
      });
      await this.refreshSessions();
    } finally {
      this.patch({ actionBusy: false });
    }
  }

  async ackWarning(sessionId: string): Promise<void> {
    this.patch({ actionBusy: true });
    try {
      await this.client.ackWarnings(sessionId);
      await this.refreshWarnings();
    } finally {
      this.patch({ actionBusy: false });
    }
  }

  async ackAllWarnings(): Promise<void> {
    this.patch({ actionBusy: true });
    try {
      await this.client.ackWarnings();
      await this.refreshWarnings();
    } finally {
      this.patch({ actionBusy: false });
    }
  }

  /** One manual poll tick (the refresh button; the timer owns the rest). */
  async refresh(): Promise<void> {
    await Promise.all([this.refreshSessions(), this.refreshWarnings()]);
  }

  /** Pause/resume the poll — the view parks it while the tab is hidden. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused && this.state.phase === 'ready') {
      void this.refresh().then(() => this.schedulePoll());
    }
  }

  /** The open tab's channel resizes with its terminal. */
  resizeTab(key: string, cols: number, rows: number): void {
    this.channels.get(key)?.resize(rows, cols);
  }

  /** Keystrokes for one tab's PTY. */
  writeToTab(key: string, text: string): void {
    this.channels.get(key)?.write(text);
  }

  /**
   * Composer delivery: like writeToTab but reports whether the write could
   * land, so a dead session refuses a send instead of silently eating it.
   */
  deliverToTab(key: string, text: string): boolean {
    const channel = this.channels.get(key);
    if (!channel) return false;
    channel.write(text);
    return true;
  }

  /**
   * Ask the host which agents its `pocketshell` helper can start, and what
   * profiles it has. Deliberately NOT cached: the desktop re-probes each time
   * the picker opens (one `--help` exec that does no work host-side) so a
   * helper upgraded mid-connection is offered without a reconnect. Re-entrancy
   * is folded into the in-flight call rather than rejected — two opens racing
   * is the benign case, and both should settle with the same answer.
   */
  async probeAgent(): Promise<void> {
    if (this.state.agentProbing) return;
    this.patch({ agentProbing: true });
    try {
      const [support, profiles] = await Promise.all([this.probe.agentSupport(), this.probe.listProfiles()]);
      this.patch({ agentSupport: support, agentProfiles: profiles });
    } finally {
      this.patch({ agentProbing: false });
    }
  }

  /**
   * Create a session in [workspace] under [tag] and launch the picked agent
   * in it — the web twin of the desktop's create-then-type pipeline
   * (useSessionLaunch.ts), in one place because the workspace owns both ends:
   * the desktop needs the parked-slot machinery only because its panel and
   * its terminals live in different components.
   *
   * The launch is gated by `launchBlocker` BEFORE the session is created,
   * which is the whole point: a launch that cannot work should cost nothing,
   * not leave a shell plus a usage message. The line itself is typed once the
   * new PTY shows life, through the helper's wrapper (`pocketshell agent …`,
   * built by shared/agentLaunch.ts against the captured `--help` — never a
   * bare `claude`/`codex`, which no host records as an agent session).
   *
   * A PTY that never comes up gets the desktop's remedy, not a rollback: the
   * session is real either way, so the user gets the exact line to paste,
   * never a silent "I asked for Claude and got a shell".
   */
  async launchAgentSession(
    choice: LaunchChoice,
    workspace: string,
    tag: string,
  ): Promise<AplexerStartOutcome> {
    const blocker = launchBlocker(choice, this.state.agentSupport ?? undefined);
    if (blocker !== null) {
      this.patch({ actionError: blocker });
      return { ok: false, id: null, tag: null, liveRefusal: false, error: blocker };
    }
    const outcome = await this.createSession(workspace, tag);
    if (!outcome.ok) return outcome;
    const key = this.keyForCreated(outcome, workspace, tag);
    if (key === null) return outcome;
    const line = buildLaunchCommand(choice);
    const cameUp = await this.waitForFirstData(key, this.launchTimeoutMs);
    if (!cameUp) {
      this.patch({
        actionError:
          `Started "${outcome.tag ?? tag}", but its terminal did not come up in time, so ` +
          `${KIND_LABELS[choice.kind]} was not launched. The session is a plain shell - run ` +
          `\`${line}\` in it to start the agent.`,
      });
      return outcome;
    }
    // One write, line and Enter together — the desktop's launch shape. The
    // composer's bracketed-paste framing is for agent REPLs mid-conversation;
    // this line lands in a plain shell where the framing would be noise.
    const channel = this.channels.get(key);
    if (!channel) {
      // The PTY spoke and died between the wait and this write. Same remedy.
      this.patch({
        actionError:
          `Started "${outcome.tag ?? tag}", but its terminal closed before ` +
          `${KIND_LABELS[choice.kind]} could be launched. The session is a plain shell - run ` +
          `\`${line}\` in a new tab to start the agent.`,
      });
      return outcome;
    }
    channel.write(`${line}\r`);
    return outcome;
  }

  dismissActionError(): void {
    this.patch({ actionError: '' });
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    for (const resolve of this.firstData.values()) resolve();
    this.firstData.clear();
    for (const channel of this.channels.values()) {
      try {
        channel.close();
      } catch {
        // closing twice is fine
      }
    }
    this.channels.clear();
    this.conn.close();
    this.listeners.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  // --- internals -----------------------------------------------------------

  /** Resolve the one armed launch wait for [key], if any. */
  private armFirstData(key: string): void {
    const resolve = this.firstData.get(key);
    if (resolve) {
      this.firstData.delete(key);
      resolve();
    }
  }

  /**
   * Wait for the tab's PTY to show life (its first bytes — the attach
   * repaint), or null at the deadline. The launch types only into a terminal
   * that has spoken; typing blind races the attach and shreds the line.
   */
  private waitForFirstData(key: string, timeoutMs: number): Promise<boolean> {
    if (this.channels.has(key) === false) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.firstData.delete(key);
        resolve(false);
      }, timeoutMs);
      this.firstData.set(key, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** The tab key a created session opened under, or null when none did. */
  private keyForCreated(
    outcome: AplexerStartOutcome,
    workspace: string,
    tag: string,
  ): string | null {
    if (outcome.id !== null && outcome.id !== '') {
      const key = `apx:${outcome.id}`;
      if (this.state.tabs.some((t) => t.key === key)) return key;
    }
    const wantedTag = outcome.tag ?? tag;
    const row = this.state.rows.find((r) => r.workspace === workspace && r.tag === wantedTag);
    if (row && row.id !== '' && this.state.tabs.some((t) => t.key === `apx:${row.id}`)) {
      return `apx:${row.id}`;
    }
    return null;
  }

  private schedulePoll(): void {
    if (this.disposed || this.pollTimer !== null) return;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (this.disposed || this.paused || this.state.phase !== 'ready') return;
      await this.refresh();
      this.patch({ tick: this.state.tick + 1 });
      this.schedulePoll();
    }, this.pollMs);
  }

  private async refreshSessions(): Promise<void> {
    const summaries = await this.client.listSessions();
    if (summaries === null) {
      // No aplexer (the probe already said so) or the probe raced a
      // disconnect — either way the sidebar stays empty, not an error.
      this.patch({ roots: [], home: null, rows: [] });
      return;
    }
    // The same `$HOME` answer the grouping uses internally, kept in state so
    // the root `+`s can prefill absolute paths (the picker needs a real
    // directory, `~/git` is a shell expansion).
    const home = inferHome(summaries.map((s) => s.path));
    const roots = groupSessionsIntoRoots(summaries, home, []);
    const rows = summaries.map(summaryToRow);
    this.patch({ rows, roots, home });
    this.syncTabsWithRows(rows);
  }

  private async refreshWarnings(): Promise<void> {
    const warnings = await this.client.listWarnings();
    // An exec that failed and an empty host look the same ([]); the panel
    // shows what it got and the stale flag stays off — the desktop's
    // contract for this endpoint is total ([] on any failure), because a
    // warning list the renderer can be denied is a crash it can be denied.
    this.patch({ warnings, warnStale: false });
  }

  /**
   * Tab chrome follows the snapshot: engine/phase refresh, dead rows mark
   * their tab `gone`, vanished-but-open tabs stay open (their channel will
   * exit on its own and close then).
   */
  private syncTabsWithRows(rows: SessionRow[]): void {
    this.patch({
      tabs: this.state.tabs.map((tab) => {
        if (!tab.key.startsWith('apx:')) return tab;
        const row = rows.find((r) => tab.key === `apx:${r.id}`);
        if (!row) return { ...tab, phase: 'gone' };
        return { ...tab, label: row.tag, subtitle: leafOf(row.workspace), engine: row.engine, phase: row.phase };
      }),
    });
  }

  private onChannelClosed(key: string): void {
    this.channels.delete(key);
    this.patch({
      tabs: this.state.tabs.map((t) => (t.key === key ? { ...t, live: false } : t)),
    });
    for (const cb of this.exitListeners) cb(key);
  }

  private onConnectionClosed(): void {
    if (this.disposed) return;
    this.channels.clear();
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.patch({
      status: 'disconnected',
      tabs: this.state.tabs.map((t) => ({ ...t, live: false })),
    });
  }

  private patch(part: Partial<ControllerState>): void {
    this.state = { ...this.state, ...part };
    for (const cb of this.listeners) cb(this.state);
  }
}

function summaryToRow(s: SessionSummary): SessionRow {
  return {
    id: s.aplexerId ?? '',
    tag: s.tag ?? s.name,
    workspace: s.workspace ?? s.path ?? '',
    engine: s.agentKind ?? 'shell',
    phase: s.aplexerPhase ?? 'running',
    createdMs: s.created * 1000,
    activityMs: s.activity * 1000,
  };
}

/** The trailing path component, the tab subtitle (`~/git/mixer` -> mixer). */
export function leafOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return '/';
  const slash = trimmed.lastIndexOf('/');
  const leaf = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return leaf === '~' || leaf === '' ? trimmed : leaf;
}
