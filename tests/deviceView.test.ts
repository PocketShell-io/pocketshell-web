// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent } from 'vue';
import type { DeviceRequestInfo } from '../src/api/deviceAuth';

const api = {
  lookup: vi.fn<(code: string) => Promise<DeviceRequestInfo>>(),
  decide: vi.fn<(code: string, approve: boolean) => Promise<'approved' | 'denied'>>(),
};

vi.mock('../src/api/deviceAuth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/deviceAuth')>();
  return { ...real, makeDeviceAuthService: () => api };
});

const { default: DeviceView } = await import('../src/views/DeviceView.vue');

function fakeIdToken(email: string): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'none' })}.${b64({ sub: '1', email, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

const INFO: DeviceRequestInfo = {
  label: 'alexey@laptop <img src=x onerror=alert(1)>',
  requestIp: '203.0.113.7',
  userAgent: 'pocketshell/1.2 (Linux)',
  createdAt: Date.UTC(2026, 9, 8, 7, 0, 0),
  expiresAt: Date.UTC(2026, 9, 8, 7, 10, 0),
  serverNow: Date.UTC(2026, 9, 8, 7, 0, 12),
  sameNetwork: true,
};

let wrapper: VueWrapper | null = null;

async function mountAt(path: string) {
  const Stub = defineComponent({ template: '<div />' });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/device', name: 'device', component: DeviceView },
      { path: '/device/sessions', name: 'device-sessions', component: Stub },
      { path: '/login', name: 'login', component: Stub },
      { path: '/', name: 'hosts', component: Stub },
    ],
  });
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  setActivePinia(pinia);
  wrapper = mount(DeviceView, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, router };
}

/** Opened from a `?code=BCDF-2345` link: type the last four, Continue. */
async function confirmAndContinue(w: VueWrapper, last4 = '2345') {
  await w.find('#device-confirm').setValue(last4);
  await w.find('form').trigger('submit');
  await flushPromises();
}

function button(w: VueWrapper, text: string) {
  const b = w.findAll('button').find((x) => x.text() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

beforeEach(() => {
  sessionStorage.setItem('ps.idToken', fakeIdToken('me@example.com'));
  sessionStorage.setItem('ps.email', 'me@example.com');
  api.lookup.mockReset().mockResolvedValue(INFO);
  api.decide.mockReset().mockImplementation(async (_c, approve) => (approve ? 'approved' : 'denied'));
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  sessionStorage.clear();
});

describe('/device view', () => {
  it('a ?code= link shows only the first half, calls nothing, and Continue stays shut', async () => {
    const { wrapper: w } = await mountAt('/device?code=bcdf-2345');
    expect(w.text()).toContain('BCDF-····');
    expect(w.text()).not.toContain('2345');
    expect(w.find('#device-code').exists()).toBe(false);
    expect(w.text()).toContain('Type the last 4 characters of the code shown in your terminal');
    expect(button(w, 'Continue').attributes('disabled')).toBeDefined();
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(api.lookup).not.toHaveBeenCalled();
    expect(api.decide).not.toHaveBeenCalled();
    expect(w.findAll('button').some((b) => b.text() === 'Approve')).toBe(false);
  });

  it('a wrong last four is refused with a hint; the right four opens Continue', async () => {
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await w.find('#device-confirm').setValue('ghjk');
    expect(w.find('[role="alert"]').text()).toMatch(/does not match the code in the link/);
    expect(button(w, 'Continue').attributes('disabled')).toBeDefined();
    await w.find('#device-confirm').setValue('2345');
    expect(button(w, 'Continue').attributes('disabled')).toBeUndefined();
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(api.lookup.mock.calls).toEqual([['BCDF-2345']]);
  });

  it('"Type the whole code instead" drops the link code', async () => {
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await button(w, 'Type the whole code instead').trigger('click');
    const input = w.find('#device-code');
    expect((input.element as HTMLInputElement).value).toBe('');
    await input.setValue('ghjk6789');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(api.lookup.mock.calls).toEqual([['GHJK-6789']]);
  });

  it('normalizes typed input', async () => {
    const { wrapper: w } = await mountAt('/device');
    const input = w.find('#device-code');
    await input.setValue('bc-df 23o4 5');
    expect((input.element as HTMLInputElement).value).toBe('BCDF-2345');
  });

  it('a long paste stays long and invalid (no maxlength, no truncation)', async () => {
    const { wrapper: w } = await mountAt('/device');
    const input = w.find('#device-code');
    expect(input.attributes('maxlength')).toBeUndefined();
    await input.setValue('BCDF-2345-GHJK');
    expect((input.element as HTMLInputElement).value).toBe('BCDF-2345GHJK');
    expect(w.find('[role="alert"]').text()).toMatch(/longer than a code/);
    expect(w.find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it('shows the request as text, warns, and does not approve on review', async () => {
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await confirmAndContinue(w);
    expect(api.lookup.mock.calls).toEqual([['BCDF-2345']]);
    const text = w.text();
    expect(text).toContain('alexey@laptop <img src=x onerror=alert(1)>');
    expect(w.find('img').exists()).toBe(false);
    expect(text).toContain('203.0.113.7');
    expect(text).toContain('pocketshell/1.2 (Linux)');
    expect(text).toContain('me@example.com');
    expect(text).toContain(new Date(INFO.createdAt!).toLocaleString());
    expect(text).toContain('requested 12 seconds ago');
    expect(text).toContain('expires in 9:48');
    expect(text).toContain('Machine name (reported by the machine, not verified)');
    expect(text).toContain(
      'Only approve if you just ran pocketshell login yourself and the code matches. Approving lets that machine act as you on the PocketShell gateway — enroll hosts, connect to your hosts, and remove or revoke your devices — for up to 30 days (14 days if unused).',
    );
    // Same network: no red warning, no checkbox, Approve open.
    expect(w.find('.device-danger').exists()).toBe(false);
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    expect(button(w, 'Approve').attributes('disabled')).toBeUndefined();
    const approve = button(w, 'Approve');
    expect(approve.attributes('type')).toBe('button');
    expect(approve.attributes('autofocus')).toBeUndefined();
    expect(document.activeElement).not.toBe(approve.element);
    // No form wraps the decision, so Enter cannot submit one.
    expect(w.find('form').exists()).toBe(false);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('a different-network request shows the red warning and needs the tick before Approve', async () => {
    api.lookup.mockResolvedValue({ ...INFO, sameNetwork: false });
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await confirmAndContinue(w);
    const danger = w.find('.device-danger');
    expect(danger.exists()).toBe(true);
    expect(danger.attributes('role')).toBe('alert');
    expect(danger.text()).toContain(
      'This request came from a different network than you. If you did not just run pocketshell login on another machine yourself, click Deny.',
    );
    const approve = button(w, 'Approve');
    expect(approve.attributes('disabled')).toBeDefined();
    await approve.trigger('click');
    await flushPromises();
    expect(api.decide).not.toHaveBeenCalled();
    // Deny is always available.
    expect(button(w, 'Deny').attributes('disabled')).toBeUndefined();
    await w.find('.device-danger input[type="checkbox"]').setValue(true);
    expect(button(w, 'Approve').attributes('disabled')).toBeUndefined();
    await button(w, 'Approve').trigger('click');
    await flushPromises();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', true]]);
  });

  it('the countdown ticks on the broker clock and an expired request cannot be approved', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
      await confirmAndContinue(w);
      expect(w.text()).toContain('expires in 9:48');
      await vi.advanceTimersByTimeAsync(3000);
      expect(w.text()).toContain('requested 15 seconds ago');
      expect(w.text()).toContain('expires in 9:45');
      await vi.advanceTimersByTimeAsync(600_000);
      expect(w.text()).toContain('expired');
      expect(button(w, 'Approve').attributes('disabled')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('approves only on the Approve click', async () => {
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await confirmAndContinue(w);
    await w.find('h1').trigger('keydown', { key: 'Enter' });
    expect(api.decide).not.toHaveBeenCalled();
    await button(w, 'Approve').trigger('click');
    await flushPromises();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', true]]);
    expect(w.text()).toContain('Sign-in approved');
    const link = w.findAll('a').find((x) => x.text() === 'Manage CLI sessions');
    expect(link?.attributes('href')).toBe('/device/sessions');
  });

  it('denies on the Deny click', async () => {
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await confirmAndContinue(w);
    await button(w, 'Deny').trigger('click');
    await flushPromises();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', false]]);
    expect(w.text()).toContain('Sign-in denied');
  });

  it('shows a lookup error and stays on the code step', async () => {
    const { DeviceAuthError, deviceAuthErrorMessage } = await import('../src/api/deviceAuth');
    api.lookup.mockRejectedValue(new DeviceAuthError('too_many_attempts', 429, deviceAuthErrorMessage('too_many_attempts')));
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await confirmAndContinue(w);
    expect(w.find('[role="alert"]').text()).toMatch(/Too many attempts/);
    expect(w.find('#device-confirm').exists()).toBe(true);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('a lookup_required approve shows its own message on the code step', async () => {
    const { DeviceAuthError, deviceAuthErrorMessage } = await import('../src/api/deviceAuth');
    api.decide.mockRejectedValue(new DeviceAuthError('lookup_required', 403, deviceAuthErrorMessage('lookup_required')));
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await confirmAndContinue(w);
    await button(w, 'Approve').trigger('click');
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toBe('Look up the code again before approving.');
    expect(w.text()).not.toMatch(/not allowed/);
    expect((w.find('#device-code').element as HTMLInputElement).value).toBe('BCDF-2345');
    expect(w.findAll('button').some((b) => b.text() === 'Approve')).toBe(false);
  });

  it('an expired session goes back through sign-in, keeping the code', async () => {
    const { NotSignedInError } = await import('../src/api/sync');
    api.lookup.mockRejectedValue(new NotSignedInError('expired'));
    const { wrapper: w, router } = await mountAt('/device?code=BCDF-2345');
    await confirmAndContinue(w);
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query).toEqual({ next: 'device', code: 'BCDF-2345' });
    expect(sessionStorage.getItem('ps.idToken')).toBeNull();
  });
});
