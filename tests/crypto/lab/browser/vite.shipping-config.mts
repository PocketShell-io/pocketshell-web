/**
 * Vite config for the shipping-wiring browser lab. It loads the REAL
 * production config (vite.config.ts) through vite's own config loader — the
 * same plugins, the same node-polyfill crypto/zlib overrides, the same
 * resolve aliases the app ships with — and adds exactly one thing: a second
 * HTML entry (the lab page) and a lab-only outDir. No production source file
 * is modified; if vite.config.ts changes, this lab follows it.
 */
import { fileURLToPath, URL } from 'node:url';
import { loadConfigFromFile, mergeConfig, type UserConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  fileURLToPath(new URL('../../../../vite.config.ts', import.meta.url)),
);
if (!loaded) throw new Error('shipping lab: could not load vite.config.ts');
const base: UserConfig = loaded.config;

export default mergeConfig(base, {
  build: {
    outDir: fileURLToPath(new URL('../../../../.tmp/crypto-shipping/dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // the real app entry, built by the same run for full fidelity
        app: 'index.html',
        shippingLab: 'tests/crypto/lab/browser/page/shipping-lab.html',
      },
    },
  },
  // help vite resolve the lab page's imports during config validation
  root: repoRoot,
});
