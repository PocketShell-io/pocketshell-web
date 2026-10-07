import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { gatewayTokenUrl, getGatewayToken, GatewayTokenError } from '../src/api/gatewayToken';

vi.hoisted(() => {
  const memoryStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => void map.clear(),
    };
  };
  const g = globalThis as Record<string, unknown>;
  g['window'] ??= { POCKETSHELL_WEB: {} };
  g['localStorage'] ??= memoryStorage();
});

/**
 * The gateway credential exchange, against the ACTUAL broker contract
 * (aws-infra sandbox/pocketshell-sync lambda: POST /gateway/token behind the
 * Google JWT authorizer — empty body, `redirect: 'error'`, and a 200 body of
 * {token, token_type:'Bearer', expires_in, expires_at unix seconds} with BOTH
 * expiry spellings stamped from one clock, TTL ≤ 300s capped by the Google
 * exp). Fail closed on every config, shape, and bound violation — including
 * a stalled body (the deadline spans headers AND body) and a redirecting
 * responder; the Google token and the minted token never touch storage or
 * logs; the exchange URL derives ONLY from the frontend-owned trusted base.
 */

const GOOGLE = 'google-id-token.abc.def';
const BROKER = 'broker-gateway-jwt.XYYYZZ.sig';
const BASE = 'https://account.example';
const URL_TRUSTED = 'https://account.example/gateway/token';

const NOW = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);

/** The broker's contract response: BOTH expiry fields, agreeing. */
function brokerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { token: BROKER, token_type: 'Bearer', expires_in: 300, expires_at: NOW_SEC + 300, ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchCall = { url: string; init: RequestInit | undefined };

function fetchMock(responder: (call: FetchCall) => Response): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    return Promise.resolve(responder(call));
  }) as typeof fetch;
  return { calls, fetch: impl };
}

function exchange(overrides: Record<string, unknown> = {}, responder?: (call: FetchCall) => Response) {
  const mock = fetchMock(responder ?? (() => jsonResponse(brokerBody())));
  const promise = getGatewayToken({
    googleIdToken: GOOGLE,
    syncApiBase: BASE,
    nowMs: () => NOW,
    fetchImpl: mock.fetch,
    ...(overrides['opts'] ?? {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { promise, calls: mock.calls };
}

beforeEach(() => {
  config.syncApiBase = BASE;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('gateway token exchange', () => {
  it('POSTs the Google token in the Authorization header of ONE request to the trusted /gateway/token, with no body', async () => {
    const { promise, calls } = exchange();
    const out = await promise;
    expect(out.token).toBe(BROKER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_TRUSTED);
    expect(calls[0]!.init?.method).toBe('POST');
    expect((calls[0]!.init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${GOOGLE}`);
    // The broker contract: ANY body is a client bug (400 unexpected_body).
    expect(calls[0]!.init?.body ?? null).toBeNull();
  });

  it('derives the URL only from the frontend-owned trusted base', async () => {
    const { calls } = exchange();
    await exchange().promise;
    for (const call of calls) {
      expect(call.url).toBe(`${BASE}/gateway/token`);
      expect(call.url).not.toContain('gateway.pocketshell.io'); // never the dial target
    }
  });

  it('the request refuses redirects by contract — a 3xx answer is never followed', async () => {
    const { calls } = exchange();
    await exchange().promise;
    for (const call of calls) {
      expect(call.init?.redirect).toBe('error');
    }
  });

  it('brokerExpiryFieldsMustAgree — both fields, one clock, bounded allowance', async () => {
    // The absolute field wins for display, and agreement admits small skew.
    for (const skewSec of [0, 3, 5]) {
      const out = await getGatewayToken({
        googleIdToken: GOOGLE,
        syncApiBase: BASE,
        nowMs: () => NOW,
        fetchImpl: fetchMock(() =>
          jsonResponse(brokerBody({ expires_at: NOW_SEC + 300 - skewSec })),
        ).fetch,
      });
      expect(out.expiresAtMs).toBe((NOW_SEC + 300 - skewSec) * 1000);
    }
    // Wider than the allowance: the responder's two clocks disagree — broken
    // or lying, and there is NO fallback to a one-field answer.
    for (const skewSec of [6, 30, 300]) {
      await expect(
        getGatewayToken({
          googleIdToken: GOOGLE,
          syncApiBase: BASE,
          nowMs: () => NOW,
          fetchImpl: fetchMock(() =>
            jsonResponse(brokerBody({ expires_at: NOW_SEC + 300 - skewSec })),
          ).fetch,
        }),
      ).rejects.toThrow(/disagree/);
    }
  });

  it.each([
    ['missing expires_at', () => jsonResponse(brokerBody({ expires_at: undefined })), /malformed absolute/],
    ['string expires_at', () => jsonResponse(brokerBody({ expires_at: String(NOW_SEC + 300) })), /malformed absolute/],
    ['float expires_at', () => jsonResponse(brokerBody({ expires_at: NOW_SEC + 300.5 })), /malformed absolute/],
    ['zero expires_at', () => jsonResponse(brokerBody({ expires_at: 0 })), /malformed absolute/],
    ['missing expires_in', () => jsonResponse(brokerBody({ expires_in: undefined })), /malformed relative/],
    ['zero expires_in', () => jsonResponse(brokerBody({ expires_in: 0 })), /malformed relative/],
    ['float expires_in', () => jsonResponse(brokerBody({ expires_in: 299.5 })), /malformed relative/],
    ['expires_in beyond the broker bound', () => jsonResponse(brokerBody({ expires_in: 301 })), /malformed relative/],
    ['lowercase token_type', () => jsonResponse(brokerBody({ token_type: 'bearer' })), /malformed gateway credential/],
    ['wrong token_type', () => jsonResponse(brokerBody({ token_type: 'MAC' })), /malformed gateway credential/],
  ])('%s is refused with no fallback', async (_name, respond, pattern) => {
    const { promise } = exchange({}, respond as (call: FetchCall) => Response);
    await expect(promise).rejects.toThrow(pattern as RegExp);
  });

  it.each([
    ['401 with broker code', () => jsonResponse({ error: 'unauthorized' }, 401), /sign-in was not accepted/],
    ['403 not allowed', () => jsonResponse({ error: 'account_not_allowed' }, 403), /sign-in was not accepted/],
    ['500 plain text', () => new Response('boom', { status: 500 }), /could not mint/],
    ['503 unavailable', () => jsonResponse({ error: 'gateway_signing_key_unavailable' }, 503), /could not mint/],
  ])('%s fails closed with a clean message', async (_name, respond, pattern) => {
    const { promise } = exchange({}, respond as (call: FetchCall) => Response);
    await expect(promise).rejects.toThrow(pattern as RegExp);
  });

  it('surfaces the broker error code but never the body text or any token', async () => {
    const { promise } = exchange({}, () => jsonResponse({ error: 'invalid_claims' }, 401));
    const err = await promise.catch((e: GatewayTokenError) => e);
    expect(err.code).toBe('invalid_claims');
    expect(err.message).not.toContain(GOOGLE);
    expect(err.message).not.toContain('invalid_claims'); // code rides .code, not the sentence
  });

  it.each([
    ['non-JSON 200', () => new Response('not json', { status: 200 }), /unreadable/],
    ['missing token', () => jsonResponse({ token_type: 'Bearer', expires_in: 300, expires_at: NOW_SEC + 300 }), /malformed gateway credential/],
    ['garbage token', () => jsonResponse(brokerBody({ token: 'hello world' })), /malformed/],
    ['google token echoed back', () => jsonResponse(brokerBody({ token: GOOGLE })), /malformed/],
    ['no expiry fields', () => jsonResponse({ token: BROKER, token_type: 'Bearer' }), /malformed absolute/],
  ])('%s is refused', async (_name, respond, pattern) => {
    const { promise } = exchange({}, respond as (call: FetchCall) => Response);
    await expect(promise).rejects.toThrow(pattern as RegExp);
  });

  it('oversized responses are cut off, not parsed', async () => {
    const pad = 'x'.repeat(20 * 1024);
    const { promise } = exchange({}, () => jsonResponse(brokerBody({ pad })));
    await expect(promise).rejects.toThrow(/unreadable/);
  });

  it.each([
    ['http base', 'http://account.example'],
    ['path base', 'https://account.example/v1'],
    ['query base', 'https://account.example/?x=1'],
  ])('%s is a config error before any fetch', async (_name, base) => {
    const { promise, calls } = exchange({ opts: { syncApiBase: base } });
    await expect(promise).rejects.toThrow(/account service address/);
    expect(calls).toHaveLength(0);
  });

  it('an empty or oversized Google token is refused before any fetch', async () => {
    for (const bad of ['', 'x'.repeat(9000)]) {
      const { promise, calls } = exchange({ opts: { googleIdToken: bad } });
      await expect(promise).rejects.toThrow(/sign in again|No usable sign-in/);
      expect(calls).toHaveLength(0);
    }
  });

  it('a stalled exchange times out through the abort signal', async () => {
    vi.useFakeTimers();
    const controllerHold: AbortSignal[] = [];
    const stalled = ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        controllerHold.push(init!.signal!);
        init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }) as Promise<Response>;
    }) as typeof fetch;
    const promise = getGatewayToken({
      googleIdToken: GOOGLE,
      syncApiBase: BASE,
      nowMs: () => NOW,
      fetchImpl: stalled,
      timeoutMs: 250,
    });
    const assertion = expect(promise).rejects.toThrow(/did not answer/);
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    expect(controllerHold[0]!.aborted).toBe(true);
  });

  describe('brokerRedirectAndStalledBodyFailClosed', () => {
    it('a body that stalls AFTER the headers dies by the SAME deadline, not an unbounded read', async () => {
      vi.useFakeTimers();
      const encoder = new TextEncoder();
      // A 200 whose headers arrived but whose body never completes — the
      // exact unbounded-window hole: a fetch that resolves on headers while
      // the stream trickles (or never). The abort must tear the read down.
      const stalledBody = ((_input: RequestInfo | URL, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"token":"half-a-token"'));
            init!.signal!.addEventListener('abort', () => {
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }) as typeof fetch;
      const promise = getGatewayToken({
        googleIdToken: GOOGLE,
        syncApiBase: BASE,
        nowMs: () => NOW,
        fetchImpl: stalledBody,
        timeoutMs: 250,
      });
      const assertion = expect(promise).rejects.toThrow(/did not answer/);
      await vi.advanceTimersByTimeAsync(400);
      await assertion;
    });

    it('an error body counts against the same deadline — no separate slow lane', async () => {
      vi.useFakeTimers();
      const encoder = new TextEncoder();
      const stalledError = ((_input: RequestInfo | URL, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"error":"gateway_sign'));
            init!.signal!.addEventListener('abort', () => {
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        });
        return Promise.resolve(new Response(stream, { status: 503 }));
      }) as typeof fetch;
      const promise = getGatewayToken({
        googleIdToken: GOOGLE,
        syncApiBase: BASE,
        nowMs: () => NOW,
        fetchImpl: stalledError,
        timeoutMs: 250,
      });
      const assertion = expect(promise).rejects.toThrow(/did not answer/);
      await vi.advanceTimersByTimeAsync(400);
      await assertion;
    });

    it('a redirecting responder fails closed — the exchange follows no 3xx', async () => {
      const { promise } = exchange(
        {},
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example/gateway/token' },
          }),
      );
      await expect(promise).rejects.toThrow(/could not mint/);
    });
  });

  it('nothing token-shaped reaches storage or the console', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    const { promise } = exchange({}, () => jsonResponse(brokerBody()));
    await promise;
    expect(setItem).not.toHaveBeenCalled();
    for (const spy of [console.log, console.info, console.warn, console.error]) {
      for (const call of (spy as ReturnType<typeof vi.spyOn>).mock.calls) {
        expect(JSON.stringify(call)).not.toContain(GOOGLE);
        expect(JSON.stringify(call)).not.toContain(BROKER);
      }
    }
  });

  it('gatewayTokenUrl rejects non-https and decorated bases outright', () => {
    expect(gatewayTokenUrl('https://account.example')).toBe('https://account.example/gateway/token');
    expect(() => gatewayTokenUrl('ws://account.example')).toThrow(GatewayTokenError);
    expect(() => gatewayTokenUrl('')).toThrow(GatewayTokenError);
    expect(() => gatewayTokenUrl('https://user:pw@account.example')).toThrow(GatewayTokenError);
  });
});
