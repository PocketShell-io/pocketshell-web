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
};

let wrapper: VueWrapper | null = null;

async function mountAt(path: string) {
  const Stub = defineComponent({ template: '<div />' });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/device', name: 'device', component: DeviceView },
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
  it('a ?code= link prefills the field and calls nothing', async () => {
    const { wrapper: w } = await mountAt('/device?code=bcdf-2345');
    expect((w.find('#device-code').element as HTMLInputElement).value).toBe('BCDF-2345');
    expect(api.lookup).not.toHaveBeenCalled();
    expect(api.decide).not.toHaveBeenCalled();
    expect(w.findAll('button').some((b) => b.text() === 'Approve')).toBe(false);
  });

  it('normalizes typed input', async () => {
    const { wrapper: w } = await mountAt('/device');
    const input = w.find('#device-code');
    await input.setValue('bc-df 23o4 5');
    expect((input.element as HTMLInputElement).value).toBe('BCDF-2345');
  });

  it('shows the request as text, warns, and does not approve on review', async () => {
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(api.lookup.mock.calls).toEqual([['BCDF-2345']]);
    const text = w.text();
    expect(text).toContain('alexey@laptop <img src=x onerror=alert(1)>');
    expect(w.find('img').exists()).toBe(false);
    expect(text).toContain('203.0.113.7');
    expect(text).toContain('pocketshell/1.2 (Linux)');
    expect(text).toContain('me@example.com');
    expect(text).toContain(new Date(INFO.createdAt!).toLocaleString());
    expect(text).toContain(
      'Only approve if you just ran pocketshell login yourself and the code matches. Approving gives that machine access to your PocketShell gateway account (enroll hosts, connect to your hosts) for 30 days.',
    );
    const approve = button(w, 'Approve');
    expect(approve.attributes('type')).toBe('button');
    expect(approve.attributes('autofocus')).toBeUndefined();
    expect(document.activeElement).not.toBe(approve.element);
    // No form wraps the decision, so Enter cannot submit one.
    expect(w.find('form').exists()).toBe(false);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('approves only on the Approve click', async () => {
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await w.find('form').trigger('submit');
    await flushPromises();
    await w.find('h1').trigger('keydown', { key: 'Enter' });
    expect(api.decide).not.toHaveBeenCalled();
    await button(w, 'Approve').trigger('click');
    await flushPromises();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', true]]);
    expect(w.text()).toContain('Sign-in approved');
  });

  it('denies on the Deny click', async () => {
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await w.find('form').trigger('submit');
    await flushPromises();
    await button(w, 'Deny').trigger('click');
    await flushPromises();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', false]]);
    expect(w.text()).toContain('Sign-in denied');
  });

  it('shows a lookup error and stays on the code step', async () => {
    const { DeviceAuthError, deviceAuthErrorMessage } = await import('../src/api/deviceAuth');
    api.lookup.mockRejectedValue(new DeviceAuthError('too_many_attempts', 429, deviceAuthErrorMessage('too_many_attempts')));
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.find('[role="alert"]').text()).toMatch(/Too many attempts/);
    expect(w.find('#device-code').exists()).toBe(true);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('a lookup_required approve shows its own message on the code step', async () => {
    const { DeviceAuthError, deviceAuthErrorMessage } = await import('../src/api/deviceAuth');
    api.decide.mockRejectedValue(new DeviceAuthError('lookup_required', 403, deviceAuthErrorMessage('lookup_required')));
    const { wrapper: w } = await mountAt('/device?code=BCDF-2345');
    await w.find('form').trigger('submit');
    await flushPromises();
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
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query).toEqual({ next: 'device', code: 'BCDF-2345' });
    expect(sessionStorage.getItem('ps.idToken')).toBeNull();
  });
});
