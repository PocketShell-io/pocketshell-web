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
 *    rejects any body);
 *  - the response is size- and time-bounded, strictly shaped, and must
 *    carry a bounded lifetime (≤ 5 min + skew) — no open-ended tokens;
 *  - a response that echoes the Google token back is refused;
 *  - nothing is persisted and nothing token-shaped is ever logged.
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
 * slower is an outage, not a slow day. */
export const GATEWAY_TOKEN_TIMEOUT_MS = 10_000;

/** The broker mints at most 5 minutes; +60s tolerates clock skew. */
const MAX_TOKEN_LIFETIME_MS = 5 * 60_000 + 60_000;
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

function unixSecondsToMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n * 1000;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${googleIdToken}` },
      body: null,
      signal: controller.signal,
    });
  } catch {
    // Network failure, abort on timeout, CORS — one sentence, no detail that
    // could carry token material.
    throw new GatewayTokenError('The account service did not answer the credential exchange in time.');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // The broker's error body is {"error": code} — surface the code, never
    // echo body text (it could be an error page, and discipline costs nothing).
    let code: string | null = null;
    try {
      const parsed: unknown = JSON.parse(await responseText(response));
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>)['error'] === 'string') {
        code = (parsed as Record<string, unknown>)['error'] as string;
      }
    } catch {
      // non-JSON error body — the status is the message
    }
    if (response.status === 401 || response.status === 403) {
      throw new GatewayTokenError('Your sign-in was not accepted for a gateway credential — sign in again.', code);
    }
    throw new GatewayTokenError('The account service could not mint a gateway credential right now.', code ?? `http-${response.status}`);
  }

  const raw = await responseText(response);
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
  const token = body['token'];
  if (token === googleIdToken) {
    // The exchange must MINT a scoped token. An endpoint echoing the bearer
    // back is not the broker contract — refuse rather than forward it.
    throw new GatewayTokenError('The account service returned a malformed gateway credential.');
  }

  const now = nowMs();
  // expires_at (unix seconds) arrives with broker round two; expires_in is
  // the round-one field. Prefer the absolute value; require one of them.
  let expiresAtMs: number | null = unixSecondsToMs(body['expires_at']);
  if (expiresAtMs === null) {
    const expiresIn = body['expires_in'];
    if (typeof expiresIn === 'number' && Number.isSafeInteger(expiresIn) && expiresIn > 0) {
      expiresAtMs = now + expiresIn * 1000;
    }
  }
  if (expiresAtMs === null) {
    throw new GatewayTokenError('The gateway credential arrived without a usable expiry.');
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
