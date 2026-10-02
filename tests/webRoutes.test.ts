import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createAppRoutes, SHARED_ROUTE_NAMES } from '@ui/app/routes';
import { webRoutes } from '../src/webRoutes';

/**
 * The web's router is the SHARED route map plus the web's own three routes
 * (#2949) — no copied map. Resolved in a real router on memory history (the
 * app's own web history needs a browser `window`).
 */
describe('web routes on the shared map', () => {
  const router = createRouter({ history: createMemoryHistory(), routes: createAppRoutes(webRoutes) });

  it('names the shared routes plus exactly login, account and app-hosts', () => {
    const names = router.getRoutes().map((r) => r.name).filter(Boolean).map(String).sort();
    expect(names).toEqual([...SHARED_ROUTE_NAMES, 'account', 'app-hosts', 'login'].sort());
  });

  it('resolves shared and web paths, and sends an unknown path home', async () => {
    expect(router.resolve('/host/dev/folder/~%2Fgit%2Fx').name).toBe('folder');
    expect(router.resolve('/login').name).toBe('login');
    expect(router.resolve('/account').name).toBe('account');
    await router.push('/no/such/page');
    expect(router.currentRoute.value.name).toBe('hosts');
  });
});
