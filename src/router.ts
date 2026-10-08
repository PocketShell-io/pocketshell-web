import { createRouter, createWebHistory } from 'vue-router';
import { createAppRoutes } from '@ui/app/routes';
import { webRoutes } from './webRoutes';
import { useAuthStore } from './stores/auth';
import { afterLoginTarget, loginQueryFor } from './auth/returnTo';

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to) {
    if (to.hash) return { el: to.hash };
    return { top: 0 };
  },
  routes: createAppRoutes(webRoutes),
});

/**
 * The one web-specific routing rule: nothing outside the sign-in surface is
 * reachable without a Google session. The desktop's router carries no guard
 * because the OS account is always there; the browser's is not. The query
 * rides along so a deep link (or a future OAuth return) survives the bounce;
 * the CLI-approval page (/device) additionally asks to come back after
 * sign-in, with its user code (auth/returnTo.ts).
 */
router.beforeEach((to) => {
  if (!useAuthStore().signedIn && to.name !== 'login') {
    return { name: 'login', query: loginQueryFor(to) };
  }
  if (useAuthStore().signedIn && to.name === 'login') {
    return afterLoginTarget(to.query);
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
  device: 'Approve a CLI sign-in — PocketShell',
};

router.afterEach((to) => {
  document.title = titles[String(to.name)] ?? 'PocketShell';
  // The app is functional-only: the indexable marketing surface is the
  // static site on pocketshell.io, so every app route stays out of the index.
  document
    .querySelector('meta[name="robots"]')
    ?.setAttribute('content', 'noindex, nofollow');
});
