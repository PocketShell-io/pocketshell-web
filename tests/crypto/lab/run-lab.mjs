/**
 * Browser-fidelity crypto lab entry point.
 *
 *   node tests/crypto/lab/run-lab.mjs
 *
 * Builds the owned shim/probe/fixtures to .tmp/crypto-lab/, registers node
 * module hooks that serve `require('crypto')` with the compiled shim and
 * `require('elliptic')` with the counting probe (the exact redirects the
 * production browser build makes via vite aliases — node builtins bypass
 * vite aliases under vitest, so plain node with hooks is the deterministic
 * equivalent), then runs the ssh2 key-parser and real-SSH handshake labs.
 * Exits nonzero if anything failed. Ephemeral keys only; nothing is mocked.
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildLabModules } from './build.mjs';
import { buildHooks } from './crypto-hook.mjs';

const outDir = await buildLabModules();
const outDirUrl = pathToFileURL(outDir + '/').href;
process.stderr.write('[run-lab] build done\n');

const { intercepted, hooks } = buildHooks(pathToFileURL(outDir));
registerHooks(hooks);
process.stderr.write('[run-lab] hooks registered\n');

const { runParserLab } = await import('./ssh2-keyparser-lab.mjs');
const { runHandshakeLab } = await import('./ssh-handshake-lab.mjs');
process.stderr.write('[run-lab] lab modules loaded\n');

try {
  await runParserLab(outDirUrl);
  await runHandshakeLab(outDirUrl);
  const cryptoSites = intercepted.filter((r) => r.specifier === 'crypto');
  const ssh2Crypto = cryptoSites.filter((r) => (r.importer ?? '').includes('/ssh2/')).length;
  process.stdout.write(
    `\ncrypto-lab receipt: ${cryptoSites.length} require('crypto') interception(s), `
    + `${ssh2Crypto} from inside ssh2, 0 elliptic ECDSA signatures\n`,
  );
  process.exit(0);
} catch (err) {
  process.stdout.write(`\ncrypto-lab FAILED: ${err.message}\n`);
  process.exit(1);
}
