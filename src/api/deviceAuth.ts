/**
 * The browser side of the CLI device flow (broker routes 3 and 4 of the
 * design contract): look a `pocketshell login` request up by its user code,
 * then approve or deny it. Both calls are authorized ONLY by the Google ID
 * token in `Authorization: Bearer` — no cookie ever rides along
 * (`credentials: 'omit'`), so a cross-site page cannot forge either request:
 * it would need the token, which lives in this tab's sessionStorage.
 *
 * Everything the server returns about the requesting machine (label, IP,
 * user agent) originated with whoever ran `/auth/device/start`, so it is
 * untrusted: it is type-checked, stripped of control and bidi-override
 * characters (which could make a label read as something else), and capped
 * in length before the UI sees it. The UI renders it as text only.
 */
import { config } from '../config';
import { NotSignedInError, type TokenSource } from './sync';

export type DeviceAuthErrorKind =
  | 'invalid_code' // unknown, malformed, or already consumed
  | 'expired'
  | 'too_many_attempts' // the grant's 5-call budget is spent; it is dead
  | 'not_allowed' // account not on the allowlist
  | 'email_not_verified'
  | 'lookup_required' // approve without a prior lookup by this account
  | 'already_used' // no longer pending: approved/denied elsewhere
  | 'rate_limited'
  | 'network'
  | 'unexpected';

export class DeviceAuthError extends Error {
  readonly kind: DeviceAuthErrorKind;
  readonly status: number;
  constructor(kind: DeviceAuthErrorKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface DeviceRequestInfo {
  label: string;
  requestIp: string;
  userAgent: string;
  /** Unix milliseconds, or null when the server sent nothing parseable. */
  createdAt: number | null;
  expiresAt: number | null;
}

export type DeviceDecision = 'approved' | 'denied';

export interface DeviceAuthDeps {
  auth: TokenSource;
  baseUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

// The broker's exact error vocabulary (aws-infra sandbox/pocketshell-sync
// docs/CLI-DEVICE-FLOW.md). The `error` string decides; the status is only a
// fallback for responses that never reached the Lambda (API Gateway).
const ERROR_CODES: Record<string, DeviceAuthErrorKind> = {
  invalid_code: 'invalid_code', // 404
  expired_token: 'expired', // 410
  too_many_attempts: 'too_many_attempts', // 429
  rate_limited: 'rate_limited', // 429
  already_resolved: 'already_used', // 409
  account_not_allowed: 'not_allowed', // 403
  email_not_verified: 'email_not_verified', // 403
  lookup_required: 'lookup_required', // 403
  invalid_request: 'unexpected', // 400: a malformed body is our bug
};

const STATUS_FALLBACK: Record<number, DeviceAuthErrorKind> = {
  404: 'invalid_code',
  409: 'already_used',
  410: 'expired',
  429: 'rate_limited',
};

const MESSAGES: Record<DeviceAuthErrorKind, string> = {
  invalid_code:
    'That code is unknown or has expired. Check it against your terminal, or run `pocketshell login` again for a new one.',
  expired: 'That code has expired. Run `pocketshell login` again for a new one.',
  too_many_attempts:
    'Too many attempts for that code, so it was cancelled. Run `pocketshell login` again for a new one.',
  not_allowed: 'This Google account is not allowed to use the PocketShell gateway.',
  email_not_verified: 'This Google account has no verified email address, so it cannot approve sign-ins.',
  lookup_required: 'Look up the code again before approving.',
  already_used: 'That sign-in request was already approved or denied. Run `pocketshell login` again if you still need one.',
  rate_limited: 'Too many requests right now. Wait a moment and try again.',
  network: 'Could not reach PocketShell. Check your connection and try again.',
  unexpected: 'PocketShell returned an unexpected response. Try again in a moment.',
};

export function deviceAuthErrorMessage(kind: DeviceAuthErrorKind): string {
  return MESSAGES[kind];
}

function errorKind(status: number, code: unknown): DeviceAuthErrorKind {
  if (typeof code === 'string' && Object.hasOwn(ERROR_CODES, code)) return ERROR_CODES[code];
  return STATUS_FALLBACK[status] ?? 'unexpected';
}

// Every Unicode "Other" code point (\p{C}: Cc controls, Cf format —
// zero-width, bidi embedding/override/isolate, BOM, tag characters — Co
// private use, Cn unassigned, Cs lone surrogates), the line/paragraph
// separators, and the blank-looking letters that \p{C} misses: the Hangul
// fillers (U+115F, U+1160, U+3164, U+FFA0) and the braille blank (U+2800).
// Ordinary spaces stay; whitespace runs collapse below.
const UNSAFE_CHARS = /[\p{C}\u2028\u2029\u115f\u1160\u3164\uffa0\u2800]/gu;

/** Untrusted server string → displayable text: invisible/control/bidi
 * characters become spaces, whitespace runs collapse, length is capped (by
 * code point, so the cap cannot split a surrogate pair). */
export function displayText(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean;
}

/** Broker timestamps are integer unix seconds → milliseconds, or null. */
export function parseTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value * 1000 : null;
}

export class DeviceAuthService {
  private readonly auth: TokenSource;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: DeviceAuthDeps) {
    this.auth = deps.auth;
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.fetchFn = deps.fetchFn ?? fetch.bind(globalThis);
    this.timeoutMs = deps.timeoutMs ?? 15000;
  }

  /** `POST /auth/device/lookup` — what is asking to sign in. Each call
   * counts against the grant's attempt budget (the broker kills it after
   * 5), so the UI calls this only on an explicit user action. */
  async lookup(userCode: string): Promise<DeviceRequestInfo> {
    const body = await this.post('/auth/device/lookup', { user_code: userCode });
    if (typeof body.label !== 'string') {
      throw new DeviceAuthError('unexpected', 200, MESSAGES.unexpected);
    }
    return {
      label: displayText(body.label, 80) || '(no label)',
      requestIp: displayText(body.request_ip, 64),
      userAgent: displayText(body.user_agent, 200),
      createdAt: parseTimestamp(body.created_at),
      expiresAt: parseTimestamp(body.expires_at),
    };
  }

  /** `POST /auth/device/approve` with an explicit boolean decision. */
  async decide(userCode: string, approve: boolean): Promise<DeviceDecision> {
    if (typeof approve !== 'boolean') throw new TypeError('approve must be a boolean');
    const body = await this.post('/auth/device/approve', { user_code: userCode, approve });
    const expected: DeviceDecision = approve ? 'approved' : 'denied';
    if (body.status !== expected) {
      throw new DeviceAuthError('unexpected', 200, MESSAGES.unexpected);
    }
    return expected;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    // getIdToken throws NotSignedInError when the session is gone; that
    // propagates as-is so the page can route through sign-in.
    const token = this.auth.getIdToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch {
      throw new DeviceAuthError('network', 0, MESSAGES.network);
    } finally {
      clearTimeout(timer);
    }
    // A Google ID token lives an hour and a browser cannot refresh it
    // silently — a 401 means "sign in again", never "retry".
    if (res.status === 401) throw new NotSignedInError('session expired — sign in again');
    const parsed: unknown = await res.json().catch(() => null);
    const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
    if (!res.ok) {
      const kind = errorKind(res.status, body?.error);
      throw new DeviceAuthError(kind, res.status, MESSAGES[kind]);
    }
    if (body === null) throw new DeviceAuthError('unexpected', res.status, MESSAGES.unexpected);
    return body;
  }
}

export function makeDeviceAuthService(auth: TokenSource): DeviceAuthService {
  return new DeviceAuthService({ auth, baseUrl: config.syncApiUrl });
}
