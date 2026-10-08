// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent } from 'vue';
import type { CliSession } from '../src/api/deviceAuth';

const api = {
  listSessions: vi.fn<() => Promise<CliSession[]>>(),
  revokeSession: vi.fn<(id: string) => Promise<number>>(),
  revokeAllSessions: vi.fn<() => Promise<number>>(),
};

vi.mock('../src/api/deviceAuth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/deviceAuth')>();
  return { ...real, makeDeviceAuthService: () => api };
});

const { default: CliSessionsView } = await import('../src/views/CliSessionsView.vue');

function fakeIdToken(email: string, expIn = 3600): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'none' })}.${b64({ sub: '1', email, exp: Math.floor(Date.now() / 1000) + expIn })}.sig`;
}

const ROWS: CliSession[] = [
  {
    tokenId: '0123456789ab',
    label: 'me@laptop <b>x</b>',
    requestIp: '203.0.113.7',
    createdAt: Date.UTC(2026, 9, 1, 8, 0, 0),
    expiresAt: Date.UTC(2026, 9, 31, 8, 0, 0),
    lastUsedAt: Date.UTC(2026, 9, 7, 9, 0, 0),
  },
  {
    tokenId: 'abcdef012345',
    label: 'ci@runner',
    requestIp: '198.51.100.2',
    createdAt: Date.UTC(2026, 9, 2, 8, 0, 0),
    expiresAt: Date.UTC(2026, 10, 1, 8, 0, 0),
    lastUsedAt: null,
  },
];

let wrapper: VueWrapper | null = null;

async function mountView() {
  const Stub = defineComponent({ template: '<div />' });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/device/sessions', name: 'device-sessions', component: CliSessionsView },
      { path: '/device', name: 'device', component: Stub },
      { path: '/app', name: 'app-hosts', component: Stub },
      { path: '/login', name: 'login', component: Stub },
      { path: '/', name: 'hosts', component: Stub },
    ],
  });
  await router.push('/device/sessions');
  await router.isReady();
  const pinia = createPinia();
  setActivePinia(pinia);
  wrapper = mount(CliSessionsView, { global: { plugins: [pinia, router] }, attachTo: document.body });
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
  api.listSessions.mockReset().mockResolvedValue(ROWS);
  api.revokeSession.mockReset().mockResolvedValue(1);
  api.revokeAllSessions.mockReset().mockResolvedValue(2);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  sessionStorage.clear();
});

describe('/device/sessions view', () => {
  it('lists label, request IP, created, last used and expires as text', async () => {
    const { wrapper: w } = await mountView();
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    const rows = w.findAll('.sessions-row');
    expect(rows).toHaveLength(2);
    const first = rows[0].text();
    expect(first).toContain('me@laptop <b>x</b>');
    expect(w.find('.sessions-row b').exists()).toBe(false);
    expect(first).toContain('203.0.113.7');
    expect(first).toContain(new Date(ROWS[0].createdAt!).toLocaleString());
    expect(first).toContain(new Date(ROWS[0].lastUsedAt!).toLocaleString());
    expect(rows[1].text()).toContain('never');
  });

  it('shows the effective expiry and which limit applies', async () => {
    const now = Date.now();
    const DAY = 86_400_000;
    api.listSessions.mockResolvedValue([
      // used a day ago, hard expiry far off → the idle limit applies
      { ...ROWS[0], createdAt: now - 2 * DAY, lastUsedAt: now - DAY + 60_000, expiresAt: now + 28 * DAY },
      // used just now, hard expiry in 5 days → the 30-day limit applies
      { ...ROWS[1], createdAt: now - 25 * DAY, lastUsedAt: now - 60_000, expiresAt: now + 5 * DAY + 60_000 },
    ]);
    const { wrapper: w } = await mountView();
    const rows = w.findAll('.sessions-row');
    expect(rows[0].text()).toContain('expires in 13 days if unused');
    expect(rows[1].text()).toContain('expires in 5 days (30-day limit)');
    expect(rows[1].text()).toContain(new Date(now + 5 * DAY + 60_000).toLocaleString());
  });

  it('a session whose last use equals its creation reads as not used yet', async () => {
    api.listSessions.mockResolvedValue([{ ...ROWS[0], lastUsedAt: ROWS[0].createdAt }]);
    const { wrapper: w } = await mountView();
    expect(w.find('.sessions-row').text()).toContain('not used yet');
  });

  it('revokes one row by its token_id and reloads', async () => {
    const { wrapper: w } = await mountView();
    api.listSessions.mockResolvedValue([ROWS[1]]);
    await w.findAll('.sessions-row')[0].find('button').trigger('click');
    await flushPromises();
    expect(api.revokeSession.mock.calls).toEqual([['0123456789ab']]);
    expect(api.revokeAllSessions).not.toHaveBeenCalled();
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(w.findAll('.sessions-row')).toHaveLength(1);
    expect(w.find('[role="status"]').text()).toBe('Revoked 1 session.');
  });

  it('a row without a valid token_id has no per-row Revoke', async () => {
    api.listSessions.mockResolvedValue([{ ...ROWS[0], tokenId: null }]);
    const { wrapper: w } = await mountView();
    expect(w.find('.sessions-row button').exists()).toBe(false);
  });

  it('Revoke all asks first; Cancel revokes nothing', async () => {
    const { wrapper: w } = await mountView();
    await button(w, 'Revoke all').trigger('click');
    expect(api.revokeAllSessions).not.toHaveBeenCalled();
    expect(w.find('[role="alertdialog"]').text()).toContain('Revoke all 2 CLI sessions?');
    await button(w, 'Cancel').trigger('click');
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
    expect(api.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('Revoke all revokes after the confirmation', async () => {
    const { wrapper: w } = await mountView();
    await button(w, 'Revoke all').trigger('click');
    api.listSessions.mockResolvedValue([]);
    await button(w, 'Revoke all sessions').trigger('click');
    await flushPromises();
    expect(api.revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(api.revokeSession).not.toHaveBeenCalled();
    expect(w.find('[role="status"]').text()).toBe('Revoked 2 sessions.');
    expect(w.text()).toContain('No CLI sessions.');
  });

  it('shows broker errors', async () => {
    const { DeviceAuthError, deviceAuthErrorMessage } = await import('../src/api/deviceAuth');
    api.listSessions.mockRejectedValue(new DeviceAuthError('not_allowed', 403, deviceAuthErrorMessage('not_allowed')));
    const { wrapper: w } = await mountView();
    expect(w.find('[role="alert"]').text()).toMatch(/not allowed/);
  });

  it('an expired Google session goes through sign-in and returns here', async () => {
    const { NotSignedInError } = await import('../src/api/sync');
    api.listSessions.mockRejectedValue(new NotSignedInError('expired'));
    const { router } = await mountView();
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query).toEqual({ next: 'device-sessions' });
  });

  it('a stale ID token signs in again before calling anything', async () => {
    sessionStorage.setItem('ps.idToken', fakeIdToken('me@example.com', -10));
    const { router } = await mountView();
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe('login');
  });
});
