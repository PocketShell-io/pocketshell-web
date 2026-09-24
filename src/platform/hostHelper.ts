/**
 * The web's helper group: the browser twin of the desktop's bootstrap probe
 * (src/main/helper/bootstrap.ts) and PocketshellClient session surface,
 * running the SAME host commands through the web transport's exec channel
 * and parsing them with the SAME core parsers (hostProbeParsers,
 * usageParsers, aplexerClientCore).
 *
 * The one deliberate narrowing, inherited from the web's transport: the
 * desktop's listSessions enrichment (cwd probes, the tree registry, worktree
 * remaps) is not ported. The aplexer arm — the whole list wherever `a` is
 * installed, which is every host this app targets — is byte-identical. A
 * helper-less host falls back to the raw tmux `::` listing without the
 * enrichment columns, which groups by name exactly as the phone's fallback
 * does.
 */
import type { AplexerWarning, BootstrapResult, ExecResult, SessionSummary, ToolState, UsageRow } from '@pocketshell/core';
import { pathAwareCommand } from '@pocketshell/core';
import {
  firstNonEmptyLine,
  parseCommandV,
  parseTmuxListSessionsFallback,
  parseUsageNdjson,
  isHelperMissing,
  annotateHelperRejection,
  createSessionCommand,
  fallbackCreateSessionCommand,
} from '@pocketshell/core';
import { AplexerClient } from '../aplexer/client';
import type { ExecOutcome, SshConnection } from '../terminal/connection';

/** Wrap a command so user-bin locations are on PATH even under a non-login sshd. */
export { pathAwareCommand };

function toExecResult(outcome: ExecOutcome): ExecResult {
  return { exitCode: outcome.exitCode ?? -1, stdout: outcome.stdout, stderr: outcome.stderr };
}

/** Probe one tool: `command -v <binary>` under the path-aware shell. */
async function probeTool(
  exec: (command: string) => Promise<ExecResult>,
  binary: string,
): Promise<ToolState> {
  const res = await exec(pathAwareCommand(`command -v ${binary}`));
  const path = parseCommandV(res.stdout, res.exitCode);
  if (!path) return { installed: false, path: null, version: null };
  const versionRes = await exec(pathAwareCommand(`${binary} --version`));
  const version = versionRes.exitCode === 0 ? versionRes.stdout.trim().split(/\r?\n/)[0] : null;
  return { installed: true, path, version: version ?? null };
}

/** Detect the python installer: `command -v uv` then `command -v pipx`. */
async function detectInstaller(
  exec: (command: string) => Promise<ExecResult>,
): Promise<'uv' | 'pipx' | null> {
  for (const binary of ['uv', 'pipx'] as const) {
    const res = await exec(pathAwareCommand(`command -v ${binary}`));
    if (parseCommandV(res.stdout, res.exitCode)) return binary;
  }
  return null;
}

/** Wrap a `systemctl --user` command with the env vars systemd needs over SSH. */
function systemdUserCommand(command: string): string {
  const env =
    `XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)} ` +
    `DBUS_SESSION_BUS_ADDRESS=unix:path=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus`;
  return pathAwareCommand(`export ${env}; ${command}`);
}

/**
 * The host bootstrap probe — the same sequence the Android HostBootstrapper
 * and the desktop main run on connect: the `pocketshell` helper, the tmux
 * join binary (`tmuxctl`), raw tmux, and `a` (the MAIN session manager when
 * present), plus the installer and the daemon state. Never throws.
 */
export async function runBootstrap(
  exec: (command: string) => Promise<ExecResult>,
): Promise<BootstrapResult> {
  const [pocketshell, tmuxctl, tmux, aplexer, installer] = await Promise.all([
    probeTool(exec, 'pocketshell'),
    probeTool(exec, 'tmuxctl'),
    probeTool(exec, 'tmux'),
    probeTool(exec, 'a'),
    detectInstaller(exec),
  ]);

  let daemonRunning: boolean | null = null;
  let daemonEnabled: boolean | null = null;
  if (pocketshell.installed) {
    const systemctlRes = await exec(pathAwareCommand('command -v systemctl'));
    if (parseCommandV(systemctlRes.stdout, systemctlRes.exitCode)) {
      const active = await exec(
        systemdUserCommand('systemctl --user is-active pocketshell-jobs.service'),
      );
      daemonRunning = active.exitCode === 0;
      const enabled = await exec(
        systemdUserCommand('systemctl --user is-enabled pocketshell-jobs.service'),
      );
      daemonEnabled = enabled.exitCode === 0;
    }
  }

  return { pocketshell, tmuxctl, tmux, aplexer, installer, daemonRunning, daemonEnabled };
}

const TMUX_FALLBACK_LIST_COMMAND =
  "tmux list-sessions -F '#{session_name}::#{session_created}::#{session_activity}::#{session_attached}::#{session_path}'";

/** The panel order for a LEGACY list: creation order, oldest first, name tiebreak. */
function byCreationOrder(a: SessionSummary, b: SessionSummary): number {
  const byCreated = (a.created || a.activity || 0) - (b.created || b.activity || 0);
  if (byCreated !== 0) return byCreated;
  return a.name.localeCompare(b.name);
}

/**
 * One connection's helper surface: an aplexer core over the connection plus
 * the direct exec probes. Constructed per connection id by webApi; `evict`
 * drops the cached aplexer state on disconnect.
 */
export class HostHelper {
  readonly aplexer: AplexerClient;

  constructor(private readonly conn: SshConnection) {
    this.aplexer = new AplexerClient(conn);
  }

  private async exec(command: string): Promise<ExecResult> {
    return toExecResult(await this.conn.exec(command));
  }

  /** `helper.bootstrap` — never throws. */
  bootstrap(): Promise<BootstrapResult> {
    return runBootstrap((command) => this.exec(command));
  }

  /**
   * The live session list, already in the order the panel shows it. Aplexer
   * is the whole list wherever `a` answers; a helper-less host falls back to
   * the raw tmux `::` listing sorted by creation order; no server of either
   * kind is the ordinary empty state.
   */
  async listSessions(sortBy: 'activity' | 'created' = 'activity'): Promise<SessionSummary[]> {
    // The aplexer arm is the host's own sort, untouched — the panel order
    // contract (SESSIONLIST.md §6.0); `sortBy` only shapes the legacy arms.
    void sortBy;
    const aplexerRows = await this.aplexer.listSessions();
    if (aplexerRows !== null) return aplexerRows;
    const tmux = await this.exec(TMUX_FALLBACK_LIST_COMMAND);
    if (tmux.exitCode === 0) {
      return parseTmuxListSessionsFallback(tmux.stdout).sort(byCreationOrder);
    }
    return [];
  }

  /**
   * Explicit-name create. The folder-first flow goes through the projects
   * group; this is for a caller that already knows the exact tmux session
   * name it wants (and it must supply the cwd). Same helper-first,
   * raw-tmux-fallback spelling as the desktop's createSession.
   */
  async createSession(name: string, cwd: string): Promise<boolean> {
    const res = await this.exec(pathAwareCommand(createSessionCommand(name, cwd)));
    if (res.exitCode === 0) return true;
    const output = `${res.stdout}\n${res.stderr}`;
    if (!isHelperMissing(res.exitCode, output)) return false;
    const fallback = await this.exec(pathAwareCommand(fallbackCreateSessionCommand(name, cwd)));
    return fallback.exitCode === 0;
  }

  /**
   * Provider quota via `pocketshell usage --json`. `[]` means the host
   * answered and had nothing to report (or has no helper at all); a command
   * that RAN and failed throws with the host's own line — the distinction
   * the shared usage panel's error state is built on.
   */
  async usage(): Promise<UsageRow[]> {
    const res = await this.exec(pathAwareCommand('pocketshell usage --json'));
    if (res.exitCode === 0) return parseUsageNdjson(res.stdout);
    const output = `${res.stdout}\n${res.stderr}`;
    if (isHelperMissing(res.exitCode, output)) return [];
    const hostMessage =
      res.stderr.trim() || res.stdout.trim() || `pocketshell usage exited ${res.exitCode}`;
    throw new Error(annotateHelperRejection(hostMessage, output));
  }

  /** Unacknowledged aplexer crash/OOM warnings — total ([] on any failure). */
  warnings(): Promise<AplexerWarning[]> {
    return this.aplexer.listWarnings();
  }

  ackWarnings(target?: string) {
    return this.aplexer.ackWarnings(target);
  }

  /** The echoed answer line a create/clone printed, or null. */
  firstLine(stdout: string): string | null {
    return firstNonEmptyLine(stdout);
  }

  evict(): void {
    this.aplexer.evict();
  }
}
