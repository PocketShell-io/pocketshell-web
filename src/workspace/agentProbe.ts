/** The host's live aplexer engine catalog. Re-query when the launch picker
 * opens, so installed/custom engines appear without reconnecting. A failed
 * query is null; a successful catalog with no available engines is []. */
import { pathAwareCommand } from '@pocketshell/core';
import {
  parseProfileRows,
  type AgentProfile,
  type HostAgentSupport,
} from '@pocketshell/core';
import type { ExecOutcome } from '../terminal/connection';

/** The one thing the probe needs from a connection — AplexerClient's shape. */
export interface ExecTransport {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecOutcome>;
}

export function parseEngineCatalog(stdout: string, exitCode: number): string[] | null {
  if (exitCode !== 0) return null;
  try {
    const rows:unknown=JSON.parse(stdout);
    if(!Array.isArray(rows))return null;
    const names=rows.map(row=>{
      if(!row || typeof row !== 'object' || Array.isArray(row))throw new Error('Malformed engine catalog');
      const name=typeof row.name === 'string' ? row.name.trim() : '';
      if(!name || typeof row.available !== 'boolean')throw new Error('Malformed engine catalog');
      return row.available && name !== 'shell' ? name : '';
    });
    return [...new Set(names.filter(Boolean))];
  }catch{return null;}
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

export class PocketshellProbe {
  constructor(private readonly transport: ExecTransport) {}

  /**
   * What this host's aplexer catalog can start, as far as we were able to
   * ask. Never throws: a transport failure is the same "we could not ask" the
   * desktop answers, and `kindUnavailableReason` owns the sentence.
   */
  async agentSupport(): Promise<HostAgentSupport> {
    const result=await this.tryExec(pathAwareCommand('a engines --json'));
    return {engineIds:result && result.exitCode !== null ? parseEngineCatalog(result.stdout,result.exitCode) : null};
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
