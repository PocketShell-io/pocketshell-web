import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { startForwarder } from './forward/forwarder';
import '@xterm/xterm/css/xterm.css';
import './style.css';

createApp(App).use(createPinia()).use(router).mount('#app');

// The /fwd/ service worker + its page side. Runs whether or not the user is
// signed in — requests are answered (with guidance) by the forwarder only
// when the stores can actually resolve a host.
startForwarder();
