/**
 * The gateway credential exchange: turn the browser's Google sign-in into a
 * short-lived gateway-scoped token, minted by the independently trusted
 * account service (the "auth broker", POST /gateway/token on the sync API).
 *
 * Why this exists: the raw Google ID token also authorizes sync reads,
 * writes and deletes of the account's encrypted data. The gateway must never
 * receive it — a hostile gateway could replay it against the sync API and
 * destroy or exfiltrate blobs it cannot decrypt. The broker instead mints an
 * RS256 JWT that is valid ONLY for gateway routing: issuer = the sync API
 * base, audience = "pocketshell-gateway", scope = pocketshell.gateway,
 * lifetime ≤ 5 minutes (further capped by the Google token's own expiry).
 * The sync API's authorizer accepts Google-issuer/Google-audience tokens
 * only, so a broker token can never read or write sync data either.
 *
 * Hard rules enforced here (fail closed on every violation):
 *  - the exchange URL is built ONLY from the frontend-owned trusted base
 *    (config.syncApiBase / opts.syncApiBase) — never from any gateway input;
 *  - the Google token travels in the Authorization header of that one
 *    request and nowhere else; the request has an empty body (the broker
 *    rejects any body) and refuses redirects (`redirect: 'error'` — a
 *    3xx answer is a hostile or broken responder, never a destination);
 *  - the response is size- and time-bounded through the LAST byte of its
 *    body (a stalled stream dies with the same deadline the headers had),
 *    strictly shaped — `token_type` exactly `Bearer`, both `expires_in`
 *    (bounded integer seconds) and `expires_at` (bounded absolute unix
 *    seconds) present and agreeing within a small clock allowance — with a
 *    bounded lifetime (≤ 5 min + skew) and no open-ended tokens;
 *  - a response that echoes the Google token back is refused;
 *  - nothing is persisted and nothing token-shaped is ever logged.
 *
 * Scope of what is minted: the broker token is a MANAGEMENT credential for
 * the gateway — it authorizes session routing AND the enrollment surface
 * (enroll / list / revoke). It is not an SSH password and carries no
 * sign-in power over the sync API; see docs/routing-credentials.md.
 */
import { config } from '../config';

export interface GatewayToken {
  token: string;
  /** Unix milliseconds. Bounded: at most now + 5 min + skew. */
  expiresAtMs: number;
}

export class GatewayTokenError extends Error {
  /** The broker's machine-readable error code, when the failure had one. */
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'GatewayTokenError';
    this.code = code;
  }
}

/** One bounded attempt. The broker answers in one round trip; anything
 * slower is an outage, not a slow day. The deadline spans headers AND body. */
export const GATEWAY_TOKEN_TIMEOUT_MS = 10_000;

/** The broker mints at most 5 minutes; +60s tolerates clock skew. */
const MAX_TOKEN_LIFETIME_MS = 5 * 60_000 + 60_000;
/** The broker's relative-TTL ceiling in seconds (the 5-minute contract,
 * without skew — skew lives in the lifetime bound and the agreement check). */
const MAX_TOKEN_LIFETIME_SECS = 5 * 60;
/** How far apart the broker's two expiry spellings may fall. Both are
 * stamped from one clock in one response; anything wider is a broken or
 * hostile responder, not clock drift. */
const EXPIRY_AGREEMENT_ALLOWANCE_MS = 5_000;
/** The broker rejects bearers over 8192 chars — apply the same bound here. */
const MAX_BEARER_CHARS = 8192;
/** A broker JWT is three base64url segments; the verifier accepts ≤ 8192. */
const MAX_TOKEN_CHARS = 8192;
/** Response body bound: the whole shape fits far below this. */
const MAX_RESPONSE_CHARS = 16 * 1024;

export interface GatewayTokenOptions {
  /** The browser's verified Google ID token. Header of the exchange only. */
  googleIdToken: string;
  /** Override the trusted base (tests). Default: config.syncApiBase. */
  syncApiBase?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  timeoutMs?: number;
}

/** The exact exchange URL for a trusted base — exported for tests. */
export function gatewayTokenUrl(syncApiBase: string): string {
  const trimmed = syncApiBase.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GatewayTokenError('The account service address is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new GatewayTokenError('The account service address must be https.');
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new GatewayTokenError('The account service address must be a plain https origin.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new GatewayTokenError('The account service address must be a plain https origin.');
  }
  return `${url.protocol}//${url.host}/gateway/token`;
}

/** Strict shape check: three base64url segments (values are not inspected —
 * the gateway verifies signature and claims; we bound the bytes). */
function plausibleJwt(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= MAX_TOKEN_CHARS &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  );
}

/** The absolute expiry, exactly as the contract spells it: a JSON number of
 * unix seconds — a safe positive integer. Strings, floats, zero and negatives
 * are all malformed (no coercion, no fallback). */
function absoluteExpiryMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value * 1000;
}

/**
 * Exchange the Google ID token for a gateway-scoped token. Rejects on every
 * config, network, shape, or bound failure — the caller must treat "no
 * broker token" as "no gateway dial", never fall back to the Google token.
 */
export async function getGatewayToken(opts: GatewayTokenOptions): Promise<GatewayToken> {
  const url = gatewayTokenUrl(opts.syncApiBase ?? config.syncApiBase);
  const googleIdToken = opts.googleIdToken;
  if (typeof googleIdToken !== 'string' || googleIdToken === '' || googleIdToken.length > MAX_BEARER_CHARS) {
    throw new GatewayTokenError('No usable sign-in to exchange — sign in again.');
  }
  const doFetch = opts.fetchImpl ?? fetch.bind(globalThis);
  const nowMs = opts.nowMs ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? GATEWAY_TOKEN_TIMEOUT_MS;

  // Empty body by contract: the broker mints fixed claims and rejects any
  // body. No header carries token material besides the Authorization.
  // `redirect: 'error'` makes a 3xx answer a hard fetch failure — the
  // exchange follows no redirect, to no origin, ever. The deadline covers
  // the WHOLE exchange: headers AND the bounded read of the body (a server
  // that stalls mid-stream dies by the same timer, and the reader is
  // cancelled rather than left running).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: number;
  let raw: string;
  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${googleIdToken}` },
        body: null,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // Network failure, abort on timeout, redirected request, CORS — one
      // sentence, no detail that could carry token material.
      throw new GatewayTokenError('The account service did not answer the credential exchange in time.');
    }
    try {
      status = response.status;
      raw = await responseText(response);
    } catch (err) {
      if (err instanceof GatewayTokenError) throw err; // the size bound fired
      // The deadline aborted a stalled body mid-read.
      throw new GatewayTokenError('The account service did not answer the credential exchange in time.');
    }
  } finally {
    clearTimeout(timer);
  }

  if (status < 200 || status >= 300) {
    // The broker's error body is {"error": code} — surface the code, never
    // echo body text (it could be an error page, and discipline costs nothing).
    let code: string | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>)['error'] === 'string') {
        code = (parsed as Record<string, unknown>)['error'] as string;
      }
    } catch {
      // non-JSON error body — the status is the message
    }
    if (status === 401 || status === 403) {
      throw new GatewayTokenError('Your sign-in was not accepted for a gateway credential — sign in again.', code);
    }
    throw new GatewayTokenError('The account service could not mint a gateway credential right now.', code ?? `http-${status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayTokenError('The account service answered the credential exchange with something unreadable.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GatewayTokenError('The account service answered the credential exchange with something unreadable.');
  }
  const body = parsed as Record<string, unknown>;
  if (!plausibleJwt(body['token'])) {
    throw new GatewayTokenError('The account service returned a malformed gateway credential.');
  }
  if (body['token_type'] !== 'Bearer') {
    throw new GatewayTokenError('The account service returned a malformed gateway credential.');
  }
  const token = body['token'];
  if (token === googleIdToken) {
    // The exchange must MINT a scoped token. An endpoint echoing the bearer
    // back is not the broker contract — refuse rather than forward it.
    throw new GatewayTokenError('The account service returned a malformed gateway credential.');
  }

  // The broker (round two) returns BOTH expiry spellings from one clock:
  // the bounded relative TTL and the absolute unix-second deadline. Both are
  // required, both bounded, and they must agree within a small allowance —
  // a responder whose two clocks disagree is broken or lying, and there is
  // no fallback to a one-field contract. `now` is taken at ARRIVAL, so the
  // network trip cannot stretch the credential's accepted lifetime.
  const now = nowMs();
  const expiresAtMs = absoluteExpiryMs(body['expires_at']);
  if (expiresAtMs === null) {
    throw new GatewayTokenError('The gateway credential arrived with a malformed absolute expiry.');
  }
  const expiresInRaw = body['expires_in'];
  const expiresIn =
    typeof expiresInRaw === 'number' && Number.isSafeInteger(expiresInRaw) && expiresInRaw > 0 && expiresInRaw <= MAX_TOKEN_LIFETIME_SECS
      ? expiresInRaw
      : null;
  if (expiresIn === null) {
    throw new GatewayTokenError('The gateway credential arrived with a malformed relative expiry.');
  }
  if (Math.abs(expiresAtMs - (now + expiresIn * 1000)) > EXPIRY_AGREEMENT_ALLOWANCE_MS) {
    throw new GatewayTokenError('The gateway credential’s two expiries disagree — refusing it.');
  }
  const lifetimeMs = expiresAtMs - now;
  if (lifetimeMs <= 0) {
    throw new GatewayTokenError('The gateway credential arrived already expired.');
  }
  if (lifetimeMs > MAX_TOKEN_LIFETIME_MS) {
    throw new GatewayTokenError('The gateway credential outlives the broker contract — refusing it.');
  }
  return { token, expiresAtMs };
}

// --- the scoped direct-proxy admission credential ---------------------------
//
// The versioned direct-SSH proxy (`/proxy/v1/ssh`) admits a dial with the
// SAME broker mint as the gateway's management surface — but the dial's
// credential must be impossible to confuse with the raw sign-in (a string)
// or with any other bearer. So the minted token is wrapped in a DISTINCT
// typed credential whose brand field only this module produces: a raw
// Google ID token does not type as an admission, and an admission does not
// type where a string bearer is expected. The proxy authenticates ACCOUNT
// ADMISSION only — it is never an SSH credential; the SSH private key
// travels only inside the end-to-end encrypted SSH session.

/** The literal brand no other value can carry. */
export type ScopedProxyAdmissionBrand = 'pocketshell-scoped-proxy-admission-v1';

export interface ScopedProxyAdmission {
  readonly credential: ScopedProxyAdmissionBrand;
  /** The broker JWT — bounded, RS256, gateway-scoped (see module header). */
  readonly token: string;
  /** Unix milliseconds. Bounded: at most now + 5 min + skew. */
  readonly expiresAtMs: number;
}

/** Wrap a fresh broker mint as the typed admission credential. No I/O of
 * its own — call it right after `getGatewayToken`, per actual dial. */
export function scopedProxyAdmissionOf(minted: GatewayToken): ScopedProxyAdmission {
  return { credential: 'pocketshell-scoped-proxy-admission-v1', token: minted.token, expiresAtMs: minted.expiresAtMs };
}

/**
 * One-stop mint for one actual proxy dial: exchange the sign-in at the
 * trusted broker and return the typed admission. Rejects on every exchange
 * failure — the caller must treat "no admission" as "no dial", never fall
 * back to the raw sign-in, the legacy unversioned relay, or the bridge.
 */
export async function mintScopedProxyAdmission(opts: GatewayTokenOptions): Promise<ScopedProxyAdmission> {
  return scopedProxyAdmissionOf(await getGatewayToken(opts));
}

/** How much life an admission must still have to be put on the wire — a
 * token inside this margin is too close to expiry to admit a session. */
export const ADMISSION_FRESH_MARGIN_MS = 30_000;

/** True when the admission still has usable life. A stale admission is
 * NEVER dialled — the caller remints (a fresh dial means a fresh mint). */
export function admissionFresh(admission: ScopedProxyAdmission, nowMs: number, marginMs = ADMISSION_FRESH_MARGIN_MS): boolean {
  return (
    admission?.credential === 'pocketshell-scoped-proxy-admission-v1' &&
    typeof admission.token === 'string' &&
    admission.token !== '' &&
    Number.isFinite(admission.expiresAtMs) &&
    admission.expiresAtMs - nowMs > marginMs
  );
}

/** Read the body with a hard size cap; oversized answers are a violation. */
async function responseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return response.text(); // environments without streaming
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_CHARS) {
      void reader.cancel().catch(() => undefined);
      throw new GatewayTokenError('The account service answered the credential exchange with something unreadable.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
