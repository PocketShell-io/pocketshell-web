import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to) {
    if (to.hash) return { el: to.hash };
    return { top: 0 };
  },
  routes: [
    { path: '/', name: 'login', component: () => import('./views/LoginView.vue') },
    { path: '/app', name: 'hosts', component: () => import('./views/HostsView.vue') },
    { path: '/login', redirect: '/' },
    { path: '/term/:name', name: 'term', component: () => import('./views/TermRoute.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

const titles: Record<string, string> = {
  login: 'Sign in — PocketShell',
  hosts: 'Hosts — PocketShell',
  term: 'PocketShell',
};

router.afterEach((to) => {
  document.title = titles[String(to.name)] ?? 'PocketShell';
  // The app is functional-only: the indexable marketing surface is the
  // static site on pocketshell.io, so every app route stays out of the index.
  document
    .querySelector('meta[name="robots"]')
    ?.setAttribute('content', 'noindex, nofollow');
});
