/**
 * A node-stream Duplex whose peer is a WebSocket — the shim that lets ssh2
 * speak over a WebSocket transport. Bytes that cross here are already SSH
 * wire format (encrypted end-to-end between this browser and the host); the
 * relay or gateway on the other side never sees anything readable.
 *
 * `stream` resolves to the browser shim (stream-browserify) under Vite and to
 * node's own stream in vitest, so the same file serves both.
 */
import { Duplex } from 'node:stream';

export interface WebSocketDuplexOptions {
  /** Inspect every inbound frame BEFORE it reaches the SSH stream. Return
   * true when the interceptor consumed the frame (handshake traffic, a
   * protocol violation it handled by destroying the stream) — returning
   * true keeps the bytes away from ssh2. The gateway handshake uses this to
   * gate TEXT frames and bound message size. */
  intercept?: (ev: MessageEvent) => boolean;
  /** Reject (destroy) any single inbound binary message larger than this —
   * a bound on what a misbehaving server can push at the parser. */
  maxMessageBytes?: number;
  /** Dial with an injected socket factory (tests drive an in-memory peer).
   * Absent: the platform's global WebSocket. */
  socketFactory?: (url: string) => WebSocket;
}

export class WebSocketDuplex extends Duplex {
  private readonly ws: WebSocket;
  private readonly maxMessageBytes: number;

  constructor(ws: WebSocket, options: WebSocketDuplexOptions = {}) {
    super();
    this.ws = ws;
    this.maxMessageBytes = options.maxMessageBytes ?? Number.POSITIVE_INFINITY;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (options.intercept?.(ev) === true) return;
      if (typeof ev.data === 'string') return;
      if (ev.data instanceof ArrayBuffer && ev.data.byteLength > this.maxMessageBytes) {
        this.destroy(new Error(`server message of ${ev.data.byteLength} bytes exceeds the transport bound`));
        return;
      }
      // A real Buffer for the ssh2 parser: it does slice/compare arithmetic
      // that the plain polyfill view does not answer.
      this.push(Buffer.from(new Uint8Array(ev.data as ArrayBuffer)));
    });
    ws.addEventListener('close', () => {
      // EOF both ways: the reader sees end-of-stream, the writer's _final
      // never fires on its own.
      this.push(null);
    });
    ws.addEventListener('error', () => {
      this.destroy(new Error('relay WebSocket failed'));
    });
    // ssh2 arms `sock.on('connect', …)` even for a custom stream and waits
    // for it before writing; by the time this exists the socket is open.
    queueMicrotask(() => this.emit('connect'));
  }

  // The WebSocket is the flow controller (none); incoming data is pushed
  // through regardless of the consumer's pace, and terminal data rates
  // never make that a problem.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  _read(): void {}

  _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      cb(new Error('relay WebSocket is not open'));
      return;
    }
    // The polyfill Buffer is an ArrayBufferView already, but it can sit on
    // the pool's shared buffer — send exactly the owned view.
    this.ws.send(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    );
    cb();
  }

  _final(cb: (err?: Error | null) => void): void {
    this.ws.close();
    cb();
  }

  _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    try {
      this.ws.close();
    } catch {
      // already closed — nothing to tear down
    }
    cb(err);
  }
}

/** Dial the WebSocket and resolve with the Duplex once the socket is open. */
export function connectWebSocketDuplex(
  url: string,
  options: Omit<WebSocketDuplexOptions, 'socketFactory'> & { socketFactory?: (url: string) => WebSocket } = {},
): Promise<WebSocketDuplex> {
  const open = options.socketFactory ?? ((u: string) => new WebSocket(u));
  return new Promise((resolve, reject) => {
    const ws = open(url);
    ws.onopen = () => resolve(new WebSocketDuplex(ws, options));
    ws.onerror = () => reject(new Error('relay WebSocket connection failed'));
  });
}
