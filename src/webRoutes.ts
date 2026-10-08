import type { RouteRecordRaw } from 'vue-router';
import AccountView from '@ui/app/views/AccountView.vue';

/**
 * The web's own routes, added to the shared route map (@ui/app/routes.ts
 * documents its shape) by router.ts:
 *
 *   /login   the GIS sign-in surface — the desktop has no equivalent;
 *   /account the account surface — the desktop opens it in a second WINDOW,
 *            the browser gets a route;
 *   /app     the web's host surface: sync unlock, host/key management, config
 *            import — the pieces the desktop does in ~/.ssh/config files. The
 *            shared picker owns CONNECTING; this page owns preparing hosts.
 *   /device  approve a `pocketshell login` (CLI device flow) request;
 *            `?code=XXXX-XXXX` only prefills the code field.
 */
export const webRoutes: RouteRecordRaw[] = [
  { path: '/account', name: 'account', component: AccountView },
  { path: '/app', name: 'app-hosts', component: () => import('./views/HostsView.vue') },
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
  { path: '/device', name: 'device', component: () => import('./views/DeviceView.vue') },
];
