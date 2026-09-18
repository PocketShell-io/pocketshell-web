/**
 * Crash/OOM warnings from the host's aplexer CLI, per issue #1: the host
 * keeps ack-gated warnings (`a warnings --json`, acknowledged with
 * `a ack <session>`); the browser is a viewer, the host's `a` is the source
 * of truth — the same zero-credentials principle as the usage panel.
 *
 * The bridge has no exec channel, only an interactive PTY, so the runner
 * opens an ephemeral second bridge connection (its own fresh shell), types
 * one command line tagged with a per-call nonce, and reads what lands
 * between the two printed sentinels. A host without `a` (or with an `a`
 * too old to know `warnings`) prints its usual "command not found" between
 * the sentinels, the JSON parse fails, and the caller gets `null` — the UI
 * hides the banner quietly, exactly like a host without the usage helper.
 */
import { BridgeSession, type BridgeAuth } from '../terminal/bridge';

export interface AplexerWarning {
  session: string;
  workspace: string;
  tag: string;
  engine: string;
  kind: 'oom' | 'crash';
  detail: string;
  created_at_ms: number;
}

/** Everything the runner needs to reach one host's shell. */
export interface HostLink {
  wsUrl: string;
  idToken: string;
  host: string;
  port: number;
  user: string;
  auth: BridgeAuth;
}

/**
 * The bridge auth frame for a host's stored secret (structurally the hosts
 * store's HostSecret), or null when this browser holds no usable credential
 * for the host — without a key or password there is nothing to connect with,
 * so a sweep skips it quietly, like the terminal view's "no key attached".
 */
export function bridgeAuthOf(
  secret: { privateKeyPem?: string; password?: string; keyPassphrase?: string } | undefined,
): BridgeAuth | null {
  if ((secret?.privateKeyPem ?? '') !== '') {
    return {
      kind: 'key',
      privateKey: secret!.privateKeyPem!,
      ...(secret!.keyPassphrase ? { passphrase: secret!.keyPassphrase } : {}),
    };
  }
  if ((secret?.password ?? '') !== '') return { kind: 'password', password: secret!.password! };
  return null;
}

function shellWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The one command line the runner submits. `stty -echo` keeps every later
 * keystroke out of the transcript (the line itself still echoes — the
 * parser anchors on that); the printed GO sentinel then marks where the
 * command's own output starts, because whatever the login shell printed
 * before it (MOTD, prompt) is noise. printf runs unconditionally, so the
 * END sentinel arrives even when `a` does not exist.
 */
export function buildAplexerCommand(nonce: string, args: string[]): string {
  const quoted = args.map(shellWord).join(' ');
  return `stty -echo 2>/dev/null; printf '__PSW_${nonce}_GO__\\n'; a ${quoted}; printf '__PSW_${nonce}_END__\\n'\n`;
}

/**
 * The command's output from a raw PTY transcript, or null when either
 * sentinel is missing. The echoed command line contains both markers as
 * literal text (the `\n` in its printf arguments is two characters), so
 * the GO anchor is the LAST occurrence — the printed one — and the END
 * search only starts after it. One trailing `\r\n` (or bare `\n`) is
 * stripped: it is the line terminator the shell put between the command's
 * output and the END sentinel, and any earlier newlines in the output are
 * kept verbatim.
 */
export function extractMarkedOutput(transcript: string, nonce: string): string | null {
  const go = `__PSW_${nonce}_GO__`;
  const end = `__PSW_${nonce}_END__`;
  const goIdx = transcript.lastIndexOf(go);
  if (goIdx < 0) return null;
  const newline = transcript.indexOf('\n', goIdx);
  if (newline < 0) return null;
  const start = newline + 1;
  const endIdx = transcript.indexOf(end, start);
  if (endIdx < 0) return null;
  let stop = endIdx;
  if (transcript[stop - 1] === '\n') {
    stop -= 1;
    if (transcript[stop - 1] === '\r') stop -= 1;
  }
  return transcript.slice(start, stop);
}

function coerceWarning(row: unknown): AplexerWarning | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r['session'] !== 'string' ||
    typeof r['workspace'] !== 'string' ||
    typeof r['tag'] !== 'string' ||
    typeof r['engine'] !== 'string' ||
    (r['kind'] !== 'oom' && r['kind'] !== 'crash') ||
    typeof r['detail'] !== 'string' ||
    typeof r['created_at_ms'] !== 'number' ||
    !Number.isFinite(r['created_at_ms'])
  ) {
    return null;
  }
  return {
    session: r['session'],
    workspace: r['workspace'],
    tag: r['tag'],
    engine: r['engine'],
    kind: r['kind'],
    detail: r['detail'],
    created_at_ms: r['created_at_ms'],
  };
}

/**
 * Parse `a warnings --json` output: an array of warning rows, or null when
 * anything is off — unparseable text (including the shell's "command not
 * found"), a non-array, or a row that fails the shape check. One bad shape
 * hides the whole banner: half-showing a crash list is worse than showing
 * none. PTY carriage returns are stripped before parsing.
 */
export function parseWarningsJson(text: string): AplexerWarning[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/\r/g, ''));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const warnings: AplexerWarning[] = [];
  for (const row of parsed) {
    const warning = coerceWarning(row);
    if (warning === null) return null;
    warnings.push(warning);
  }
  return warnings;
}

/** Compact relative age for the banner rows ("just now", "3h ago"). */
export function formatAge(nowMs: number, createdAtMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Run one `a` invocation on the host over an ephemeral bridge connection
 * and return the command's output, or null on any failure — connect error,
 * timeout, shell that died before printing both sentinels.
 */
export function runAplexer(link: HostLink, args: string[], timeoutMs = 15_000): Promise<string | null> {
  const nonce = randomNonce();
  const command = buildAplexerCommand(nonce, args);
  const endMark = `__PSW_${nonce}_END__`;
  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let transcript = '';
    let settled = false;
    let session: BridgeSession | null = null;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session?.close();
      resolve(value);
    };
    const extract = () =>
      transcript.includes(endMark) ? extractMarkedOutput(transcript, nonce) : null;
    const timer = setTimeout(() => settle(null), timeoutMs);
    session = new BridgeSession(link.wsUrl, link.idToken, {
      onData: (bytes) => {
        transcript += decoder.decode(bytes, { stream: true });
        if (transcript.includes(endMark)) settle(extractMarkedOutput(transcript, nonce));
      },
      onExit: () => settle(extract()),
      onError: () => settle(null),
    });
    session
      .open({ host: link.host, port: link.port, user: link.user, cols: 120, rows: 40, auth: link.auth })
      .then(() => session?.sendInput(command))
      .catch(() => settle(null));
  });
}

/** The host's unacknowledged warnings; null = cannot tell (hide quietly). */
export async function fetchWarnings(link: HostLink): Promise<AplexerWarning[] | null> {
  const output = await runAplexer(link, ['warnings', '--json']);
  return output === null ? null : parseWarningsJson(output);
}

/**
 * Acknowledge one warning by session id (`a ack <uuid>` — the uuid form of
 * the selector needs no quoting and no cwd). The caller confirms the ack
 * by refetching: the boolean here only says the shell ran something.
 */
export async function ackWarning(link: HostLink, sessionId: string): Promise<boolean> {
  return (await runAplexer(link, ['ack', sessionId])) !== null;
}

/** Acknowledge every warning on the host (`a ack`). */
export async function ackAllWarnings(link: HostLink): Promise<boolean> {
  return (await runAplexer(link, ['ack'])) !== null;
}
