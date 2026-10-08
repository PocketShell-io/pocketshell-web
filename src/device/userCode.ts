/**
 * The CLI device-flow user code (`pocketshell login` prints it): 8 characters
 * from a 28-symbol alphabet with no vowels (no accidental words) and no
 * look-alikes (0/O, 1/I/L, U/V), shown as `XXXX-XXXX`. The broker hashes the
 * normalized form, so whatever the user types or pastes — lower case,
 * spaces, the dash, a stray quote — reduces to the same 8 symbols here.
 */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
export const USER_CODE_LENGTH = 8;

const NOT_IN_ALPHABET = new RegExp(`[^${USER_CODE_ALPHABET}]`, 'g');

/** Upper-case, then drop every character outside the alphabet. Never
 * truncates: a paste with extra symbols must read as invalid, not as a
 * different code that happens to be its prefix. */
export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(NOT_IN_ALPHABET, '');
}

export function isValidUserCode(normalized: string): boolean {
  return normalized.length === USER_CODE_LENGTH && normalizeUserCode(normalized) === normalized;
}

/** `BCDF2345` → `BCDF-2345`; a partial code gets the dash once it has more
 * than four symbols, so the field formats as the user types. */
export function formatUserCode(normalized: string): string {
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

/** What the input field shows for raw typed text: normalized, capped at the
 * code length, dashed. */
export function formatUserCodeInput(raw: string): string {
  return formatUserCode(normalizeUserCode(raw).slice(0, USER_CODE_LENGTH));
}

/** The `?code=` prefill: a valid code (normalized) or nothing. A query value
 * is attacker-choosable, so anything that is not exactly one well-formed
 * code is dropped rather than partially kept. */
export function codeFromQuery(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.length > 64) return '';
  const normalized = normalizeUserCode(raw);
  return isValidUserCode(normalized) ? normalized : '';
}
