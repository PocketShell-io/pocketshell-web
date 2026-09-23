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

createApp(App).use(createPinia()).use(router).mount('#app');

// The /fwd/ service worker + its page side. Runs whether or not the user is
// signed in — requests are answered (with guidance) by the forwarder only
// when the stores can actually resolve a host.
startForwarder();
