import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  // Polyfills are for the browser bundle only — vitest runs in real Node and
  // the browser shims would break its node:fs/node:stream. The overrides beat
  // the plugin's defaults where they cannot answer ssh2's import-time probes:
  // zlib's missing `constants`, and node-only crypto APIs (keygen etc.).
  plugins: [
    vue(),
    ...(process.env.VITEST
      ? []
      : [
          nodePolyfills({
            overrides: {
              zlib: fileURLToPath(new URL('./src/shims/ssh2-zlib.ts', import.meta.url)),
              crypto: fileURLToPath(new URL('./src/shims/ssh2-crypto.ts', import.meta.url)),
            },
          }),
        ]),
  ],
  build: {
    rollupOptions: {
      output: {
        // One bare `module.exports={}` from ssh2's mixed-format code survives
        // the CommonJS transform (its real exports ride the generated
        // namespace). Browsers have no `module`, and loading the chunk threw
        // `module is not defined` — a per-chunk inert stub keeps that dead
        // statement harmless.
        intro: 'typeof globalThis.module === "undefined" && (globalThis.module = { exports: {} });',
      },
    },
  },
  resolve: {
    alias: {
      // ssh2's optional native addon cannot enter a browser bundle; the
      // stub sends it down the portable code path.
      'cpu-features': fileURLToPath(new URL('./src/shims/cpu-features.ts', import.meta.url)),
      // ssh2's optional native crypto binding — same story as cpu-features.
      '/build/Release/sshcrypto.node': fileURLToPath(new URL('./src/shims/cpu-features.ts', import.meta.url)),
      // ssh2's SSH-agent support is node-only (net/child_process, __dirname
      // at module scope); the direct session never uses an agent.
      './agent.js': fileURLToPath(new URL('./src/shims/ssh2-agent.ts', import.meta.url)),
      // The shared interface package (@pocketshell/ui) rides in the same
      // core sibling the file: dependency uses — one UI source for desktop,
      // web and Android, consumed as source.
      '@ui': fileURLToPath(new URL('../pocketshell-core/packages/ui/src', import.meta.url)),
    },
  },
});
