/**
 * Node-side harness for the shipping-wiring browser lab: a real in-process
 * ssh2 server (REAL node crypto — the containment is browser-side only), a
 * WebSocket↔TCP bridge the browser's ssh2 dials through (the same transport
 * shape the app uses: ordered binary frames), a bounded static server for
 * the built bundle, and the ephemeral fixture set.
 *
 * Everything binds to 127.0.0.1 on OS-assigned ports; every socket is
 * tracked and closed by stop().
 */
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { Server: SshServer, utils: ssh2Utils } = require('ssh2');
const { generateKeyPairSync } = await import('node:crypto');

export class BrowserLabHarness {
  constructor() {
    this.keyDir = mkdtempSync(join(tmpdir(), 'ps-crypto-browser-'));
    this.sshServer = null;
    this.sshPort = null;
    this.wsServer = null;
    this.wsPort = null;
    this.httpServer = null;
    this.httpPort = null;
    this.wsSockets = new Set();
    this.tcpSockets = new Set();
    /** Per-connection auth trace, in dial order. */
    this.connections = [];
    this.activeConnection = null;
  }

  sshgen(type, opts = {}) {
    const label = opts.label ?? `${type}-${opts.bits ?? 'd'}`;
    const file = join(this.keyDir, `${label}-${opts.passphrase ? 'enc' : 'plain'}`);
    execFileSync('ssh-keygen', [
      '-t', type,
      ...(opts.bits ? ['-b', String(opts.bits)] : []),
      '-N', opts.passphrase ?? '',
      '-q',
      '-C', 'shipping-lab',
      '-f', file,
    ]);
    return fs.readFileSync(file, 'utf8');
  }

  /** Ephemeral keys + crafted malformed PEMs the browser flows consume. */
  buildFixtures() {
    const hostPem = this.sshgen('ed25519', { label: 'host' });
    const pass = 'shipping-lab-passphrase';
    const key = (pem, passphrase) => (passphrase === undefined ? { pem } : { pem, passphrase });
    const rsaPem = this.sshgen('rsa', { bits: 2048, label: 'user-rsa' });
    const edPem = this.sshgen('ed25519', { label: 'user-ed' });
    const ecdsaPem = this.sshgen('ecdsa', { bits: 256, label: 'user-ec' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const x25519 = generateKeyPairSync('x25519');
    const pemOf = (k, type) => k.privateKey.export({ format: 'pem', type }).toString();
    const fixtures = {
      hostPem,
      keys: {
        rsa: key(rsaPem),
        rsaEnc: key(this.sshgen('rsa', { bits: 2048, label: 'user-rsa', passphrase: pass }), pass),
        ed: key(edPem),
        edEnc: key(this.sshgen('ed25519', { label: 'user-ed', passphrase: pass }), pass),
        ecdsa: key(ecdsaPem),
        ecdsaEnc: key(this.sshgen('ecdsa', { bits: 256, label: 'user-ec', passphrase: pass }), pass),
      },
      malformed: {
        'SEC1 truncated body': truncatePem(pemOf(ec, 'sec1')),
        'RSA PKCS#1 with trailing DER bytes': appendDerJunk(pemOf(rsa, 'pkcs1')),
        'not a pem at all': 'definitely not a private key',
        'X25519 PKCS#8 (unknown algorithm OID)': pemOf(x25519, 'pkcs8'),
        'empty string': '',
      },
    };
    fixtures.keys.rsa.spki = rsa.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    // the out-of-band pin: sha256 over the host key's wire blob, like the
    // app's fingerprint pins
    const parsedHost = ssh2Utils.parseKey(hostPem);
    const blob = typeof parsedHost.getPublicSSH === 'function'
      ? parsedHost.getPublicSSH()
      : null;
    if (!blob) throw new Error('could not derive host key blob for the pin');
    fixtures.hostPin = require('node:crypto')
      .createHash('sha256')
      .update(blob)
      .digest('base64');
    return fixtures;
  }

  async start(distDir, fixtures) {
    // -- real ssh2 server: verifies client signatures with real node crypto
    const hostKeys = [fixtures.hostPem];
    this.sshServer = new SshServer({ hostKeys }, (client) => {
      const trace = { authRequests: [], accepted: false };
      this.connections.push(trace);
      this.activeConnection = trace;
      client.on('error', () => { /* teardown noise from negative dials */ });
      client.on('authentication', (ctx) => {
        const entry = {
          method: ctx.method,
          sigPresent: Boolean(ctx.signature && ctx.blob),
          keyType: ctx.key?.type ?? null,
          verified: null,
        };
        trace.authRequests.push(entry);
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
          entry.verified = parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo ?? undefined) === true;
          if (entry.verified !== true) {
            ctx.reject();
            return;
          }
        }
        ctx.accept();
      });
      client.on('ready', () => {
        trace.accepted = true;
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
    this.sshServer.on('error', (err) => {
      throw err;
    });
    this.sshPort = await new Promise((resolve) => {
      this.sshServer.listen(0, '127.0.0.1', () => resolve(this.sshServer.address().port));
    });

    // -- WS↔TCP bridge: one ordered binary pipe per browser dial
    this.wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 });
    await new Promise((resolve, reject) => {
      this.wsServer.once('listening', resolve);
      this.wsServer.once('error', reject);
    });
    this.wsPort = this.wsServer.address().port;
    this.wsServer.on('connection', (ws) => {
      if (this.wsSockets.size >= 16) {
        ws.close(1013, 'lab bound reached');
        return;
      }
      this.wsSockets.add(ws);
      const tcp = net.connect(this.sshPort, '127.0.0.1');
      this.tcpSockets.add(tcp);
      tcp.on('data', (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
      });
      tcp.on('error', () => ws.close());
      tcp.on('close', () => ws.close());
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          ws.close(1003, 'binary-only transport');
          return;
        }
        tcp.write(data);
      });
      const teardown = () => {
        ws.close();
        tcp.destroy();
      };
      ws.on('close', teardown);
      ws.on('error', teardown);
    });

    // -- bounded static server: the built bundle + the in-memory fixture
    this.httpServer = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (url === '/fixture.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          wsPort: this.wsPort,
          hostPin: fixtures.hostPin,
          production: {
            // the actual config connection.ts dials with (connection.ts:293-297)
            kex: ['ecdh-sha2-nistp256', 'diffie-hellman-group14-sha256'],
            cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
            serverHostKey: ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
          },
          keys: fixtures.keys,
          malformed: fixtures.malformed,
        }));
        return;
      }
      const resolved = path.normalize(join(distDir, url));
      if (!resolved.startsWith(path.normalize(distDir + path.sep))) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(resolved, (err, data) => {
        if (err) {
          res.writeHead(404).end('not found');
          return;
        }
        const type = resolved.endsWith('.html') ? 'text/html'
          : resolved.endsWith('.js') ? 'text/javascript'
            : resolved.endsWith('.css') ? 'text/css'
              : resolved.endsWith('.json') ? 'application/json'
                : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(data);
      });
    });
    this.httpPort = await new Promise((resolve) => {
      this.httpServer.listen(0, '127.0.0.1', () => resolve(this.httpServer.address().port));
    });
  }

  async stop() {
    for (const ws of this.wsSockets) try { ws.close(); } catch { /* gone */ }
    for (const tcp of this.tcpSockets) try { tcp.destroy(); } catch { /* gone */ }
    try { this.wsServer?.closeAllConnections?.(); } catch { /* none */ }
    await new Promise((resolve) => this.wsServer?.close(resolve));
    try { this.sshServer?.closeAllConnections?.(); } catch { /* none */ }
    await new Promise((resolve) => this.sshServer?.close(() => resolve(null)));
    await new Promise((resolve) => this.httpServer?.close(() => resolve(null)));
    rmSync(this.keyDir, { recursive: true, force: true });
  }
}

function truncatePem(pem) {
  const cutAt = pem.indexOf('-----END') - 12;
  return pem.slice(0, cutAt) + '-----END EC PRIVATE KEY-----';
}

function appendDerJunk(pkcs1Pem) {
  const body = pkcs1Pem
    .split(/\r?\n/)
    .filter((l) => l !== '' && !l.startsWith('-----'))
    .join('');
  const der = Buffer.from(body, 'base64');
  const junk = Buffer.concat([der, Buffer.from([0xde, 0xad, 0xbe])]);
  const b64 = junk.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN RSA PRIVATE KEY-----\n${b64}\n-----END RSA PRIVATE KEY-----\n`;
}
