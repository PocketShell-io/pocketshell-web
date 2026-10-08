/**
 * Request age and expiry for the /device review step, on the BROKER's clock.
 *
 * The lookup returns the request's created_at / expires_at and the broker's
 * `now`. Comparing those three among themselves is immune to a wrong clock
 * on this machine; the only local time used is how long ago the lookup
 * answered (a monotonic-enough difference of two Date.now() readings), which
 * keeps the countdown ticking between lookups.
 */
import type { DeviceRequestInfo } from '../api/deviceAuth';

export interface RequestTiming {
  /** Whole seconds since the CLI started the request, or null if unknown. */
  ageSeconds: number | null;
  /** Whole seconds until the request expires (0 once expired), or null. */
  remainingSeconds: number | null;
}

/**
 * @param receivedAt local ms when the lookup response arrived
 * @param nowLocal   local ms now
 */
export function requestTiming(
  info: Pick<DeviceRequestInfo, 'createdAt' | 'expiresAt' | 'serverNow'>,
  receivedAt: number,
  nowLocal: number,
): RequestTiming {
  // Without the broker's `now`, fall back to the local clock at receipt.
  const serverAtReceipt = info.serverNow ?? receivedAt;
  const serverNow = serverAtReceipt + Math.max(0, nowLocal - receivedAt);
  return {
    ageSeconds: info.createdAt === null ? null : Math.max(0, Math.floor((serverNow - info.createdAt) / 1000)),
    remainingSeconds:
      info.expiresAt === null ? null : Math.max(0, Math.ceil((info.expiresAt - serverNow) / 1000)),
  };
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** `requested 12 seconds ago`, `requested 3 minutes ago`, `requested 2 hours ago`. */
export function formatRequestAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return 'request time unknown';
  if (ageSeconds < 60) return `requested ${plural(ageSeconds, 'second')} ago`;
  if (ageSeconds < 3600) return `requested ${plural(Math.floor(ageSeconds / 60), 'minute')} ago`;
  return `requested ${plural(Math.floor(ageSeconds / 3600), 'hour')} ago`;
}

/** `expires in 9:48`, or `expired`. */
export function formatExpiry(remainingSeconds: number | null): string {
  if (remainingSeconds === null) return 'expiry unknown';
  if (remainingSeconds <= 0) return 'expired';
  const m = Math.floor(remainingSeconds / 60);
  const s = remainingSeconds % 60;
  return `expires in ${m}:${String(s).padStart(2, '0')}`;
}
