/**
 * A rough passphrase strength meter for vault setup: estimated entropy from
 * length and character classes, discounted for repeats and runs. It only
 * guides; the floor that blocks submission is MIN_LENGTH.
 */
export const MIN_LENGTH = 8;

export type StrengthLabel = 'too short' | 'weak' | 'fair' | 'good' | 'strong';

export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: StrengthLabel;
  bits: number;
}

export function passphraseStrength(p: string): Strength {
  const chars = [...p];
  if (chars.length < MIN_LENGTH) return { score: 0, label: 'too short', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 33;
  // Each character after an identical or sequential neighbour counts half.
  let effective = 0;
  for (let i = 0; i < chars.length; i++) {
    const prev = i > 0 ? chars[i - 1].codePointAt(0)! : -10;
    const cur = chars[i].codePointAt(0)!;
    effective += Math.abs(cur - prev) <= 1 ? 0.5 : 1;
  }
  const bits = Math.round(effective * Math.log2(Math.max(pool, 2)));
  const score = bits >= 80 ? 4 : bits >= 60 ? 3 : bits >= 45 ? 2 : 1;
  const label = (['too short', 'weak', 'fair', 'good', 'strong'] as const)[score];
  return { score, label, bits };
}
