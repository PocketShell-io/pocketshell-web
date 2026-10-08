import { describe, expect, it } from 'vitest';
import { afterLoginTarget, loginQueryFor } from '../src/auth/returnTo';

describe('sign-in return target', () => {
  it('a signed-out /device visit keeps its (valid) code through sign-in', () => {
    const q = loginQueryFor({ name: 'device', query: { code: 'bcdf2345' } });
    expect(q).toEqual({ next: 'device', code: 'BCDF-2345' });
    expect(afterLoginTarget(q as never)).toEqual({ name: 'device', query: { code: 'BCDF-2345' } });
  });

  it('drops a malformed code but still returns to /device', () => {
    const q = loginQueryFor({ name: 'device', query: { code: '<script>' } });
    expect(q).toEqual({ next: 'device' });
    expect(afterLoginTarget(q as never)).toEqual({ name: 'device', query: {} });
  });

  it('a signed-out /device/sessions visit comes back there, with no query carried', () => {
    const q = loginQueryFor({ name: 'device-sessions', query: { evil: 'x' } });
    expect(q).toEqual({ next: 'device-sessions' });
    expect(afterLoginTarget(q as never)).toEqual({ name: 'device-sessions' });
  });

  it('other routes keep the old behavior: query rides along, sign-in lands home', () => {
    expect(loginQueryFor({ name: 'account', query: { a: '1' } })).toEqual({ a: '1' });
    expect(afterLoginTarget({})).toEqual({ name: 'hosts' });
  });

  it('next is a closed set, never a URL', () => {
    expect(afterLoginTarget({ next: 'https://evil.example/' })).toEqual({ name: 'hosts' });
    expect(afterLoginTarget({ next: '/device' })).toEqual({ name: 'hosts' });
  });
});
