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
 * Google JWT authorizer — empty body, {token, token_type, expires_in}, with
 * `expires_at` unix seconds arriving in broker round two; TTL ≤ 300s capped
 * by the Google exp). Fail closed on every config, shape, and bound
 * violation; the Google token and the minted token never touch storage or
 * logs; the exchange URL derives ONLY from the frontend-owned trusted base.
 */

const GOOGLE = 'google-id-token.abc.def';
const BROKER = 'broker-gateway-jwt.XYYYZZ.sig';
const BASE = 'https://account.example';
const URL_TRUSTED = 'https://account.example/gateway/token';

const NOW = 1_700_000_000_000;

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
  const mock = fetchMock(responder ?? (() => jsonResponse({ token: BROKER, token_type: 'Bearer', expires_in: 300 })));
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

  it('round-one shape ({token, expires_in}) yields now+expires_in', async () => {
    const { promise } = exchange({}, () => jsonResponse({ token: BROKER, token_type: 'Bearer', expires_in: 300 }));
    const out = await promise;
    expect(out.expiresAtMs).toBe(NOW + 300_000);
  });

  it('prefers expires_at (unix seconds) when the broker round-two field is present', async () => {
    const abs = Math.floor(NOW / 1000) + 120;
    const { promise } = exchange({}, () => jsonResponse({ token: BROKER, expires_in: 300, expires_at: abs }));
    const out = await promise;
    expect(out.expiresAtMs).toBe(abs * 1000);

    const asString = await getGatewayToken({
      googleIdToken: GOOGLE,
      syncApiBase: BASE,
      nowMs: () => NOW,
      fetchImpl: fetchMock(() => jsonResponse({ token: BROKER, expires_at: String(abs) })).fetch,
    });
    expect(asString.expiresAtMs).toBe(abs * 1000);
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
    ['missing token', () => jsonResponse({ token_type: 'Bearer', expires_in: 300 }), /malformed gateway credential/],
    ['garbage token', () => jsonResponse({ token: 'hello world', expires_in: 300 }), /malformed/],
    ['google token echoed back', () => jsonResponse({ token: GOOGLE, expires_in: 300 }), /malformed/],
    ['no expiry fields', () => jsonResponse({ token: BROKER }), /without a usable expiry/],
    ['expired on arrival', () => jsonResponse({ token: BROKER, expires_in: 0 }), /without a usable expiry|already expired/],
    ['lifetime beyond the broker bound', () => jsonResponse({ token: BROKER, expires_in: 400 }), /outlives the broker contract/],
    ['absurd absolute expiry', () => jsonResponse({ token: BROKER, expires_at: Math.floor(NOW / 1000) + 100_000 }), /outlives/],
  ])('%s is refused', async (_name, respond, pattern) => {
    const { promise } = exchange({}, respond as (call: FetchCall) => Response);
    await expect(promise).rejects.toThrow(pattern as RegExp);
  });

  it('oversized responses are cut off, not parsed', async () => {
    const pad = 'x'.repeat(20 * 1024);
    const { promise } = exchange({}, () => jsonResponse({ token: BROKER, expires_in: 300, pad }));
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

  it('nothing token-shaped reaches storage or the console', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    const { promise } = exchange({}, () => jsonResponse({ token: BROKER, token_type: 'Bearer', expires_in: 300 }));
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
