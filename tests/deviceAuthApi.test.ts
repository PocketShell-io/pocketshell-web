import { describe, expect, it, vi } from 'vitest';
import {
  DeviceAuthError,
  DeviceAuthService,
  displayText,
  parseTimestamp,
} from '../src/api/deviceAuth';
import { NotSignedInError } from '../src/api/sync';

const auth = { getIdToken: () => 'id-token-abc' };

function respond(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function service(fetchFn: typeof fetch) {
  return new DeviceAuthService({ auth, baseUrl: 'https://broker.example/', fetchFn });
}

describe('DeviceAuthService', () => {
  it('looks a code up with the Bearer ID token and no cookies', async () => {
    const fetchFn = vi.fn(async () =>
      respond(200, {
        label: 'alexey@laptop',
        request_ip: '203.0.113.7',
        user_agent: 'pocketshell/1.2 (Linux)',
        created_at: 1_760_000_000,
        expires_at: 1_760_000_600,
      }),
    );
    const info = await service(fetchFn as unknown as typeof fetch).lookup('BCDF-2345');
    expect(info).toEqual({
      label: 'alexey@laptop',
      requestIp: '203.0.113.7',
      userAgent: 'pocketshell/1.2 (Linux)',
      createdAt: 1_760_000_000_000,
      expiresAt: 1_760_000_600_000,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://broker.example/auth/device/lookup');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer id-token-abc');
    expect(JSON.parse(String(init.body))).toEqual({ user_code: 'BCDF-2345' });
    // The token never goes into the URL.
    expect(url).not.toContain('id-token');
  });

  it('sends an explicit boolean decision and checks the echoed status', async () => {
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => {
      const { approve } = JSON.parse(String(init.body)) as { approve: boolean };
      return respond(200, { status: approve ? 'approved' : 'denied' });
    });
    const svc = service(fetchFn as unknown as typeof fetch);
    await expect(svc.decide('BCDF-2345', true)).resolves.toBe('approved');
    await expect(svc.decide('BCDF-2345', false)).resolves.toBe('denied');
    expect(fetchFn.mock.calls[0][0]).toBe('https://broker.example/auth/device/approve');
    expect(JSON.parse(String(fetchFn.mock.calls[0][1].body))).toEqual({ user_code: 'BCDF-2345', approve: true });
    expect(JSON.parse(String(fetchFn.mock.calls[1][1].body))).toEqual({ user_code: 'BCDF-2345', approve: false });
  });

  it('rejects an approve response that does not match the decision', async () => {
    const svc = service((async () => respond(200, { status: 'denied' })) as unknown as typeof fetch);
    await expect(svc.decide('BCDF-2345', true)).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it.each([
    [404, { error: 'invalid_code' }, 'invalid_code'],
    [410, { error: 'expired_token' }, 'expired'],
    [429, { error: 'too_many_attempts' }, 'too_many_attempts'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [409, { error: 'already_resolved' }, 'already_used'],
    [403, { error: 'account_not_allowed' }, 'not_allowed'],
    [403, { error: 'email_not_verified' }, 'email_not_verified'],
    [403, { error: 'lookup_required' }, 'lookup_required'],
    [400, { error: 'invalid_request' }, 'unexpected'],
    [429, undefined, 'rate_limited'],
    [403, { message: 'Forbidden' }, 'unexpected'],
    [500, { error: 'boom' }, 'unexpected'],
    [400, { error: 'constructor' }, 'unexpected'],
  ])('maps HTTP %i %j to %s', async (status, body, kind) => {
    const svc = service((async () => respond(status, body)) as unknown as typeof fetch);
    const err = await svc.lookup('BCDF-2345').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as DeviceAuthError).kind).toBe(kind);
  });

  it('turns a 401 into NotSignedInError (no silent retry)', async () => {
    const fetchFn = vi.fn(async () => respond(401, { message: 'Unauthorized' }));
    await expect(service(fetchFn as unknown as typeof fetch).lookup('BCDF-2345')).rejects.toBeInstanceOf(
      NotSignedInError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reports a network failure without leaking details', async () => {
    const svc = service((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    await expect(svc.lookup('BCDF-2345')).rejects.toMatchObject({ kind: 'network' });
  });

  it('rejects a lookup body without a label', async () => {
    const svc = service((async () => respond(200, ['x'])) as unknown as typeof fetch);
    await expect(svc.lookup('BCDF-2345')).rejects.toMatchObject({ kind: 'unexpected' });
  });
});

describe('untrusted display text', () => {
  it('strips control and bidi-override characters and caps length', () => {
    expect(displayText(`evil${String.fromCharCode(0x202e)}gnp.exe`)).toBe('evil gnp.exe');
    expect(displayText('a\u001b[31mred\u0007')).toBe('a [31mred');
    expect(displayText('  two\n\nlines ')).toBe('two lines');
    expect(displayText(42)).toBe('');
    expect(displayText('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('parses integer unix seconds only', () => {
    expect(parseTimestamp(1_760_000_000)).toBe(1_760_000_000_000);
    expect(parseTimestamp(1_760_000_000.5)).toBeNull();
    expect(parseTimestamp('1760000000')).toBeNull();
    expect(parseTimestamp(-1)).toBeNull();
    expect(parseTimestamp('soon')).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});
