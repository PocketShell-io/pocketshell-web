import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to) {
    if (to.hash) return { el: to.hash };
    return { top: 0 };
  },
  routes: [
    { path: '/', name: 'landing', component: () => import('./views/LandingView.vue') },
    { path: '/app', name: 'hosts', component: () => import('./views/HostsView.vue') },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
    { path: '/term/:name', name: 'term', component: () => import('./views/TerminalView.vue') },
    { path: '/:pathMatch(.*)*', redirect: { name: 'landing' } },
  ],
});

const titles: Record<string, string> = {
  landing: 'PocketShell - SSH in your browser tab',
  login: 'Sign in — PocketShell',
  hosts: 'Hosts — PocketShell',
  term: 'PocketShell',
};

router.afterEach((to) => {
  document.title = titles[String(to.name)] ?? 'PocketShell';
});
