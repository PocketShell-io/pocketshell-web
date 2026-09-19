/**
 * The pure half of the aplexer warnings contract — the `AplexerWarning`
 * shape, the JSON parser, and the compact age formatter. Split from
 * `warnings.ts` so the exec-channel client (`client.ts`) can share the exact
 * parser without importing that file's ephemeral-bridge runner.
 */
export interface AplexerWarning {
  session: string;
  workspace: string;
  tag: string;
  engine: string;
  kind: 'oom' | 'crash';
  detail: string;
  created_at_ms: number;
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
