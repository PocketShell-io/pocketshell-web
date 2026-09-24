/**
 * The web's agent group: `pocketshell agent --help` / `profiles list` ride
 * the existing PocketshellProbe (same commands, same parsers), and the env
 * verbs here are the browser twin of the desktop's (PocketshellClient
 * envList/envGet/envSet) — same command lines, same write-only default (rows
 * carry names, never values), values on stdin so they never sit on a
 * `ps`-readable command line.
 */
import type { EnvVarRow } from '@pocketshell/core';
import { parseEnvVarRow, pathAwareCommand, shellQuote, shellQuoteRemotePath } from '@pocketshell/core';
import type { SshConnection } from '../terminal/connection';
import { PocketshellProbe } from '../workspace/agentProbe';

function toExecResult(outcome: { exitCode: number | null; stdout: string; stderr: string }) {
  return { exitCode: outcome.exitCode ?? -1, stdout: outcome.stdout, stderr: outcome.stderr };
}

export class AgentService {
  private readonly probe: PocketshellProbe;

  constructor(private readonly conn: SshConnection) {
    this.probe = new PocketshellProbe(conn);
  }

  /** Which engines this host's helper can launch, or null (we never got an
   * answer) — never flattened into [] (a host claiming it can start nothing). */
  kinds() {
    return this.probe.agentSupport().then((support) => support.subcommands);
  }

  /** Agent config-dir profiles for the picker, [] on any failure. */
  profiles() {
    return this.probe.listProfiles();
  }

  /** Env keys for a folder — names only, never values (write-only default). */
  async envList(dir: string): Promise<EnvVarRow[]> {
    const res = toExecResult(
      await this.conn.exec(pathAwareCommand(`pocketshell env list --dir ${shellQuoteRemotePath(dir)} --json`)),
    );
    if (res.exitCode !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(res.stdout.trim());
      return Array.isArray(parsed)
        ? parsed.map(parseEnvVarRow).filter((row): row is EnvVarRow => row != null)
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Env values for a folder. `--key` is REQUIRED and repeatable on 0.4.44 —
   * omitting it exits 2 (measured on the fixture, the desktop's note stands).
   * With no [keys] the whole env is read the two calls the write-only
   * default forces: list the names, then one get revealing them.
   */
  async envGet(dir: string, keys?: string[]): Promise<Record<string, string>> {
    const wanted = keys?.length ? [...keys] : await this.envKeyNames(dir);
    if (wanted.length === 0) return {};
    const keyArgs = wanted.map((key) => `--key ${shellQuote(key)}`).join(' ');
    const res = toExecResult(
      await this.conn.exec(
        pathAwareCommand(`pocketshell env get --dir ${shellQuoteRemotePath(dir)} ${keyArgs} --json`),
      ),
    );
    if (res.exitCode !== 0) return {};
    try {
      const parsed: unknown = JSON.parse(res.stdout.trim());
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Set env values for a folder — a JSON object on STDIN (secrets via stdin,
   * never argv), rewritten surgically by the helper. Throws with the host's
   * own message on failure: a write that failed must not look like one that
   * succeeded.
   */
  async envSet(dir: string, values: Record<string, string>, file?: string): Promise<void> {
    if (Object.keys(values).length === 0) return;
    const fileArg = file ? ` --file ${shellQuote(file)}` : '';
    const res = toExecResult(
      await this.conn.exec(
        pathAwareCommand(`pocketshell env set --dir ${shellQuoteRemotePath(dir)}${fileArg}`),
        { stdin: JSON.stringify(values) },
      ),
    );
    if (res.exitCode !== 0) {
      const hostMessage =
        res.stderr.trim() || res.stdout.trim() || `pocketshell env set exited ${res.exitCode}`;
      throw new Error(hostMessage);
    }
  }

  /** The `key` field of every envList row, deduped and in order. */
  private async envKeyNames(dir: string): Promise<string[]> {
    const rows = await this.envList(dir);
    const names: string[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const key = (row as { key?: unknown }).key;
      if (typeof key === 'string' && key.length > 0 && !names.includes(key)) names.push(key);
    }
    return names;
  }
}
