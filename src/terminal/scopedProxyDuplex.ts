/**
 * The scoped direct-proxy connector: one WebSocket to the deployment's
 * versioned direct-SSH route (`/proxy/v1/ssh`), carrying REAL end-to-end SSH
 * bytes — the browser's ssh2 speaks straight through to the host's sshd, and
 * the proxy relays opaque ciphertext it can neither read nor alter.
 *
 * Wire contract (the versioned scoped proxy, v1 — the gateway's device
 * protocol is a DIFFERENT route and stays byte-identical; this module does
 * not pretend the gateway's device-specific frame is the direct-proxy
 * contract):
 *
 *   1. dial  <trusted base>/proxy/v1/ssh?host=<host>&port=<port>  — the ONLY
 *      query fields, once each, in that order; no token in the URL, no
 *      headers, no protocol substitution;
 *   2. send  TEXT  {"type":"auth","v":1,"token":<scoped broker JWT>}  as the
 *      FIRST frame — a broker-minted admission credential only (see
 *      gatewayToken.ts). The raw sign-in never rides this socket in any
 *      frame, URL or header;
 *   3. await TEXT  {"type":"ready","v":1}  — the EXACT two-field object. Any
 *      other shape (malformed JSON, wrong version, extra fields such as a
 *      gateway-style device id or an ssh_host_key advisory, a second text
 *      frame) is a protocol violation, not noise;
 *   4. from there, BINARY frames both ways are the ordered SSH byte stream.
 *      Any TEXT after `ready` tears the transport down, mirroring the
 *      gateway transport.
 *
 * Failure paths are total and fail CLOSED: a handshake that times out,
 * stalls, arrives out of order, arrives malformed, or is answered by a close
 * releases every listener, stops its timer and closes the socket before the
 * error surfaces. Errors are canonical and credential-safe — no token bytes,
 * no reflected peer text. There is NO fallback: a failed admission never
 * retries over the legacy unversioned query-token relay or the Lambda
 * bridge, and an endpoint that does not answer the v1 handshake surfaces the
 * fixed update-required refusal — never a Google retry.
 */
import { WebSocketDuplex } from './wsduplex';
import type { ScopedProxyAdmission } from '../api/gatewayToken';

/** The versioned route, mounted at the root of the trusted base origin. */
export const SCOPED_PROXY_SSH_PATH = '/proxy/v1/ssh';

/** The admission protocol version this connector speaks. */
export const SCOPED_PROXY_PROTOCOL_VERSION = 1;

/** Server handshake budget is bounded; the client gives open → auth → ready
 * this whole budget before giving up (a longer wait is an outage, and the
 * deadline spans the entire exchange). */
export const SCOPED_PROXY_HANDSHAKE_TIMEOUT_MS = 15_000;

/** One inbound WebSocket message after the handshake. The proxy pipes TCP;
 * SSH frames are far smaller, and this bounds what a misbehaving peer can
 * push at the browser parser (the same ceiling the gateway transport uses). */
export const SCOPED_PROXY_MAX_WS_MESSAGE_BYTES = (1 << 20) + (64 << 10);

/** The ready frame is exactly two short fields; anything this size is not it. */
const MAX_HANDSHAKE_TEXT_CHARS = 1024;

/** The broker refuses bearers over 8192 chars; apply the same bound before
 * anything is put on the wire. */
const MAX_ADMISSION_TOKEN_CHARS = 8192;

/** The fixed refusal for a deployment that does not advertise the scoped
 * direct proxy. Callers surface this sentence verbatim; it is deliberately
 * the SAME fixed sentence everywhere and never suggests a legacy retry. */
export const SCOPED_PROXY_UNCONFIGURED_MESSAGE =
  'This deployment does not offer browser-direct SSH over the scoped direct proxy — update PocketShell (or the deployment configuration) and reconnect. Nothing was dialed and nothing fell back.';

/** The fixed refusal when the endpoint exists but does not answer the v1
 * handshake — an old server, not a transient outage, as far as this client
 * can tell. Still no fallback: the dial simply fails. */
export const SCOPED_PROXY_UPDATE_REQUIRED_MESSAGE =
  'The direct SSH endpoint did not answer the current scoped-proxy protocol — the server may be out of date. Update the deployment and reconnect. Nothing was sent to the host and nothing fell back.';

/** Host labels allowed into the query string: no separators, no whitespace,
 * no percent-escapes, no userinfo tricks — the proxy applies its own target
 * policy; this bound keeps the URL census exact (host and port, once). */
const HOST_LABEL_RE = /^[A-Za-z0-9._:-]{1,255}$/;

export class ScopedProxyError extends Error {
  /** A stable machine-readable class for callers that branch on it. */
  readonly kind: 'config' | 'unconfigured' | 'protocol' | 'closed' | 'timeout' | 'aborted';
  /** The WS close code, when the failure was a close. */
  readonly closeCode: number | null;
  /** True when the endpoint did not answer the v1 handshake at all — the
   * fixed update-required posture, never a fallback trigger. */
  readonly updateRequired: boolean;

  constructor(
    message: string,
    opts: { kind: ScopedProxyError['kind']; closeCode?: number; updateRequired?: boolean } = { kind: 'protocol' },
  ) {
    super(message);
    this.name = 'ScopedProxyError';
    this.kind = opts.kind;
    this.closeCode = opts.closeCode ?? null;
    this.updateRequired = opts.updateRequired ?? false;
  }
}

/**
 * The exact dial URL: the trusted base origin (deployment config — never
 * host-supplied input) + the fixed path + exactly `host` and `port`, once
 * each, percent-encoded. Throws a config-scope ScopedProxyError before any
 * socket exists when the base is not a bare wss:// origin (or ws:// under
 * the explicit development flag), or when the host/port label is not a
 * plain endpoint label.
 */
export function scopedProxySshUrl(
  serverUrl: string,
  target: { host: string; port: number },
  opts: { allowInsecureWs?: boolean } = {},
): string {
  if (typeof serverUrl !== 'string' || serverUrl.trim() === '') {
    throw new ScopedProxyError(SCOPED_PROXY_UNCONFIGURED_MESSAGE, { kind: 'unconfigured' });
  }
  let url: URL;
  try {
    url = new URL(serverUrl.trim());
  } catch {
    throw new ScopedProxyError('The direct SSH endpoint address is not a valid URL.', { kind: 'config' });
  }
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && opts.allowInsecureWs === true)) {
    throw new ScopedProxyError(
      url.protocol === 'ws:'
        ? 'The direct SSH endpoint must be wss:// — development ws:// needs the explicit allow-insecure setting.'
        : 'The direct SSH endpoint must be a wss:// origin.',
      { kind: 'config' },
    );
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new ScopedProxyError('The direct SSH endpoint must be a plain origin.', { kind: 'config' });
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ScopedProxyError('The direct SSH endpoint must be a plain origin (no base path).', { kind: 'config' });
  }
  const host = target.host;
  if (typeof host !== 'string' || !HOST_LABEL_RE.test(host)) {
    throw new ScopedProxyError('The dial target is not a plain host label.', { kind: 'config' });
  }
  if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new ScopedProxyError('The dial target port is out of range.', { kind: 'config' });
  }
  // The exact census: path + host + port, once each, nothing else. The
  // single-pass decode of these two values reproduces the inputs verbatim.
  return `${url.protocol}//${url.host}${SCOPED_PROXY_SSH_PATH}?host=${encodeURIComponent(host)}&port=${target.port}`;
}

/** The exact auth frame: fields in the protocol's order, JSON text, no
 * extras. Built here (not shared with the gateway's device frame) so the two
 * protocols cannot drift into each other. */
export function buildScopedProxyAuthFrame(token: string): string {
  return JSON.stringify({ type: 'auth', v: SCOPED_PROXY_PROTOCOL_VERSION, token });
}

/** Strict parse of the one admission answer. `ready` must be EXACTLY the
 * two-field v1 object — anything else (wrong version, extra fields such as a
 * gateway device id or an advisory host key, a nested shape, an error frame)
 * is malformed: the handshake is never guessed into shape. */
export function parseScopedProxyReadyFrame(text: string): { ok: true } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not an object' };
  }
  const keys = Object.keys(parsed as Record<string, unknown>).sort();
  if (keys.length !== 2 || keys[0] !== 'type' || keys[1] !== 'v') {
    return { ok: false, reason: 'unexpected fields' };
  }
  const f = parsed as Record<string, unknown>;
  if (f['type'] !== 'ready') {
    return { ok: false, reason: `unexpected type` };
  }
  if (f['v'] !== SCOPED_PROXY_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unexpected version' };
  }
  return { ok: true };
}

export interface ScopedProxyDialOptions {
  /** The trusted base origin — deployment config, never dial-target input. */
  serverUrl: string;
  host: string;
  port: number;
  /** The broker-minted admission credential for THIS dial. The distinct
   * typed credential — a raw sign-in string does not type here. */
  admission: ScopedProxyAdmission;
  handshakeTimeoutMs?: number;
  /** Development escape hatch for ws:// endpoints — never in production. */
  allowInsecureWs?: boolean;
  /** Injectable socket (tests drive an in-memory peer). */
  socketFactory?: (url: string) => WebSocket;
  /** Abort the dial or the in-flight handshake — disposal, navigation, a
   * cancelled caller. The socket is closed and the promise rejects. */
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}

export interface ScopedProxyDialResult {
  /** The SSH byte stream — binary-only, bounded, already past admission. */
  duplex: WebSocketDuplex;
}

/**
 * Dial the scoped direct proxy and run the auth→ready admission. Resolves
 * with a Duplex over which ssh2 speaks — ordered binary only. Rejects (after
 * full cleanup) on any config, dial, abort, deadline or protocol failure.
 */
export function dialScopedProxy(opts: ScopedProxyDialOptions): Promise<ScopedProxyDialResult> {
  // URL validation is a config decision and happens before any socket —
  // including the unconfigured and insecure-ws refusals.
  let url: string;
  try {
    url = scopedProxySshUrl(opts.serverUrl, { host: opts.host, port: opts.port }, { allowInsecureWs: opts.allowInsecureWs });
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  // Bound the admission BEFORE the dial: anything but the exact typed
  // brand — a raw string, a foreign credential object, an oversized token —
  // is a broken mint, and it never goes on the wire.
  const token = opts.admission?.token;
  if (
    opts.admission?.credential !== 'pocketshell-scoped-proxy-admission-v1' ||
    typeof token !== 'string' ||
    token === '' ||
    token.length > MAX_ADMISSION_TOKEN_CHARS
  ) {
    return Promise.reject(new ScopedProxyError('The admission credential is not usable — no socket was opened.', { kind: 'config' }));
  }

  const open = opts.socketFactory ?? ((u: string) => new WebSocket(u));
  const timeoutMs = opts.handshakeTimeoutMs ?? SCOPED_PROXY_HANDSHAKE_TIMEOUT_MS;
  // A caller that already cancelled never produces a socket — not even the
  // half-open one a later abort would tear down.
  if (opts.signal?.aborted) {
    return Promise.reject(new ScopedProxyError('The direct SSH dial was cancelled.', { kind: 'aborted' }));
  }

  return new Promise<ScopedProxyDialResult>((resolve, reject) => {
    const ws = open(url);
    // Everything the handshake attaches hangs off this signal, so any
    // failure path (or success) detaches it all at once — no listener ever
    // outlives the handshake that installed it.
    const handshake = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const teardown = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      handshake.abort();
      if (opts.signal !== undefined) opts.signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: ScopedProxyError | Error) => {
      if (settled) return;
      settled = true;
      teardown();
      try {
        ws.close();
      } catch {
        // the endpoint may already be gone
      }
      reject(error);
    };
    const onAbort = () => {
      fail(new ScopedProxyError('The direct SSH dial was cancelled.', { kind: 'aborted' }));
    };
    if (opts.signal !== undefined) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => {
      fail(new ScopedProxyError('The direct proxy did not finish admission in time.', { kind: 'timeout' }));
    }, timeoutMs);

    ws.addEventListener(
      'open',
      () => {
        if (settled) return;
        // Step 2: the scoped auth frame first — one bounded TEXT frame,
        // before any SSH byte moves and before the target is touched.
        try {
          ws.send(buildScopedProxyAuthFrame(token));
          opts.onStatus?.('admitting the direct SSH channel…');
        } catch {
          fail(new ScopedProxyError('Could not send the admission frame to the direct proxy.', { kind: 'protocol' }));
        }
      },
      { signal: handshake.signal },
    );

    ws.addEventListener(
      'message',
      (ev: MessageEvent) => {
        if (settled) return;
        if (typeof ev.data !== 'string') {
          // Binary before `ready`: admission is JSON-only, exactly like the
          // server's — a binary first frame is a violation, not noise.
          fail(new ScopedProxyError('The direct proxy sent data before admission completed.', { kind: 'protocol' }));
          return;
        }
        if (ev.data.length > MAX_HANDSHAKE_TEXT_CHARS) {
          fail(new ScopedProxyError('The direct proxy answered admission with an oversized frame.', { kind: 'protocol' }));
          return;
        }
        const parsed = parseScopedProxyReadyFrame(ev.data);
        if (!parsed.ok) {
          // One canonical sentence for every wrong answer — the frame's
          // bytes are never reflected (they could echo credential material
          // from a hostile peer).
          fail(new ScopedProxyError('The direct proxy answered admission with a malformed frame.', { kind: 'protocol' }));
          return;
        }
        // Admission complete: detach every handshake listener, stop the
        // timer, then hand the live socket to the byte stream — text is now
        // a violation, and every inbound frame is size-bounded.
        settled = true;
        teardown();
        opts.onStatus?.('direct proxy admitted — starting secure shell');
        const duplex: WebSocketDuplex = new WebSocketDuplex(ws, {
          maxMessageBytes: SCOPED_PROXY_MAX_WS_MESSAGE_BYTES,
          intercept: (frame: MessageEvent): boolean => {
            if (typeof frame.data === 'string') {
              // Text after admission is a protocol violation on BOTH ends.
              duplex.destroy(new ScopedProxyError('The direct proxy sent a control frame inside the SSH stream.', { kind: 'protocol' }));
              return true;
            }
            return false;
          },
        });
        resolve({ duplex });
      },
      { signal: handshake.signal },
    );

    ws.addEventListener(
      'close',
      (ev: CloseEvent) => {
        if (settled) return;
        const code = ev?.code ?? 1006;
        // The endpoint never answered the v1 handshake with a frame — an old
        // server or a closed route. Fixed update-required posture; still no
        // fallback of any kind.
        if (code === 1006 || code === 4404 || code === 404) {
          fail(new ScopedProxyError(SCOPED_PROXY_UPDATE_REQUIRED_MESSAGE, { kind: 'closed', closeCode: code, updateRequired: true }));
          return;
        }
        if (code === 4401) {
          fail(new ScopedProxyError('The direct proxy refused the admission credential — sign in again and retry.', { kind: 'closed', closeCode: code }));
          return;
        }
        fail(new ScopedProxyError('The direct proxy closed the connection before admitting this dial.', { kind: 'closed', closeCode: code }));
      },
      { signal: handshake.signal },
    );

    ws.addEventListener(
      'error',
      () => {
        fail(new ScopedProxyError(SCOPED_PROXY_UPDATE_REQUIRED_MESSAGE, { kind: 'closed', updateRequired: true }));
      },
      { signal: handshake.signal },
    );
  });
}
