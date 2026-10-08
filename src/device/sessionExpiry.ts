/**
 * When a CLI session actually dies. The broker's `expires_at` is the 30-day
 * hard expiry; a session also dies 14 days after its last use
 * (`last_used_at`, which starts at `created_at`), whichever comes first.
 */
import type { CliSession } from '../api/deviceAuth';

export const IDLE_TIMEOUT_MS = 1_209_600 * 1000; // 14 days

export interface EffectiveExpiry {
  /** Unix ms, or null when the server gave nothing to compute from. */
  at: number | null;
  /** Which limit applies: 'idle' (resets on use) or 'hard' (fixed). */
  kind: 'idle' | 'hard' | null;
}

export function effectiveExpiry(row: Pick<CliSession, 'createdAt' | 'expiresAt' | 'lastUsedAt'>): EffectiveExpiry {
  const lastUse = row.lastUsedAt ?? row.createdAt;
  const idleAt = lastUse === null ? null : lastUse + IDLE_TIMEOUT_MS;
  if (idleAt !== null && (row.expiresAt === null || idleAt < row.expiresAt)) return { at: idleAt, kind: 'idle' };
  if (row.expiresAt !== null) return { at: row.expiresAt, kind: 'hard' };
  return { at: null, kind: null };
}

function inWords(ms: number): string {
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`;
  if (ms <= 0) return 'now';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${unit(minutes, 'minute')}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `in ${unit(hours, 'hour')}`;
  return `in ${unit(Math.floor(ms / 86_400_000), 'day')}`;
}

/** `expires in 13 days if unused` / `expires in 20 days (30-day limit)`. */
export function describeExpiry(expiry: EffectiveExpiry, now: number): string {
  if (expiry.at === null) return 'expiry unknown';
  const when = inWords(expiry.at - now);
  return expiry.kind === 'idle' ? `expires ${when} if unused` : `expires ${when} (30-day limit)`;
}
