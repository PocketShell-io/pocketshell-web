import { describe, expect, it } from 'vitest';
import { describeExpiry, effectiveExpiry, IDLE_TIMEOUT_MS } from '../src/device/sessionExpiry';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

describe('CLI session effective expiry', () => {
  it('is the idle deadline while that comes first', () => {
    const row = { createdAt: T0, expiresAt: T0 + 30 * DAY, lastUsedAt: T0 + DAY };
    expect(effectiveExpiry(row)).toEqual({ at: T0 + DAY + IDLE_TIMEOUT_MS, kind: 'idle' });
    expect(describeExpiry(effectiveExpiry(row), T0 + 2 * DAY)).toBe('expires in 13 days if unused');
  });

  it('is the hard expiry once recent use pushes the idle deadline past it', () => {
    const row = { createdAt: T0, expiresAt: T0 + 30 * DAY, lastUsedAt: T0 + 20 * DAY };
    expect(effectiveExpiry(row)).toEqual({ at: T0 + 30 * DAY, kind: 'hard' });
    expect(describeExpiry(effectiveExpiry(row), T0 + 20 * DAY)).toBe('expires in 10 days (30-day limit)');
  });

  it('falls back to created_at for last use, and to whatever is known', () => {
    expect(effectiveExpiry({ createdAt: T0, expiresAt: T0 + 30 * DAY, lastUsedAt: null }).at).toBe(T0 + IDLE_TIMEOUT_MS);
    expect(effectiveExpiry({ createdAt: null, expiresAt: T0, lastUsedAt: null })).toEqual({ at: T0, kind: 'hard' });
    expect(effectiveExpiry({ createdAt: null, expiresAt: null, lastUsedAt: null })).toEqual({ at: null, kind: null });
    expect(describeExpiry({ at: null, kind: null }, T0)).toBe('expiry unknown');
  });

  it('words short spans in hours and minutes', () => {
    expect(describeExpiry({ at: T0 + 5 * 3_600_000, kind: 'idle' }, T0)).toBe('expires in 5 hours if unused');
    expect(describeExpiry({ at: T0 + 90_000, kind: 'hard' }, T0)).toBe('expires in 2 minutes (30-day limit)');
  });
});
