import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'hosts', component: () => import('./views/HostsView.vue') },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
    { path: '/term/:name', name: 'term', component: () => import('./views/TerminalView.vue') },
  ],
});
