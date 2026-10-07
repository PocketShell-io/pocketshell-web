/**
 * Bounded real-SSH lab under the BROWSER crypto shim: an in-process ssh2
 * server and a real ssh2 Client, both with `require('crypto')` served by the
 * compiled src/shims/ssh2-crypto.ts — the production browser wiring. The
 * server VERIFIES the client's auth signature through the same shim
 * (parseKey(ctx.key.data).verify(ctx.blob, ctx.signature, hashAlgo)), so
 * every positive case is a genuine sign -> verify round trip, and the
 * elliptic probe proves no ECDSA signature ever happened.
 *
 * This is the existing bounded-lab pattern (in-process ssh2, no Docker); the
 * full real-browser Docker e2e remains root's integrated step.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLab } from './lab-harness.mjs';

function dialOnce({ port, pem, passphrase, acceptHostKey = true, command = 'ps-crypto-probe', kex }) {
  return new Promise((resolve, reject) => {
    const requireFromLab = createRequire(import.meta.url);
    const { Client } = requireFromLab('ssh2');
    const conn = new Client();
    const seen = {};
    let execEcho = '';
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        try { conn.end(); } catch { /* already dead */ }
        reject(err);
      }
    };
    conn.on('handshake', (n) => Object.assign(seen, n));
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return fail(err);
        stream.on('data', (chunk) => { execEcho += chunk.toString(); });
        stream.on('close', () => {
          if (!settled) {
            settled = true;
            conn.end();
            resolve({ negotiated: seen, execEcho });
          }
        });
        stream.on('error', fail);
      });
    });
    conn.on('error', fail);
    conn.on('close', () => fail(new Error('connection closed during handshake')));
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', fail);
    conn.connect({
      sock: socket,
      username: 'lab-user',
      privateKey: pem,
      passphrase,
      tryKeyboard: false,
      readyTimeout: 20_000,
      ...(kex ? { algorithms: { kex } } : {}),
      hostVerifier: (_key, verify) => verify(acceptHostKey),
    });
  });
}

/** The kex list the browser build can actually execute today: with the shim,
 * `curve25519Supported` is true (the stubs are typeof-function) so ssh2
 * offers curve25519-sha256 FIRST — and its Curve25519Exchange then dies in
 * the shim's generateKeyPairSync stub (asserted explicitly below). Until the
 * offer list is coordinated upstream, a browser handshake needs a server
 * that avoids curve25519 or this override. */
const WORKABLE_KEX = ['ecdh-sha2-nistp256', 'diffie-hellman-group14-sha256'];

export async function runHandshakeLab(builtDirUrl) {
  // createRequire/require take paths (or URL objects) — not href strings.
  const requireFromLab = (specifier) =>
    createRequire(fileURLToPath(new URL('.', builtDirUrl)))(specifier);
  const { Server: SshServer, utils: ssh2Utils } = requireFromLab('ssh2');
  const keys = requireFromLab('./keys.cjs');
  const { ellipticProbe } = requireFromLab('./elliptic-probe.cjs');

  const lab = createLab('ssh-handshake-lab');
  const hostDir = new keys.KeyDir('lab-host');
  const userDirs = [];
  const newUserKey = (type, opts = {}) => {
    const dir = new keys.KeyDir('lab-user');
    userDirs.push(dir);
    return dir.sshgen(type, {
      bits: type === 'rsa' ? 2048 : type === 'ecdsa' ? 256 : undefined,
      passphrase: opts.passphrase,
    });
  };

  const server = new SshServer({ hostKeys: [hostDir.sshgen('ed25519')] }, (client) => {
    // Rejected dials end with the client's DISCONNECT re-emitted here;
    // without a listener it would surface as an uncaught exception.
    client.on('error', () => { /* teardown noise from negative dials */ });
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') {
        ctx.reject();
        return;
      }
      if (ctx.signature && ctx.blob) {
        const parsed = ssh2Utils.parseKey(ctx.key.data);
        if (parsed instanceof Error) {
          ctx.reject();
          return;
        }
        const verified = parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo ?? undefined);
        if (verified !== true) {
          ctx.reject();
          return;
        }
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`ECHO:${info.command}`);
          stream.end();
        });
      });
    });
  });
  server.on('error', () => { /* mirror of the per-connection handler */ });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  try {
    assert.equal(ellipticProbe.ecSignCalls, 0, 'probe must start at zero');

    await lab.test('PRE-EXISTING browser-build limitation: curve25519 kex dies in the shim stub', async () => {
      // The shim's typeof-stubs make ssh2 believe curve25519 works, so it is
      // offered FIRST and any curve25519-preferring server picks it — then
      // Curve25519Exchange hits the generateKeyPairSync stub. Not caused by
      // the ECDSA guard; flagged for root coordination (offer-list fix).
      const pem = newUserKey('ed25519');
      await assert.rejects(
        dialOnce({ port, pem }),
        /generateKeyPairSync is not supported in the browser build/,
      );
      assert.equal(ellipticProbe.ecSignCalls, 0);
    });

    await lab.test('encrypted OpenSSH Ed25519 key completes a verified handshake', async () => {
      const pem = newUserKey('ed25519', { passphrase: ' ' });
      const result = await dialOnce({ port, pem, passphrase: ' ', kex: WORKABLE_KEX });
      assert.equal(result.execEcho, 'ECHO:ps-crypto-probe');
      assert.match(result.negotiated.serverHostKey, /ssh-ed25519/);
      // Receipt for what the shim-wired stack negotiates in this lab.
      console.info(`   [crypto-lab] negotiated kex: ${result.negotiated.kex}`);
      assert.match(result.negotiated.kex, /ecdh-sha2|diffie-hellman/);
      assert.equal(ellipticProbe.ecSignCalls, 0);
    });

    await lab.test('OpenSSH RSA key completes a verified handshake (rsa-sha2 signing)', async () => {
      const pem = newUserKey('rsa');
      const result = await dialOnce({ port, pem, kex: WORKABLE_KEX });
      assert.equal(result.execEcho, 'ECHO:ps-crypto-probe');
      assert.equal(ellipticProbe.ecSignCalls, 0);
    });

    await lab.test('wrong passphrase fails before authentication', async () => {
      const pem = newUserKey('ed25519', { passphrase: 'right-passphrase' });
      await assert.rejects(
        dialOnce({ port, pem, passphrase: 'wrong-passphrase', kex: WORKABLE_KEX }),
        /passphrase|decrypt|authentication methods/i,
      );
      assert.equal(ellipticProbe.ecSignCalls, 0);
    });

    await lab.test('refused host-key pin kills the handshake before any auth', async () => {
      const pem = newUserKey('rsa');
      await assert.rejects(
        dialOnce({ port, pem, acceptHostKey: false, kex: WORKABLE_KEX }),
        /denied|handshake|key/i,
      );
      assert.equal(ellipticProbe.ecSignCalls, 0);
    });

    await lab.test('ECDSA user key fails auth with the stable refusal — elliptic never signs', async () => {
      const pem = newUserKey('ecdsa');
      let message = '';
      try {
        await dialOnce({ port, pem, kex: WORKABLE_KEX });
        assert.fail('ECDSA dial unexpectedly succeeded');
      } catch (err) {
        message = err.message;
      }
      // ssh2 surfaces the shim's refusal as a client-authentication error and
      // then runs out of auth methods; either wording proves the dial failed,
      // and the probe proves WHY no ECDSA signature can be responsible.
      assert.match(message, /ECDSA|authentication methods/i);
      assert.equal(ellipticProbe.ecSignCalls, 0);
    });
  } finally {
    // close() alone waits on sockets from the negative dials; drop them so
    // the lab process can actually exit.
    try { server.closeAllConnections?.(); } catch { /* none open */ }
    try { server.close(); } catch { /* listener already gone */ }
    hostDir.cleanup();
    for (const dir of userDirs) dir.cleanup();
  }

  lab.finish();
}
