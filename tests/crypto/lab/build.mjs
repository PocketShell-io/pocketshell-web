/**
 * Compiles the shim, the elliptic probe and the key fixtures to CJS in
 * .tmp/crypto-lab/ so the module hooks can serve them to native require().
 * crypto-browserify/tweetnacl/elliptic stay external: the whole point is
 * that the REAL libraries run — the shim must be the code under test, and
 * the probe must receive the exact elliptic instance browserify-sign uses.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const outDir = join(repo, '.tmp', 'crypto-lab');

export async function buildLabModules() {
  mkdirSync(outDir, { recursive: true });
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  };
  await esbuild.build({
    ...common,
    entryPoints: [join(repo, 'src', 'shims', 'ssh2-crypto.ts')],
    outfile: join(outDir, 'ssh2-crypto.cjs'),
    external: ['crypto-browserify', 'node:buffer', 'tweetnacl'],
  });
  await esbuild.build({
    ...common,
    entryPoints: [join(repo, 'tests', 'crypto', 'elliptic-probe.ts')],
    outfile: join(outDir, 'elliptic-probe.cjs'),
    external: ['elliptic'],
  });
  await esbuild.build({
    ...common,
    entryPoints: [join(repo, 'tests', 'crypto', 'keys.ts')],
    outfile: join(outDir, 'keys.cjs'),
  });
  return outDir;
}
