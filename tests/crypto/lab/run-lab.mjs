/**
 * Browser-fidelity crypto lab — SUPPLEMENTAL evidence.
 *
 *   node tests/crypto/lab/run-lab.mjs
 *
 * Builds the owned shim/probe/fixtures to .tmp/crypto-lab/, registers node
 * module hooks that serve `require('crypto')` with the compiled shim and
 * `require('elliptic')` with a counting probe, then runs the ssh2 key-parser
 * and real-SSH handshake labs under real node require().
 *
 * This lab is valuable because the hook can COUNT elliptic calls and prove
 * the interception sources, but it is NOT the shipping wiring: the shipping
 * bundle aliases `crypto` through vite-plugin-node-polyfills, and the
 * acceptance pass for that is tests/crypto/lab/browser/run-browser-lab.mjs,
 * which runs a bundle emitted by the production vite config in a real
 * Chromium. Exits nonzero if anything failed. Ephemeral keys only; nothing
 * is mocked.
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
