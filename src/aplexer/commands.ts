/**
 * The `a` command lines the sessions workspace runs, and the classifiers
 * that tell a CLI refusal apart from a real failure.
 *
 * Ported from the desktop's `helper/AplexerClient.ts` command builders and
 * `helper/bootstrap.ts` PATH wrapper: same sentences matched, same quoting,
 * so the two clients can never disagree about what a host said. The
 * workspace in the browser is the aplexer arm only — hosts without `a` keep
 * today's plain-shell terminal, and the desktop's tmux fallback stays a
 * desktop path.
 */
import { USER_BIN_PATH } from '../shared/userBinPath';
import { shellEscapeInsideSingleQuotes, shellQuote, shellQuoteRemotePath } from '../shared/shellQuote';
import type { AplexerSortKey } from '../shared/aplexer';

/**
 * Wrap a command so it runs under the user's full PATH: sshd's exec channel
 * often has just `/usr/bin:/bin`, and `a` lives in `~/.local/bin`. The same
 * wrapper the desktop runs before every probe, with the same dir list
 * (shared/userBinPath.ts), so the two clients probe and join identically.
 */
export function pathAwareCommand(command: string): string {
  return `/bin/sh -lc 'export PATH="${USER_BIN_PATH}:$PATH"; ${shellEscapeInsideSingleQuotes(command)}'`;
}

/**
 * `a snapshot --json`: the machine API — the same records `a list --json`
 * prints, so the host's `--sort` applies here too. Without [sort] the host
 * applies its own default; with one the panel's order is spelled out.
 */
export function aplexerSnapshotCommand(sort?: AplexerSortKey): string {
  return sort === undefined ? 'a snapshot --json' : `a snapshot --json --sort ${sort}`;
}

/**
 * True when [stderr] is the CLI refusing a flag it does not know — the
 * argument-parser's usage error a host whose `a` predates `--sort` answers
 * with. A host sentence that merely failed ("boom", a python traceback) does
 * not match, so a transient failure is never mistaken for a missing feature.
 */
export function isAplexerUnknownFlag(stderr: string): boolean {
  return /\bunexpected argument\b|\bunrecognized\b|\bunknown option\b/i.test(stderr);
}

/**
 * `a start --workspace W --tag T`: create a shell session for a folder.
 *
 * `--json` prints the created record; a live holder is refused with exit 1
 * and `already belongs to` on stderr (see {@link isAplexerStartRefusal}).
 */
export function aplexerStartCommand(workspace: string, tag: string): string {
  return `a start --workspace ${shellQuoteRemotePath(workspace)} --tag ${shellQuote(tag)} --json`;
}

/** True when [stderr] is `a start` refusing a workspace+tag that is live. */
export function isAplexerStartRefusal(exitCode: number | null, stderr: string): boolean {
  if (exitCode === null) return false; // a transport failure is never the CLI refusing
  return exitCode !== 0 && /already belongs to/i.test(stderr);
}

/** `a kill <id>`: signal the workload and drop the record. */
export function aplexerKillCommand(id: string): string {
  return `a kill ${shellQuote(id)} --json`;
}

/** True when [stderr] is `a kill` reporting the id is already gone. */
export function isAplexerNotFound(exitCode: number | null, stderr: string): boolean {
  if (exitCode === null) return false; // a transport failure is never the CLI refusing
  return exitCode !== 0 && /no matching session/i.test(stderr);
}

/**
 * `a rename <id> --tag <new>`: change the tag within its workspace.
 *
 * By id, never by `workspace:tag`: the selector names the session being
 * changed, and a workspace path containing `:` would misparse in the
 * positional form while the id is exact by construction.
 */
export function aplexerRenameCommand(id: string, tag: string): string {
  return `a rename ${shellQuote(id)} --tag ${shellQuote(tag)}`;
}

/** `a warnings --json`: every unacknowledged crash/OOM warning on the host. */
export function aplexerWarningsCommand(): string {
  return 'a warnings --json';
}

/**
 * `a ack [TARGET]`: acknowledge warnings so they stop listing, host-side and
 * durably. Bare acks everything; a target acks one. The target is the
 * warning's session UUID, not the `workspace:tag` selector.
 */
export function aplexerAckCommand(target?: string): string {
  return target === undefined ? 'a ack' : `a ack ${shellQuote(target)}`;
}

/** True when [stderr] is `a ack` finding nothing under the given target. */
export function isAplexerAckNotFound(exitCode: number | null, stderr: string): boolean {
  if (exitCode === null) return false; // a transport failure is never the CLI refusing
  return exitCode !== 0 && /no matching unacknowledged warning/i.test(stderr);
}

/** The availability probe's inner command (the client PATH-wraps it). */
export function aplexerProbeCommand(): string {
  return 'command -v a';
}
