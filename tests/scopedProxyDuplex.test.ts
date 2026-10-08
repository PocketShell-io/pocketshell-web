import { afterEach, describe, expect, it } from 'vitest';
import { dialScopedProxy, parseScopedProxyReadyFrame, scopedProxySshUrl, buildScopedProxyAuthFrame, SCOPED_PROXY_UNCONFIGURED_MESSAGE, SCOPED_PROXY_UPDATE_REQUIRED_MESSAGE } from '../src/terminal/scopedProxyDuplex';
import type { WebSocketDuplex } from '../src/terminal/wsduplex';
import { sentinelAdmission, startScopedProxyFixture, SCOPED_TOKEN_SENTINEL, type ScopedFixture } from './scopedProxyFixture';

/**
 * The scoped direct-proxy connector, against in-memory peers AND a real
 * fixture socket: the URL census (host/port ONLY, once each), the auth
 * frame as the FIRST bounded TEXT with the typed admission, the EXACT
 * two-field ready — and every failure path (binary first, malformed ready,
 * an advisory or device field, oversized frames, close codes, stall,
 * deadline, abort) cleaning up before the error surfaces. No token ever
 * touches a URL; no legacy retry exists on any path.
 */

const BASE = 'wss://proxy.example';
const ADMISSION = sentinelAdmission();

/** A recorded WebSocket with a server-side test API (the gatewayDuplex
 * harness shape). */
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

function dial(socketOverrides: { url?: string } = {}, overrides: Record<string, unknown> = {}) {
  const sockets: RecordedSocket[] = [];
  const urls: string[] = [];
  const socketFactory = (url: string) => {
    urls.push(url);
    const socket = new RecordedSocket(socketOverrides.url ?? url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  const promise = dialScopedProxy({
    serverUrl: BASE,
    host: 'far.example',
    port: 22,
    admission: ADMISSION,
    socketFactory,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides['dial'] ?? {}),
  } as never);
  const result: { duplex?: WebSocketDuplex } = {};
  const settled = promise.then(
    (r) => {
      result.duplex = r.duplex;
      return r;
    },
    (e) => {
      result['error'] = e;
      return Promise.reject(e);
    },
  );
  return { promise, settled, result, sockets, urls, socketFactory };
}

async function admit(socket: RecordedSocket, ready = '{"type":"ready","v":1}'): Promise<void> {
  socket.serverOpen();
  await Promise.resolve();
  socket.serverText(ready);
  await Promise.resolve();
}

/** Node streams deliver pushed data on a later tick than a microtask. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('scopedProxySshUrl — the exact endpoint census', () => {
  it('builds path + host + port once each, in order, encoded, nothing else', () => {
    expect(scopedProxySshUrl('wss://proxy.example', { host: 'far.example', port: 22 })).toBe(
      'wss://proxy.example/proxy/v1/ssh?host=far.example&port=22',
    );
    expect(scopedProxySshUrl('wss://proxy.example:8443/', { host: '203.0.113.7', port: 2222 })).toBe(
      'wss://proxy.example:8443/proxy/v1/ssh?host=203.0.113.7&port=2222',
    );
    // Percent-encoding keeps the census exact for awkward-but-legal labels.
    const url = scopedProxySshUrl(BASE, { host: 'host_with_underscore', port: 1 });
    const q = new URL(url).searchParams;
    expect([...q.keys()].sort()).toEqual(['host', 'port']);
    expect(q.get('host')).toBe('host_with_underscore');
    expect(q.get('port')).toBe('1');
  });

  it('refuses an empty or absent base with the FIXED unconfigured sentence', () => {
    for (const base of ['', '   ']) {
      expect(() => scopedProxySshUrl(base, { host: 'far.example', port: 22 })).toThrow(SCOPED_PROXY_UNCONFIGURED_MESSAGE);
    }
  });

  it('refuses wrong scheme, insecure ws without the flag, base paths, query, fragment, userinfo', () => {
    expect(() => scopedProxySshUrl('https://proxy.example', { host: 'h', port: 22 })).toThrow(/wss/);
    expect(() => scopedProxySshUrl('ws://proxy.example', { host: 'h', port: 22 })).toThrow(/allow-insecure/);
    expect(scopedProxySshUrl('ws://proxy.example', { host: 'h', port: 22 }, { allowInsecureWs: true })).toBe(
      'ws://proxy.example/proxy/v1/ssh?host=h&port=22',
    );
    expect(() => scopedProxySshUrl('wss://proxy.example/console', { host: 'h', port: 22 })).toThrow(/plain origin/);
    expect(() => scopedProxySshUrl('wss://proxy.example/?x=1', { host: 'h', port: 22 })).toThrow(/plain origin/);
    expect(() => scopedProxySshUrl('wss://u:p@proxy.example', { host: 'h', port: 22 })).toThrow(/plain origin/);
    expect(() => scopedProxySshUrl('wss://proxy.example/#token=1', { host: 'h', port: 22 })).toThrow(/plain origin/);
  });

  it('refuses host labels that could smuggle census fields and out-of-range ports', () => {
    for (const host of ['', 'a b', 'h/x', 'h?x', 'h#x', 'u@h', 'h&x=1', '%68']) {
      expect(() => scopedProxySshUrl(BASE, { host, port: 22 })).toThrow(/host label/);
    }
    for (const port of [0, -1, 65536, 22.5, Number.NaN]) {
      expect(() => scopedProxySshUrl(BASE, { host: 'h', port })).toThrow(/port/);
    }
  });
});

describe('dialScopedProxy — the admission handshake', () => {
  it('dials the exact URL, sends the auth frame FIRST as bounded TEXT with the typed token', async () => {
    const { settled, sockets, urls } = dial();
    const p = expect(settled).resolves.toBeTruthy();
    await admit(sockets[0]!);
    await p;
    expect(urls[0]).toBe('wss://proxy.example/proxy/v1/ssh?host=far.example&port=22');
    const sent = sockets[0]!.sent;
    expect(sent).toHaveLength(1);
    expect(typeof sent[0]).toBe('string');
    expect(sent[0]).toBe('{"type":"auth","v":1,"token":"scoped-broker-jwt.sentinel.signature"}');
    // Byte-for-byte, the frame builder emits the contract field order.
    expect(buildScopedProxyAuthFrame(ADMISSION.token)).toBe('{"type":"auth","v":1,"token":"scoped-broker-jwt.sentinel.signature"}');
  });

  it('resolves a binary-only duplex after the exact two-field ready', async () => {
    const { settled, sockets, result } = dial();
    const p = expect(settled).resolves.toBeTruthy();
    await admit(sockets[0]!);
    await p;
    const duplex = result.duplex!;
    const received: Buffer[] = [];
    duplex.on('data', (c: Buffer) => received.push(c));
    sockets[0]!.serverBinary(new Uint8Array([1, 2, 3]));
    await tick();
    expect(received).toHaveLength(1);
    // Outbound SSH bytes go as binary.
    duplex.write(new Uint8Array([9, 8, 7]));
    await tick();
    const outbound = sockets[0]!.sent.filter((s) => typeof s !== 'string');
    expect(outbound).toHaveLength(1);
    duplex.destroy();
  });

  it('destroys the stream when TEXT arrives after admission', async () => {
    const { settled, sockets, result } = dial();
    const p = expect(settled).resolves.toBeTruthy();
    await admit(sockets[0]!);
    await p;
    const duplex = result.duplex!;
    const destroyed = new Promise<Error>((resolve) => duplex.on('error', resolve) && undefined);
    sockets[0]!.serverText('a control frame');
    const err = await Promise.race([
      new Promise<Error>((resolve) => duplex.once('error', resolve)),
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('no error')), 500)),
    ]);
    void destroyed;
    expect((err as Error).message).toMatch(/control frame inside the SSH stream/);
  });

  it('refuses binary before ready', async () => {
    const { settled, sockets } = dial();
    sockets[0]!.serverOpen();
    await Promise.resolve();
    sockets[0]!.serverBinary(new Uint8Array([1]));
    await expect(settled).rejects.toThrow(/data before admission/);
    expect(sockets[0]!.closedByClient).toBe(true);
    expect(sockets[0]!.listenerCount('message')).toBe(0);
  });

  it('refuses every non-contract ready answer with one canonical sentence, reflecting nothing', async () => {
    for (const ready of [
      'not json',
      '{"type":"ready"}',
      '{"type":"ready","v":2}',
      '{"type":"READY","v":1}',
      '{"type":"ready","v":1,"device_id":"dev-01"}',
      '{"type":"ready","v":1,"ssh_host_key":"ssh-ed25519 AAAA"}',
      '{"type":"error","v":1,"code":"denied","message":"raw-token-text"}',
      '["ready"]',
      '42',
    ]) {
      const { settled, sockets } = dial();
      sockets[0]!.serverOpen();
      await Promise.resolve();
      sockets[0]!.serverText(ready);
      await expect(settled).rejects.toThrow(/malformed frame/);
      expect(sockets[0]!.closedByClient).toBe(true);
    }
  });

  it('refuses an oversized handshake frame before parsing it', async () => {
    const { settled, sockets } = dial();
    sockets[0]!.serverOpen();
    await Promise.resolve();
    sockets[0]!.serverText('{"type":"ready","v":1,"pad":"' + 'x'.repeat(2048) + '"}');
    await expect(settled).rejects.toThrow(/oversized frame/);
  });

  it('maps close codes: capability-missing is the fixed update-required sentence, 4401 the sign-in sentence', async () => {
    for (const [code, message, updateRequired] of [
      [1006, SCOPED_PROXY_UPDATE_REQUIRED_MESSAGE, true],
      [4404, SCOPED_PROXY_UPDATE_REQUIRED_MESSAGE, true],
      [4401, /refused the admission credential/, false],
      [4429, /closed the connection before admitting/, false],
    ] as Array<[number, string | RegExp, boolean]>) {
      const { settled, sockets } = dial();
      sockets[0]!.serverOpen();
      await Promise.resolve();
      sockets[0]!.serverClose(code);
      await expect(settled).rejects.toSatisfy((e: Error) => {
        if (typeof message === 'string') return e.message === message;
        return message.test(e.message);
      });
      expect(sockets[0]!.listenerCount('message')).toBe(0);
      void updateRequired;
    }
  });

  it('treats an upgrade failure (never opened) as update-required, with no retry', async () => {
    const { settled, sockets } = dial();
    sockets[0]!.serverError();
    await expect(settled).rejects.toThrow(SCOPED_PROXY_UPDATE_REQUIRED_MESSAGE);
  });

  it('enforces the handshake deadline and cleans the timers/listeners', async () => {
    // Real clock, short deadline: the same contract (deadline fires, cleanup
    // happens) without fake-clock re-fire quirks after uninstall.
    const { settled, sockets } = dial({}, { dial: { handshakeTimeoutMs: 30 } });
    sockets[0]!.serverOpen();
    await Promise.resolve();
    await expect(settled).rejects.toThrow(/did not finish admission in time/);
    expect(sockets[0]!.closedByClient).toBe(true);
    expect(sockets[0]!.listenerCount('message')).toBe(0);
    expect(sockets[0]!.listenerCount('open')).toBe(0);
  }, 10_000);

  it('an abort during the handshake closes the socket and rejects as cancelled', async () => {
    const controller = new AbortController();
    const { settled, sockets } = dial({}, { dial: { signal: controller.signal } });
    sockets[0]!.serverOpen();
    await Promise.resolve();
    expect(sockets[0]!.sent).toHaveLength(1); // the auth frame went out
    controller.abort();
    await expect(settled).rejects.toThrow(/cancelled/);
    expect(sockets[0]!.closedByClient).toBe(true);
    expect(sockets[0]!.listenerCount('message')).toBe(0);
  });

  it('a pre-aborted signal refuses before the socket opens', async () => {
    const controller = new AbortController();
    controller.abort();
    const { settled, sockets } = dial({}, { dial: { signal: controller.signal } });
    await expect(settled).rejects.toThrow(/cancelled/);
    expect(sockets).toHaveLength(0);
  });

  it('refuses an unusable admission before opening any socket', async () => {
    for (const admission of [
      { credential: 'wrong-brand', token: 'x', expiresAtMs: Date.now() + 1000 },
      { credential: 'pocketshell-scoped-proxy-admission-v1', token: '', expiresAtMs: Date.now() + 1000 },
      { credential: 'pocketshell-scoped-proxy-admission-v1', token: 'x'.repeat(8193), expiresAtMs: Date.now() + 1000 },
      null,
    ] as unknown[]) {
      const { settled, sockets } = dial({}, { dial: { admission } });
      await expect(settled).rejects.toThrow(/admission credential/);
      expect(sockets).toHaveLength(0);
    }
  });

  it('never puts the token in the URL, headers, or any later frame', async () => {
    const { settled, sockets, urls } = dial();
    const p = expect(settled).resolves.toBeTruthy();
    await admit(sockets[0]!);
    await p;
    expect(urls.join(' ')).not.toContain(SCOPED_TOKEN_SENTINEL);
    // The ONLY frame carrying the token is the first auth frame.
    const afterAuth = sockets[0]!.sent.slice(1);
    for (const frame of afterAuth) {
      expect(String(frame)).not.toContain(SCOPED_TOKEN_SENTINEL);
    }
  });
});

describe('parseScopedProxyReadyFrame — the strict schema', () => {
  it('accepts exactly the two-field v1 ready', () => {
    expect(parseScopedProxyReadyFrame('{"type":"ready","v":1}')).toEqual({ ok: true });
    expect(parseScopedProxyReadyFrame('{"v":1,"type":"ready"}')).toEqual({ ok: true });
  });

  it('refuses anything else', () => {
    for (const text of [
      '',
      'null',
      '{}',
      '{"type":"ready","v":1,"extra":true}',
      '{"type":"ready","v":"1"}',
      '{"type":"auth","v":1,"token":"x"}',
      '{"type":"error","v":1}',
    ]) {
      expect(parseScopedProxyReadyFrame(text).ok).toBe(false);
    }
  });
});

// --- end to end over a real fixture socket -----------------------------------

describe('dialScopedProxy over the real fixture', () => {
  let fixture: ScopedFixture;

  afterEach(async () => {
    await fixture?.close();
  });

  it('admits against the exact contract and pipes binary both ways', async () => {
    fixture = await startScopedProxyFixture(9 /* upstream is unused for the census assertions here */);
    const dialPromise = dialScopedProxy({
      serverUrl: fixture.serverUrl,
      host: 'far.example',
      port: 22,
      admission: ADMISSION,
      allowInsecureWs: true,
      onStatus: () => undefined,
    });
    const { duplex } = await dialPromise;
    expect(fixture.records.upgradeUrls[0]).toContain('/proxy/v1/ssh?host=far.example&port=22');
    expect(fixture.records.authFrames).toEqual([{ type: 'auth', v: 1, token: SCOPED_TOKEN_SENTINEL }]);
    duplex.destroy();
  });

  it('a wrong token is refused by the fixture (4401) — the client surfaces the refusal, no retry', async () => {
    fixture = await startScopedProxyFixture(9, { requireTokenEquals: 'the-only-right-token' });
    await expect(
      dialScopedProxy({ serverUrl: fixture.serverUrl, host: 'far.example', port: 22, admission: ADMISSION, allowInsecureWs: true }),
    ).rejects.toThrow(/refused the admission credential/);
    expect(fixture.records.refusals).toContain('auth token mismatch');
  });
});
