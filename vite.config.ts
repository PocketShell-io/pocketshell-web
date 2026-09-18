import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  // Polyfills are for the browser bundle only — vitest runs in real Node and
  // the browser shims would break its node:fs/node:stream.
  plugins: [vue(), ...(process.env.VITEST ? [] : [nodePolyfills()])],
  resolve: {
    alias: {
      // ssh2's optional native addon cannot enter a browser bundle; the
      // stub sends it down the portable code path.
      'cpu-features': fileURLToPath(new URL('./src/shims/cpu-features.ts', import.meta.url)),
      // ssh2's optional native crypto binding — same story as cpu-features.
      '/build/Release/sshcrypto.node': fileURLToPath(new URL('./src/shims/cpu-features.ts', import.meta.url)),
    },
  },
});
