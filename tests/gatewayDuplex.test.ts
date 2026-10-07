import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { dialGateway, GatewayHandshakeError } from '../src/terminal/gatewayDuplex';
import type { WebSocketDuplex } from '../src/terminal/wsduplex';

/**
 * The gateway handshake, against an in-memory gateway: the auth frame goes
 * FIRST and as TEXT, the token never touches the URL, binary only flows
 * after `ready` — and every failure path (malformed, early binary, close
 * codes, timeout) releases the listeners and closes the socket before the
 * error surfaces. Wire shapes mirror pocketshell-gateway-tunnel's service.go.
 */

/** A recorded WebSocket with a server-side test API. */
class RecordedSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  readonly url: string;
  readonly sent: (string | Uint8Array)[] = [];
  closedByClient = false;
  clientCloseCode: number | null = null;
  private readonly listeners = new Map<string, Array<{ fn: (ev: never) => void; signal: AbortSignal | undefined }>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, fn: (ev: never) => void, opts?: { signal?: AbortSignal }): void {
    if (opts?.signal?.aborted) return;
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, signal: opts?.signal });
    this.listeners.set(type, list);
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== RecordedSocket.OPEN) throw new Error('socket not open');
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.closedByClient) return;
    this.closedByClient = true;
    this.clientCloseCode = code ?? null;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', { code: code ?? 1006 }));
  }

  // --- server-side test drives ---------------------------------------------

  serverOpen(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  serverText(text: string): void {
    this.emit('message', { data: text });
  }

  serverBinary(bytes: Uint8Array): void {
    // The browser delivers binary frames as ArrayBuffer.
    const view = new Uint8Array(bytes.byteLength);
    view.set(bytes);
    this.emit('message', { data: view.buffer });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.emit('close', { code });
  }

  serverError(): void {
    this.emit('error', {});
  }

  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).filter((l) => !l.signal?.aborted).length;
  }

  private emit(type: string, data: unknown): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) {
      if (l.signal?.aborted) continue;
      (l.fn as (ev: unknown) => void)(data);
    }
  }
}

const ID_TOKEN = 'test-id-token-value';
const DEVICE = 'dev-01';
const SERVER = 'wss://gateway.example';
const READY = { type: 'ready', v: 1, device_id: DEVICE, ssh_host_key: 'ssh-ed25519 AAAA' };

function dial(socketOverrides: { url?: string } = {}, overrides: Record<string, unknown> = {}) {
  const sockets: RecordedSocket[] = [];
  const urls: string[] = [];
  const socketFactory = (url: string) => {
    urls.push(url);
    const socket = new RecordedSocket(socketOverrides.url ?? url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  const promise = dialGateway({
    serverUrl: SERVER,
    deviceId: DEVICE,
    idToken: ID_TOKEN,
    socketFactory,
    ...(overrides['dial'] ?? {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const result: { duplex?: WebSocketDuplex; ready?: typeof READY } = {};
  const settled = promise.then(
    (r) => {
      result.duplex = r.duplex;
      result.ready = r.ready as typeof READY;
      return r;
    },
    (e) => {
      result['error'] = e;
      return Promise.reject(e);
    },
  );
  return { promise: settled, result, urls, socket: sockets[0] };
}

/** Collect duplex data until `bytes` length reached or 250ms elapsed. */
async function readAll(duplex: WebSocketDuplex): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  duplex.on('data', (c: Buffer) => chunks.push(c));
  await new Promise((r) => setTimeout(r, 25));
  return chunks;
}

/** The happy-path handshake: dial, open, answer ready. */
async function handshaken(overrides: Record<string, unknown> = {}) {
  const d = dial({}, overrides);
  d.socket!.serverOpen();
  d.socket!.serverText(JSON.stringify(READY));
  const r = await d.promise;
  return { socket: d.socket!, duplex: r.duplex!, ready: r.ready! };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gateway dial', () => {
  it('dials the per-host ssh route with NO token anywhere in the URL', () => {
    const d = dial();
    expect(d.urls[0]).toBe('wss://gateway.example/api/v1/hosts/dev-01/ssh');
    expect(d.urls[0]).not.toMatch(/token/i);
    expect(d.urls[0]).not.toContain(ID_TOKEN);
    // The dial never completes here; silence the late rejection.
    d.promise.catch(() => {});
  });

  it('sends the auth frame FIRST, as TEXT, with exactly the protocol fields', async () => {
    const { socket } = await handshaken();
    expect(socket.sent).toHaveLength(1);
    const first = socket.sent[0]!;
    expect(typeof first).toBe('string');
    expect(first).toBe('{"type":"auth","v":1,"token":"test-id-token-value","device_id":"dev-01"}');
  });

  it('resolves ready and carries ordered binary both ways after it', async () => {
    const { socket, duplex, ready } = await handshaken();
    expect(ready.device_id).toBe(DEVICE);
    // Only the auth TEXT has been sent — no SSH byte moved before ready.
    expect(socket.sent).toHaveLength(1);

    const reading = readAll(duplex);
    socket.serverBinary(Buffer.from('BANNE'));
    socket.serverBinary(Buffer.from('R\n$ '));
    socket.serverBinary(Buffer.from([0, 1, 2, 255]));
    const chunks = await reading;
    expect(chunks.map((c) => c.toString('utf8'))).toEqual(['BANNE', 'R\n$ ', Buffer.from([0, 1, 2, 255]).toString('utf8')]);

    duplex.write(Buffer.from('keystroke'));
    duplex.write(Buffer.from('\r'));
    const outbound = socket.sent.slice(1);
    expect(outbound).toHaveLength(2);
    for (const frame of outbound) expect(typeof frame).toBe('object'); // binary, never text
    expect(Buffer.from(outbound[0] as Uint8Array).toString()).toBe('keystroke');
    expect(Buffer.from(outbound[1] as Uint8Array).toString()).toBe('\r');
  });

  it('an error frame rejects with its code and message and closes the socket', async () => {
    const d = dial();
    d.socket!.serverOpen();
    d.socket!.serverText('{"type":"error","v":1,"code":"unauthorized","message":"token verification failed"}');
    await expect(d.promise).rejects.toMatchObject({ code: 'unauthorized', message: /refused the connection/ });
    expect(d.socket!.closedByClient).toBe(true);
  });

  it('binary before ready is a protocol violation — nothing is parsed, socket closes', async () => {
    const d = dial();
    d.socket!.serverOpen();
    d.socket!.serverBinary(Buffer.from('SSH-2.0-sneaky'));
    await expect(d.promise).rejects.toThrow(/before the handshake completed/);
    expect(d.socket!.closedByClient).toBe(true);
  });

  it('malformed handshake JSON refuses', async () => {
    const d = dial();
    d.socket!.serverOpen();
    d.socket!.serverText('{"type":"ready","v":2}');
    await expect(d.promise).rejects.toThrow(/malformed handshake/);
  });

  it('a ready naming another device refuses — never dial the wrong host', async () => {
    const d = dial();
    d.socket!.serverOpen();
    d.socket!.serverText('{"type":"ready","v":1,"device_id":"someone-else","ssh_host_key":""}');
    await expect(d.promise).rejects.toThrow(/wrong host/);
  });

  it.each([
    [4401, /sign in again/i],
    [4403, /cannot reach that host/i],
    [4503, /not connected to the gateway/i],
  ])('close code %i maps to plain-language copy', async (code, pattern) => {
    const d = dial();
    d.socket!.serverOpen();
    d.socket!.serverClose(code);
    await expect(d.promise).rejects.toMatchObject({ closeCode: code });
    await d.promise.catch((e: GatewayHandshakeError) => {
      expect(e.message).toMatch(pattern);
    });
  });

  it('a connect error rejects', async () => {
    const d = dial();
    d.socket!.serverError();
    await expect(d.promise).rejects.toThrow(/Could not connect/);
  });

  it('the handshake timer bounds the wait and closes the socket', async () => {
    vi.useFakeTimers();
    const d = dial();
    d.socket!.serverOpen();
    const assertion = expect(d.promise).rejects.toThrow(/did not finish the handshake/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    expect(d.socket!.closedByClient).toBe(true);
  });

  it('a short custom timeout works the same way', async () => {
    vi.useFakeTimers();
    const d = dial({}, { dial: { handshakeTimeoutMs: 50 } });
    d.socket!.serverOpen();
    const assertion = expect(d.promise).rejects.toThrow(/did not finish the handshake/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('failure releases every handshake listener from the socket', async () => {
    const d = dial();
    d.socket!.serverOpen();
    d.socket!.serverText('{"type":"error","v":1,"code":"x","message":"y"}');
    await d.promise.catch(() => {});
    // Nothing is left subscribed to a dead socket.
    expect(d.socket!.listenerCount('open')).toBe(0);
    expect(d.socket!.listenerCount('message')).toBe(0);
    expect(d.socket!.listenerCount('close')).toBe(0);
    expect(d.socket!.listenerCount('error')).toBe(0);
    // A late frame after the failure finds no handler and throws nothing.
    expect(() => d.socket!.serverText('{"type":"ready","v":1}')).not.toThrow();
    expect(() => d.socket!.serverClose(1006)).not.toThrow();
  });

  it('success releases the handshake listeners too — the stream owns the socket', async () => {
    const { socket } = await handshaken();
    expect(socket.listenerCount('message')).toBe(1); // exactly the duplex's
    expect(socket.listenerCount('open')).toBe(0);
  });

  it('TEXT inside the established stream destroys the transport', async () => {
    const { socket, duplex } = await handshaken();
    const destroyed = new Promise<Error>((resolve) => {
      duplex.on('error', (e: Error) => resolve(e));
      duplex.on('close', () => resolve(new Error('closed without error')));
    });
    socket.serverText('{"type":"surprise"}');
    const err = await destroyed;
    expect(err.message).toMatch(/control frame inside the SSH stream/);
  });

  it('an oversized inbound binary destroys the transport instead of feeding the parser', async () => {
    const { socket, duplex } = await handshaken();
    const destroyed = new Promise<Error>((resolve) => {
      duplex.on('error', (e: Error) => resolve(e));
      duplex.on('close', () => resolve(new Error('closed without error')));
    });
    socket.serverBinary(new Uint8Array((1 << 20) + (64 << 10) + 1));
    const err = await destroyed;
    expect(err.message).toMatch(/exceeds the transport bound/);
  });

  it('an insecure ws:// gateway refuses before any socket is created', async () => {
    const factory = vi.fn(() => new RecordedSocket('x'));
    await expect(
      dialGateway({
        serverUrl: 'ws://gateway.example',
        deviceId: DEVICE,
        idToken: ID_TOKEN,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        socketFactory: factory as any,
      }),
    ).rejects.toThrow(/allow-insecure/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('the explicit development flag admits ws:// (local/docker gateway)', async () => {
    const d = dial({}, { dial: { serverUrl: 'ws://localhost:8080', allowInsecureWs: true } });
    d.socket!.serverOpen();
    d.socket!.serverText(JSON.stringify(READY));
    const r = await d.promise;
    expect(r.duplex).toBeDefined();
    expect(d.urls[0]).toBe('ws://localhost:8080/api/v1/hosts/dev-01/ssh');
  });

  it('a broken device id is a config error before any dial', async () => {
    const factory = vi.fn(() => new RecordedSocket('x'));
    await expect(
      dialGateway({
        serverUrl: SERVER,
        deviceId: 'not a device id',
        idToken: ID_TOKEN,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        socketFactory: factory as any,
      }),
    ).rejects.toThrow(/device id/);
    expect(factory).not.toHaveBeenCalled();
  });
});
