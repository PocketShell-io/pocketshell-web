/**
 * Shipping-wiring browser lab — the acceptance pass for the corrective
 * task: the code under test is the bundle the PRODUCTION vite pipeline
 * emits (real vite.config.ts: node-polyfills crypto→src/shims/ssh2-crypto
 * override, cpu-features/agent stubs, buffer/stream polyfills), running in
 * a real Chromium, dialing a real in-process ssh2 server through a WS
 * bridge with connection.ts's exact algorithm config.
 *
 *   node tests/crypto/lab/browser/run-browser-lab.mjs
 *
 * Stages: (1) vite build with the shipping config + one lab HTML entry,
 * (2) harness up (ssh server + bridge + static), (3) headless Chromium via
 * CDP runs the flow matrix, (4) assertions on browser results, probe
 * counters and the server-side auth trace, (5) full teardown, raw exit.
 * Ephemeral keys only; nothing is mocked on the parse/sign path.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { BrowserLabHarness } from './harness.mjs';
import { withBrowser } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const distDir = join(repo, '.tmp', 'crypto-shipping', 'dist');
const logDir = join(repo, '.tmp', 'crypto-shipping');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: repo, stdio: 'inherit', ...opts });
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => {
      console.error(`${cmd} failed to start: ${err.message}`);
      resolve({ code: 127, signal: null });
    });
  });
}

async function main() {
  mkdirSync(logDir, { recursive: true });
  // the lab must never drain its event loop and exit 0 mid-flight — this
  // timer stays ref'd so a silent drain trips it instead
  const watchdog = setTimeout(() => {
    console.error('browser-lab receipt: FAIL — watchdog: exceeded 8 minutes');
    process.exit(3);
  }, 8 * 60_000);

  // -- stage 1: production pipeline build (real config, extra lab entry)
  console.log('[run-browser-lab] stage 1: vite build (shipping config)');
  const build = await run('npx', [
    'vite', 'build',
    '--config', 'tests/crypto/lab/browser/vite.shipping-config.mts',
    '--logLevel', 'warn',
  ]);
  if (build.code !== 0) {
    throw new Error(`shipping-config vite build failed with exit ${build.code}`);
  }
  if (!existsSync(join(distDir, 'tests', 'crypto', 'lab', 'browser', 'page', 'shipping-lab.html'))) {
    throw new Error('lab page missing from the built bundle');
  }

  // -- stage 2: harness
  console.log('[run-browser-lab] stage 2: harness (ssh server + ws bridge + static)');
  const harness = new BrowserLabHarness();
  const fixtures = harness.buildFixtures();
  try {
    await harness.start(distDir, fixtures);
    if (!harness.httpPort || !harness.wsPort || !harness.sshPort) {
      throw new Error('harness ports missing after start');
    }
    console.log(
      `[run-browser-lab] harness up: ssh=${harness.sshPort} ws=${harness.wsPort} http=${harness.httpPort}`,
    );
    const pageUrl = `http://127.0.0.1:${harness.httpPort}/tests/crypto/lab/browser/page/shipping-lab.html`;
    console.log(`[run-browser-lab] stage 3: chromium runs the flow matrix at ${pageUrl}`);

    // -- stage 3: real browser
    const outcome = await withBrowser(
      pageUrl,
      () => {},
      (line) => process.stdout.write(`   ${line}\n`),
    );
    const { results, probe } = outcome;
    for (const r of results) {
      console.log(`   ${r.ok ? '✓' : '×'} ${r.name} — ${r.detail}`);
    }

    // -- stage 4: assertions
    console.log('[run-browser-lab] stage 4: assertions');
    const failed = results.filter((r) => !r.ok);
    assert.equal(failed.length, 0, `${failed.length} browser flow(s) failed: ${failed.map((f) => f.name).join('; ')}`);
    // exact record manifest: no flow may vanish or fail silently
    const expectedRecords = [
      'positive: RSA OpenSSH handshake (production kex)',
      'positive: encrypted RSA handshake (bcrypt decrypt)',
      'positive: Ed25519 handshake',
      'positive: encrypted Ed25519 handshake',
      'refusal: plaintext ECDSA user key',
      'refusal: plaintext ECDSA user key — elliptic never signed',
      'refusal: encrypted ECDSA user key (correct passphrase)',
      'refusal: encrypted ECDSA user key (correct passphrase) — elliptic never signed',
      ...Object.keys(fixtures.malformed).map((name) => `refusal: malformed ${name}`),
      'malformed refusals left elliptic untouched (whole loop)',
      'parser-first: parsed-but-guarded key dial refused',
      'parser-first: unparseable key dial rejected before auth',
      'hostpin: wrong-fingerprint pin refuses the dial',
      'residual: public-key verification still works (RSA + Ed25519)',
    ];
    assert.equal(results.length, expectedRecords.length,
      `expected exactly ${expectedRecords.length} flow records, saw ${results.length}`);
    for (const name of expectedRecords) {
      const record = results.find((r) => r.name === name);
      assert.ok(record, `missing flow record: ${name}`);
      assert.equal(record.ok, true, `flow record not green: ${name} — ${record.detail}`);
    }
    assert.equal(probe.ecSignCalls, 0, 'elliptic ECDSA sign must never run');
    assert.equal(probe.eddsaSignCalls, 0, 'elliptic EdDSA sign must never run');
    assert.ok(probe.genKeyPairCalls > 0, 'probe liveness: ECDH must have hit the wrapped elliptic prototype');

    // Server trace, in dial order (the browser matrix is strictly
    // sequential): 4 positives, 2 ECDSA-guarded, 1 parser-accepted-guarded,
    // 1 pin-refused. The parser-REJECTED dial is asserted BY ABSENCE: the
    // bridge dials the SSH server on the first client bytes, and a key that
    // ssh2 throws on never writes anything — it must leave NO trace here
    // (8 connections, not 9).
    const conns = harness.connections;
    console.log('[run-browser-lab] server trace:');
    conns.forEach((c, i) => console.log(
      `   [${i}] username=${c.username} accepted=${c.accepted} auths=[${c.authRequests.map((a) => `${a.method}${a.sigPresent ? '+sig' : ''}`).join(', ')}]`,
    ));
    assert.equal(conns.length, 8,
      `expected 8 server connections (4 positive, 2 ECDSA, 1 parser-guarded, 1 pin-refused; parser-rejected must not appear), saw ${conns.length}`);
    // positives: authenticated with a VERIFIED signature under their own username
    const positiveUsernames = ['lab-pos-rsa', 'lab-pos-rsa-enc', 'lab-pos-ed', 'lab-pos-ed-enc'];
    positiveUsernames.forEach((username, i) => {
      const conn = conns[i];
      assert.equal(conn.username, username, `connection ${i} must be the ${username} dial`);
      assert.equal(conn.accepted, true, `${username} dial must authenticate`);
      const signed = conn.authRequests.filter((r) => r.sigPresent);
      assert.ok(signed.length >= 1, `${username} dial must include a signed auth request`);
      assert.ok(
        signed.every((r) => r.verified === true),
        `${username}: server must verify every client signature`,
      );
    });
    // ECDSA and parser-guarded dials: no signed auth request ever reaches
    // the server (unsigned probe requests are protocol-negotiation noise)
    for (const idx of [4, 5, 6]) {
      const signed = conns[idx].authRequests.filter((r) => r.sigPresent);
      assert.equal(signed.length, 0, `connection ${idx}: a signature must never reach the server`);
      assert.notEqual(conns[idx].username, null, `connection ${idx} must have attempted userauth (probe)`);
      assert.equal(conns[idx].accepted, false, `connection ${idx} must not authenticate`);
    }
    // pin-refused dial: zero auth requests at all (refusal before userauth)
    assert.equal(conns[7].authRequests.length, 0, 'pin-refused dial must fail before userauth');
    assert.equal(conns[7].accepted, false, 'pin-refused dial must not authenticate');
    assert.equal(conns[7].username, null, 'pin-refused dial must never reach userauth');

    console.log('[run-browser-lab] receipt: browser flow matrix green (exact manifest), server trace green,');
    console.log(`   zero elliptic ECDSA/EdDSA signatures; ECDH genKeyPair calls: ${probe.genKeyPairCalls}`);
  } finally {
    await harness.stop();
  }
}

main()
  .then(() => {
    console.log('browser-lab receipt: PASS');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`browser-lab receipt: FAIL — ${err.message}`);
    process.exit(1);
  });