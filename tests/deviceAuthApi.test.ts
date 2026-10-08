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
        now: 1_760_000_012,
        same_network: true,
      }),
    );
    const info = await service(fetchFn as unknown as typeof fetch).lookup('BCDF-2345');
    expect(info).toEqual({
      label: 'alexey@laptop',
      requestIp: '203.0.113.7',
      userAgent: 'pocketshell/1.2 (Linux)',
      createdAt: 1_760_000_000_000,
      expiresAt: 1_760_000_600_000,
      serverNow: 1_760_000_012_000,
      sameNetwork: true,
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

  it('same_network is true only for a literal true; now is optional', async () => {
    for (const same of [false, 'true', 1, null, undefined]) {
      const fetchFn = vi.fn(async () => respond(200, { label: 'x', same_network: same }));
      const info = await service(fetchFn as unknown as typeof fetch).lookup('BCDF-2345');
      expect(info.sameNetwork).toBe(false);
      expect(info.serverNow).toBeNull();
    }
  });

  it('strips every Unicode "Other" character and blank-looking fillers, keeps spaces', () => {
    const cps = (...c: number[]) => String.fromCodePoint(...c);
    // Cf: zero-width space/joiners, LRM/RLM, isolates, BOM, soft hyphen, tag chars.
    expect(displayText(`a${cps(0x200b, 0x200d, 0x200e, 0x2066, 0x2069, 0xfeff, 0xad)}b`)).toBe('a b');
    expect(displayText(`me${cps(0xe0041, 0xe0042)}@laptop`)).toBe('me @laptop');
    // Co private use (BMP and plane 15), Cn unassigned, Cs lone surrogate.
    expect(displayText(`x${cps(0xe000)}y${cps(0xf0000)}z`)).toBe('x y z');
    expect(displayText(`x${cps(0x0378)}y`)).toBe('x y');
    expect(displayText('x\ud800y')).toBe('x y');
    // Hangul fillers and the braille blank render as nothing/blank.
    expect(displayText(`root${cps(0x3164)}@${cps(0x115f, 0x1160)}box${cps(0x2800)}`)).toBe('root @ box');
    expect(displayText(`a${cps(0xffa0)}b`)).toBe('a b');
    // Line/paragraph separators collapse like any whitespace.
    expect(displayText('a\u2028b\u2029c')).toBe('a b c');
    // Normal text, normal spaces and non-Latin letters/emoji survive.
    expect(displayText('alexey @ work-laptop')).toBe('alexey @ work-laptop');
    expect(displayText('Алексей ноутбук 🙂')).toBe('Алексей ноутбук 🙂');
  });

  it('caps by code point, never splitting a surrogate pair', () => {
    expect(displayText('🙂🙂🙂', 2)).toBe('🙂…');
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
