import { describe, expect, it } from 'vitest';
import { formatExpiry, formatRequestAge, requestTiming } from '../src/device/requestTiming';

const info = { createdAt: 1_000_000, expiresAt: 1_600_000, serverNow: 1_012_000 };

describe('request timing on the broker clock', () => {
  it('ignores the local clock offset and only uses local elapsed time', () => {
    expect(requestTiming(info, 99_000_000, 99_000_000)).toEqual({ ageSeconds: 12, remainingSeconds: 588 });
    expect(requestTiming(info, 99_000_000, 99_010_500)).toEqual({ ageSeconds: 22, remainingSeconds: 578 });
  });

  it('clamps: never negative age, never negative remaining, never runs backwards', () => {
    expect(requestTiming(info, 5_000, 4_000)).toEqual({ ageSeconds: 12, remainingSeconds: 588 });
    expect(requestTiming(info, 0, 10_000_000).remainingSeconds).toBe(0);
    expect(requestTiming({ ...info, createdAt: 2_000_000 }, 0, 0).ageSeconds).toBe(0);
  });

  it('falls back to the local receipt time without a broker now, and to null without timestamps', () => {
    expect(requestTiming({ ...info, serverNow: null }, 1_030_000, 1_030_000).ageSeconds).toBe(30);
    expect(requestTiming({ createdAt: null, expiresAt: null, serverNow: null }, 0, 0)).toEqual({
      ageSeconds: null,
      remainingSeconds: null,
    });
  });

  it('formats age and countdown', () => {
    expect(formatRequestAge(1)).toBe('requested 1 second ago');
    expect(formatRequestAge(12)).toBe('requested 12 seconds ago');
    expect(formatRequestAge(61)).toBe('requested 1 minute ago');
    expect(formatRequestAge(7300)).toBe('requested 2 hours ago');
    expect(formatRequestAge(null)).toBe('request time unknown');
    expect(formatExpiry(588)).toBe('expires in 9:48');
    expect(formatExpiry(5)).toBe('expires in 0:05');
    expect(formatExpiry(0)).toBe('expired');
    expect(formatExpiry(null)).toBe('expiry unknown');
  });
});
