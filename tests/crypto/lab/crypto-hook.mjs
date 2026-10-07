/**
 * Module-customization hooks for the browser-fidelity crypto lab.
 *
 * `crypto` is redirected to the compiled src/shims/ssh2-crypto.ts and
 * `elliptic` to the counting probe — exactly the two redirects the lab
 * needs to reproduce the production browser build's wiring. Everything
 * else (ssh2, crypto-browserify, browserify-sign, elliptic's own deep
 * path, bcrypt-pbkdf, …) resolves natively; node has no polyfill plugin
 * to lean on here, and node builtins bypass vite aliases in vitest, so
 * hooks are the only deterministic interception point for `require('crypto')`
 * coming out of an externalized CJS dependency.
 *
 * Only EXACT specifiers are intercepted: the probe itself loads the real
 * library through `elliptic/lib/elliptic.js`, which falls through.
 */
import { pathToFileURL } from 'node:url';

export function buildHooks(builtDirUrl) {
  const dirHref = builtDirUrl.href.endsWith('/') ? builtDirUrl.href : `${builtDirUrl.href}/`;
  const shimUrl = new URL('ssh2-crypto.cjs', dirHref).href;
  const probeUrl = new URL('elliptic-probe.cjs', dirHref).href;
  const intercepted = [];
  return {
    intercepted,
    hooks: {
      resolve(specifier, context, nextResolve) {
        const importer = context.parentURL ?? '';
        // Scope matters: serving 'crypto' to the crypto-browserify subtree
        // would create a require cycle (randombytes -> crypto -> shim ->
        // crypto-browserify -> randombytes). The browser build wires exactly
        // two points of interest: ssh2's crypto calls go to the shim, and
        // browserify-sign's elliptic goes through the probe.
        if (specifier === 'crypto' && importer.includes('/node_modules/ssh2/')) {
          intercepted.push({ specifier, importer });
          return { url: shimUrl, format: 'commonjs', shortCircuit: true };
        }
        if (specifier === 'elliptic' && importer.includes('/node_modules/browserify-sign/')) {
          intercepted.push({ specifier, importer });
          return { url: probeUrl, format: 'commonjs', shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    },
  };
}

export { pathToFileURL };
