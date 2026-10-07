/**
 * The gateway connector: one WebSocket to the PocketShell gateway's
 * per-host SSH route, carrying REAL end-to-end SSH bytes — the browser's
 * ssh2 speaks straight through to the host's own sshd, and the gateway
 * relays ciphertext it can neither read nor forge.
 *
 * Wire contract (pocketshell-gateway-tunnel internal/tunnel, v1):
 *
 *   1. dial  wss://…/api/v1/hosts/{deviceID}/ssh   — the token is NEVER in
 *      the URL;
 *   2. send  TEXT  {"type":"auth","v":1,"token":<ID token>,"device_id":…}
 *      as the FIRST frame — the token admits the route only;
 *   3. await TEXT  {"type":"ready",…}              — the host answered and
 *      a stream to its sshd is open (or a TEXT {"type":"error",…} + close);
 *   4. from there, BINARY frames both ways are the ordered SSH byte stream.
 *      Any TEXT after the handshake is a protocol violation and tears the
 *      transport down, mirroring the server.
 *
 * `ready.ssh_host_key` is the gateway's enrollment record. It is surfaced to
 * the caller ADVISORY-ONLY: the gateway controls that field, so it can never
 * establish or replace trust — the pinned fingerprint (paired out of band)
 * decides, in connection.ts's host verifier.
 *
 * Failure paths are total: a handshake that times out, arrives malformed,
 * arrives out of order, or is answered by a close code releases every
 * listener, stops its timer and closes the socket before the error
 * surfaces — nothing is left subscribed to a dead socket.
 */
import {
  GATEWAY_HANDSHAKE_TIMEOUT_MS,
  GATEWAY_MAX_WS_MESSAGE_BYTES,
  buildGatewayAuthFrame,
  classifyGatewayClose,
  gatewaySshUrl,
  parseGatewayHandshakeFrame,
  type GatewayReadyFrame,
} from '@pocketshell/core';
import { WebSocketDuplex } from './wsduplex';

export interface GatewayDialOptions {
  serverUrl: string;
  deviceId: string;
  /** The Google ID token — routing admission only; SSH authenticates with
   * the user's own key, which never crosses this socket. */
  idToken: string;
  handshakeTimeoutMs?: number;
  /** Development escape hatch for ws:// gateways — never set in production. */
  allowInsecureWs?: boolean;
  /** Injectable socket (tests drive an in-memory gateway). */
  socketFactory?: (url: string) => WebSocket;
  onStatus?: (status: string) => void;
}

export interface GatewayDialResult {
  /** The SSH byte stream — binary-only, bounded, already past the handshake. */
  duplex: WebSocketDuplex;
  /** The gateway's ready frame. `ssh_host_key` is ADVISORY ONLY: it must
   * never be used to decide trust (see module header). */
  ready: GatewayReadyFrame;
}

export class GatewayHandshakeError extends Error {
  /** The gateway error-frame code, when the failure carried one. */
  readonly code: string | null;
  /** The WS close code, when the failure was a close. */
  readonly closeCode: number | null;

  constructor(message: string, opts: { code?: string; closeCode?: number } = {}) {
    super(message);
    this.name = 'GatewayHandshakeError';
    this.code = opts.code ?? null;
    this.closeCode = opts.closeCode ?? null;
  }
}

/**
 * Dial the gateway and run the auth→ready handshake. Resolves with a Duplex
 * over which ssh2 speaks — ordered binary only — plus the advisory ready
 * frame. Rejects (after full cleanup) on any dial, handshake or protocol
 * failure.
 */
export function dialGateway(opts: GatewayDialOptions): Promise<GatewayDialResult> {
  // URL validation is a config error and happens before any socket exists —
  // including the insecure-ws refusal.
  let url: string;
  try {
    url = gatewaySshUrl({ serverUrl: opts.serverUrl, deviceId: opts.deviceId }, { allowInsecureWs: opts.allowInsecureWs });
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }

  const open = opts.socketFactory ?? ((u: string) => new WebSocket(u));
  const timeoutMs = opts.handshakeTimeoutMs ?? GATEWAY_HANDSHAKE_TIMEOUT_MS;

  return new Promise<GatewayDialResult>((resolve, reject) => {
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
    };
    const fail = (error: GatewayHandshakeError | Error) => {
      if (settled) return;
      settled = true;
      teardown();
      try {
        ws.close();
      } catch {
        // the gateway may already be gone
      }
      reject(error);
    };

    timer = setTimeout(() => {
      fail(new GatewayHandshakeError('The gateway did not finish the handshake in time.'));
    }, timeoutMs);

    ws.addEventListener(
      'open',
      () => {
        if (settled) return;
        // Step 2: auth first — one TEXT frame, before any SSH byte moves.
        try {
          ws.send(buildGatewayAuthFrame(opts.idToken, opts.deviceId));
          opts.onStatus?.('authenticating to the gateway…');
        } catch (e) {
          fail(new GatewayHandshakeError(e instanceof Error ? e.message : 'could not send the gateway auth frame'));
        }
      },
      { signal: handshake.signal },
    );

    ws.addEventListener(
      'message',
      (ev: MessageEvent) => {
        if (settled) return;
        if (typeof ev.data !== 'string') {
          // Binary before `ready`: the handshake is JSON-only, exactly like
          // the server's — a binary first frame is a violation, not noise.
          fail(new GatewayHandshakeError('The gateway sent data before the handshake completed.'));
          return;
        }
        const parsed = parseGatewayHandshakeFrame(ev.data);
        if (parsed.kind === 'malformed') {
          fail(new GatewayHandshakeError(`The gateway answered with a malformed handshake (${parsed.reason}).`));
          return;
        }
        if (parsed.kind === 'error') {
          fail(
            new GatewayHandshakeError(`The gateway refused the connection: ${parsed.frame.message}`, {
              code: parsed.frame.code,
            }),
          );
          return;
        }
        if (parsed.frame.device_id !== opts.deviceId) {
          fail(
            new GatewayHandshakeError(
              `The gateway opened the wrong host (asked for ${opts.deviceId}, got ${parsed.frame.device_id}).`,
            ),
          );
          return;
        }
        // Handshake complete: detach every handshake listener, stop the
        // timer, then hand the live socket to the byte stream — text is now
        // a violation, and every inbound frame is size-bounded.
        settled = true;
        teardown();
        opts.onStatus?.('host reached — starting secure shell');
        const duplex: WebSocketDuplex = new WebSocketDuplex(ws, {
          maxMessageBytes: GATEWAY_MAX_WS_MESSAGE_BYTES,
          intercept: (frame: MessageEvent): boolean => {
            if (typeof frame.data === 'string') {
              // Text after the handshake is a protocol violation on BOTH
              // ends; the server would drop us anyway. Tear down loudly.
              duplex.destroy(new GatewayHandshakeError('The gateway sent a control frame inside the SSH stream.'));
              return true;
            }
            return false;
          },
        });
        resolve({ duplex, ready: parsed.frame });
      },
      { signal: handshake.signal },
    );

    ws.addEventListener(
      'close',
      (ev: CloseEvent) => {
        if (settled) return;
        const classified = classifyGatewayClose(ev?.code ?? 1006);
        fail(new GatewayHandshakeError(classified.userMessage, { closeCode: ev?.code ?? 1006 }));
      },
      { signal: handshake.signal },
    );

    ws.addEventListener(
      'error',
      () => {
        fail(new GatewayHandshakeError('Could not connect to the gateway.'));
      },
      { signal: handshake.signal },
    );
  });
}
