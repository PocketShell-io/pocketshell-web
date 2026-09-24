import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import HostPickerView from '@ui/app/views/HostPickerView.vue';
import HostWorkspaceView from '@ui/app/views/HostWorkspaceView.vue';
import FolderWorkspaceView from '@ui/app/views/FolderWorkspaceView.vue';
import SessionPlaceholderView from '@ui/app/views/SessionPlaceholderView.vue';
import SessionRedirectView from '@ui/app/views/SessionRedirectView.vue';
import AccountView from '@ui/app/views/AccountView.vue';
import { useAuthStore } from './stores/auth';

/**
 * The DESKTOP's route map on the WEB's history. Three levels, each with a
 * route so "back" is a real navigation (the desktop router.ts comment is the
 * authority for the shape):
 *
 *   hosts          -> pick a host
 *   host-sessions  -> connected host, no folder picked yet
 *   folder         -> one FOLDER's workspace: a tab per session, plus Files
 *   session/:session -> resolver that replaces itself with the folder
 *
 * `:folder` is the folder's directoryKey — `~/git/dtc-website`. vue-router
 * encodes route params, so the slashes and the `~` survive a round trip.
 * The active tab is a QUERY parameter (`?tab=<id>`), not a path segment.
 *
 * The two web-only routes: /login (the GIS sign-in surface — the desktop has
 * no equivalent) and /account (the desktop opens the account surface in a
 * second WINDOW; the browser gets a route).
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'hosts', component: HostPickerView },
  {
    path: '/host/:name',
    component: HostWorkspaceView,
    children: [
      { path: '', name: 'host-sessions', component: SessionPlaceholderView },
      {
        path: 'folder/:folder',
        name: 'folder',
        component: FolderWorkspaceView,
      },
      {
        path: 'session/:session',
        name: 'session',
        component: SessionRedirectView,
      },
    ],
  },
  { path: '/account', name: 'account', component: AccountView },
  // The web's own host surface: sync unlock, host/key management, config
  // import — the pieces the desktop does in ~/.ssh/config files. The shared
  // picker owns CONNECTING; this page owns preparing hosts for it.
  { path: '/app', name: 'app-hosts', component: () => import('./views/HostsView.vue') },
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to) {
    if (to.hash) return { el: to.hash };
    return { top: 0 };
  },
  routes,
});

/**
 * The one web-specific routing rule: nothing outside the sign-in surface is
 * reachable without a Google session. The desktop's router carries no guard
 * because the OS account is always there; the browser's is not. The query
 * rides along so a deep link (or a future OAuth return) survives the bounce.
 */
router.beforeEach((to) => {
  if (!useAuthStore().signedIn && to.name !== 'login') {
    return { name: 'login', query: to.query };
  }
  if (useAuthStore().signedIn && to.name === 'login') {
    return { name: 'hosts' };
  }
  // `/` is the home, unconditionally once signed in — the same picker the
  // desktop opens on. A signed-in-but-locked account sees the picker's
  // locked note and reaches the unlock through Account & sync; bouncing to
  // the manage surface instead made the app open on a different screen than
  // every back path returns to.
  return true;
});

const titles: Record<string, string> = {
  login: 'Sign in — PocketShell',
  'app-hosts': 'Your hosts — PocketShell',
  hosts: 'Hosts — PocketShell',
  account: 'Account & sync — PocketShell',
};

router.afterEach((to) => {
  document.title = titles[String(to.name)] ?? 'PocketShell';
  // The app is functional-only: the indexable marketing surface is the
  // static site on pocketshell.io, so every app route stays out of the index.
  document
    .querySelector('meta[name="robots"]')
    ?.setAttribute('content', 'noindex, nofollow');
});
