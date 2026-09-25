import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { startForwarder } from './forward/forwarder';
import '@xterm/xterm/css/xterm.css';
// The desktop's own first import: shared tokens, primitives, Inter. Ours
// follows so app rules keep winning the cascade where both define a class.
import '@ui/styles.css';
import './style.css';
// The browser transport IS the platform. The shared app tree receives it
// through the seam; this is the one line that binds them.
import { provideApi, api } from '@ui/app/ipc';
import { recordDiagError } from '@ui/app/diag';
import { webApi } from './platform/webApi';
import { armNavGuard } from './platform/navGuard';
import { useConnectionStore } from '@ui/app/stores/connection';

provideApi(webApi);

const app = createApp(App);
// The desktop's three nets under "an unhandled renderer error must be
// visible", wired the same way: Vue's pipeline, unhandled rejections, and
// window-level errors all land in the diag strip instead of a blank screen.
app.config.errorHandler = (err): void => {
  recordDiagError('render', err);
};
window.addEventListener('unhandledrejection', (e) => {
  recordDiagError('unhandledrejection', e.reason);
});
window.addEventListener('error', (e) => {
  if (e.error) recordDiagError('error', e.error);
});

const pinia = createPinia();
app.use(pinia).use(router).mount('#app');

// Sleep/wake (FEATURES.md F12): the desktop's main announces the OS resume;
// the browser has no such announcement, but the subscription is cheap and
// the store's liveness probe still answers a resumed tab that lost its
// relay socket while the OS slept.
api.app.onResumed(() => void useConnectionStore(pinia).onOsResume());

// The one brake a browser tab has on its reserved chords (Ctrl+W) and its
// close button: the generic leave dialog, asked only while a workspace is
// open. The why lives in platform/navGuard.ts.
armNavGuard(pinia);

// The /fwd/ service worker + its page side. Runs whether or not the user is
// signed in — requests are answered (with guidance) by the forwarder only
// when the stores can actually resolve a host.
startForwarder();
