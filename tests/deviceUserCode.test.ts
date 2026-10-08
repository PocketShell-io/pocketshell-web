import { describe, expect, it } from 'vitest';
import {
  codeFromQuery,
  formatUserCode,
  formatUserCodeInput,
  isOverlongUserCode,
  isValidUserCode,
  normalizeUserCode,
  USER_CODE_ALPHABET,
} from '../src/device/userCode';

describe('device user code normalization', () => {
  it('upper-cases and strips everything outside the alphabet', () => {
    expect(normalizeUserCode('bcdf-2345')).toBe('BCDF2345');
    expect(normalizeUserCode('  bcdf 2345\n')).toBe('BCDF2345');
    expect(normalizeUserCode('"BCDF–2345"')).toBe('BCDF2345');
  });

  it('drops vowels and look-alikes that are not in the alphabet', () => {
    // A, E, I, O, U, Y, 0, 1 are all outside the 28-symbol alphabet.
    expect(normalizeUserCode('AEIOUY01')).toBe('');
    expect(USER_CODE_ALPHABET).toHaveLength(28);
  });

  it('never truncates — an over-long paste stays invalid', () => {
    const n = normalizeUserCode('BCDF-2345-X');
    expect(n).toBe('BCDF2345X');
    expect(isValidUserCode(n)).toBe(false);
  });

  it('accepts exactly 8 alphabet symbols', () => {
    expect(isValidUserCode('BCDF2345')).toBe(true);
    expect(isValidUserCode('BCDF234')).toBe(false);
    expect(isValidUserCode('BCDF-2345')).toBe(false);
    expect(isValidUserCode('bcdf2345')).toBe(false);
  });

  it('formats with a dash after four symbols', () => {
    expect(formatUserCode('BCDF2345')).toBe('BCDF-2345');
    expect(formatUserCode('BCD')).toBe('BCD');
    expect(formatUserCode('BCDF')).toBe('BCDF');
    expect(formatUserCode('BCDF2')).toBe('BCDF-2');
  });

  it('the input formatter never truncates a long paste into a valid code', () => {
    expect(formatUserCodeInput('bcdf2345')).toBe('BCDF-2345');
    const long = formatUserCodeInput('bcdf2345zz');
    expect(long).toBe('BCDF-2345ZZ');
    expect(isValidUserCode(normalizeUserCode(long))).toBe(false);
    expect(isOverlongUserCode(normalizeUserCode(long))).toBe(true);
    expect(isOverlongUserCode('BCDF2345')).toBe(false);
    // Two codes pasted together stay two codes' worth of symbols.
    expect(normalizeUserCode(formatUserCodeInput('BCDF-2345 GHJK-6789'))).toHaveLength(16);
  });

  it('prefills from the query only when it is exactly one valid code', () => {
    expect(codeFromQuery('bcdf-2345')).toBe('BCDF2345');
    expect(codeFromQuery(['BCDF-2345', 'ZZZZ-ZZZZ'])).toBe('BCDF2345');
    expect(codeFromQuery('BCDF')).toBe('');
    expect(codeFromQuery('BCDF-2345-6')).toBe('');
    expect(codeFromQuery(undefined)).toBe('');
    expect(codeFromQuery(null)).toBe('');
    expect(codeFromQuery('B'.repeat(65))).toBe('');
  });
});
