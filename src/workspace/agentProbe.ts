/**
 * The `pocketshell` helper's agent capability probe — the browser twin of the
 * desktop's `PocketshellClient.agentSubcommands` / `listProfiles`, running the
 * same commands through the shared connection's exec channel and parsing with
 * the same rules (`cliParsers.ts::parseAgentSubcommands`, ported verbatim).
 *
 * The launch picker asks the HOST which subcommands its helper has before
 * offering one: the helper is a separately released project and this app's
 * pinned 0.4.44 has no `grok`, so a guessed offer creates the session, exits 2,
 * and leaves the user in a plain shell. See shared/agentLaunch.ts for why the
 * answer is read from `--help` text rather than a version comparison, and why
 * null (we never got an answer) must not be flattened into [] (a host claiming
 * it can launch nothing).
 *
 * Like the desktop, nothing here is cached on the connection: the probe is one
 * exec of a `--help` that does no work host-side, run when the launch UI opens,
 * so a helper upgraded while the tab is connected starts offering the new
 * engine without a reconnect.
 */
import { pathAwareCommand } from '../shared/aplexerCommands';
import {
  parseProfileRows,
  type AgentProfile,
  type HostAgentSupport,
} from '../shared/agentLaunch';
import type { ExecOutcome } from '../terminal/connection';

/** The one thing the probe needs from a connection — AplexerClient's shape. */
export interface ExecTransport {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecOutcome>;
}

/**
 * The `Commands:` block of `pocketshell agent --help`, or null when there is
 * no answer: non-zero exit, no header, or a header with nothing parseable
 * under it. Ported verbatim from the desktop's cliParsers.ts so the two
 * clients can never disagree about what a host said.
 */
export function parseAgentSubcommands(stdout: string, exitCode: number): string[] | null {
  if (exitCode !== 0) return null;
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line));
  if (start < 0) return null;
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    // Back at the left margin: a new `--help` section, so the block is over.
    if (!/^\s/.test(line)) break;
    const match = /^ {2}(\S+)(?: {2,}\S|\s*$)/.exec(line);
    if (match) names.push(match[1]!);
  }
  return names.length > 0 ? names : null;
}

/**
 * The rows of `pocketshell profiles list --json`: 0.4.44's `{"profiles":
 * [...]}` ENVELOPE. The bare array the stale v0.4.8 docs described is not
 * accepted — a second accepted shape is a second thing that can silently
 * return [] without anyone noticing which branch ran. [] on any failure, the
 * same total contract as the desktop's listProfiles.
 */
export function parseProfilesEnvelope(stdout: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    const envelope = (parsed as { profiles?: unknown } | null)?.profiles;
    return Array.isArray(envelope) ? (envelope as unknown[]) : [];
  } catch {
    return [];
  }
}

/** First line of `pocketshell --version`, or null — refusal flavour only. */
export function parseHelperVersion(stdout: string): string | null {
  const line = stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line === '' ? null : line;
}

export class PocketshellProbe {
  constructor(private readonly transport: ExecTransport) {}

  /**
   * What this host's `pocketshell agent` can start, as far as we were able to
   * ask. Never throws: a transport failure is the same "we could not ask" the
   * desktop answers, and `kindUnavailableReason` owns the sentence.
   */
  async agentSupport(): Promise<HostAgentSupport> {
    // `--version` rides along for the refusal's flavour only ("this host runs
    // …"); its failure never decides anything, so the pair is raced, not joined.
    const [help, version] = await Promise.all([
      this.tryExec(pathAwareCommand('pocketshell agent --help')),
      this.tryExec(pathAwareCommand('pocketshell --version')),
    ]);
    return {
      // A null exitCode is a transport that never got an exit — the same "we
      // could not ask" as a failed exec, never fed to the parser as 0.
      subcommands:
        help && help.exitCode !== null ? parseAgentSubcommands(help.stdout, help.exitCode) : null,
      helperVersion: version ? parseHelperVersion(version.stdout) : null,
    };
  }

  /** Agent config-dir profiles for the picker, [] on any failure. Never throws. */
  async listProfiles(): Promise<AgentProfile[]> {
    const res = await this.tryExec(pathAwareCommand('pocketshell profiles list --json'));
    if (!res || res.exitCode !== 0) return [];
    return parseProfileRows(parseProfilesEnvelope(res.stdout));
  }

  private async tryExec(
    command: string,
  ): Promise<ExecOutcome | null> {
    try {
      return await this.transport.exec(command);
    } catch {
      return null;
    }
  }
}
