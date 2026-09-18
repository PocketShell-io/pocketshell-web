/**
 * A node-stream Duplex whose peer is a WebSocket — the shim that lets ssh2
 * speak over the relay. Bytes that cross here are already SSH wire format
 * (encrypted end-to-end between this browser and the host); the relay on the
 * other side never sees anything readable.
 *
 * `stream` resolves to the browser shim (stream-browserify) under Vite and to
 * node's own stream in vitest, so the same file serves both.
 */
import { Duplex } from 'node:stream';

export class WebSocketDuplex extends Duplex {
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data === 'string') return;
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

  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    try {
      this.ws.close();
    } catch {
      // already closed — nothing to tear down
    }
    cb(err);
  }
}

/** Dial the relay and resolve with the Duplex once the socket is open. */
export function connectWebSocketDuplex(url: string): Promise<WebSocketDuplex> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(new WebSocketDuplex(ws));
    ws.onerror = () => reject(new Error('relay WebSocket connection failed'));
  });
}
