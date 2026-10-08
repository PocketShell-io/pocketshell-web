/**
 * HostChannel (the /fwd/ exchange primitive) against a real SSH server
 * through the versioned scoped direct proxy: the same in-process sshd +
 * owned proxy fixture shape as directSession.test.ts, plus a far side the
 * server's `direct-tcpip` handler dials into — a node http server for
 * framed responses, a raw socket for a close-delimited one, and a route to
 * a dead port for refusals. The user key is a real encrypted OpenSSH
 * ed25519 key with a one-space passphrase — the shape the app stores.
 *
 * The credential/trust boundary is the point here: a FRESH broker mint per
 * actual (re)dial (never on a healthy session, coalesced across concurrent
 * exchanges), the sign-in nowhere on the wire, and the host key verified
 * against saved pins BEFORE userauth — a mismatch or a missing pin source
 * refuses with zero SSH authentication attempts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { Server as SshServer, utils as ssh2utils } from 'ssh2';
import { knownHostsToken } from '@pocketshell/core';
import { buildRequest, type ParsedResponse } from '../src/forward/forwardHttp';
import { HostChannel, type ForwardDialSpec } from '../src/forward/forwardConn';
import type { KnownHostsHooks } from '../src/terminal/connection';
import { sentinelAdmission, startScopedProxyFixture, SCOPED_TOKEN_SENTINEL, type ScopedFixture } from './scopedProxyFixture';

const HOME_DIR = mkdtempSync(join(tmpdir(), 'forwardconn-'));
const HOST_KEY = join(HOME_DIR, 'host_ed25519');
const USER_KEY = join(HOME_DIR, 'user_ed25519');
const PASSPHRASE = ' ';

const SSH_HOSTNAME = 'far.test'; // what specOf claims; the Host header must agree
// The "forwarded port" numbers are the far-side listeners' real ports —
// allocated at runtime so the test never collides with anything on the box.
let HTTP_PORT = 0; // framed far side
let CLOSE_PORT = 0; // close-delimited far side

let sshd: SshServer;
let sshPort = 0;
let proxy: ScopedFixture;
let sshAuthAttempts = 0;
const openedPorts: number[] = [];

/** The real sshd host key, as a known_hosts pin — the independently saved
 * trust record the forwarding verifier classifies against. Computed in
 * beforeAll, once the key file exists. */
let HOST_PIN = { keyType: 'ssh-ed25519', keyB64: '' };
const IMPOSTOR_PIN = { keyType: 'ssh-ed25519', keyB64: Buffer.from('impostor-key-blob-bytes').toString('base64') };

let far: http.Server;
let rawSide: net.Server;
let deadHolder: net.Server;
let deadPort = 0;

beforeAll(async () => {
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', HOST_KEY]);
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', PASSPHRASE, '-q', '-f', USER_KEY]);

  const parsedHostKey = ssh2utils.parseKey(readFileSync(HOST_KEY, 'utf8')) as {
    type: string;
    getPublicSSH(): Buffer;
  };
  HOST_PIN = { keyType: parsedHostKey.type, keyB64: parsedHostKey.getPublicSSH().toString('base64') };

  sshd = new SshServer({ hostKeys: [readFileSync(HOST_KEY, 'utf8')] }, (client) => {
    client.on('authentication', (ctx) => {
      sshAuthAttempts += 1;
      if (ctx.method === 'publickey') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      // The direct-tcpip handler is the sshd half of port forwarding: dial
      // whatever the channel names, or refuse it.
      client.on('tcpip', (accept, _reject, info) => {
        openedPorts.push(info.destPort);
        if (info.destPort === deadPort) {
          // A real sshd answers channel-open failure; ssh2's server has no
          // reject helper wired here — accept then die, which the client
          // experiences identically (channel closed, no response).
          const doomed = accept();
          doomed.close();
          return;
        }
        const stream = accept();
        const upstream = net.connect(info.destPort, '127.0.0.1', () => {
          // Nothing is piped client→far in these tests beyond the request,
          // but the wire bytes must still flow: the far side reads before
          // answering.
          stream.on('data', (chunk: Buffer) => upstream.write(chunk));
        });
        upstream.on('data', (chunk: Buffer) => stream.write(chunk));
        upstream.on('close', () => stream.close());
        upstream.on('error', () => {
          try {
            stream.close();
          } catch {
            // already gone
          }
        });
        stream.on('close', () => upstream.destroy());
        stream.on('error', () => upstream.destroy());
      });
    });
    client.on('error', () => {});
  });
  await new Promise<void>((resolve) => {
    sshd.listen(0, '127.0.0.1', () => {
      sshPort = (sshd.address() as net.AddressInfo).port;
      resolve();
    });
  });

  // The scoped direct proxy fixture, piped to the in-process sshd — the
  // exact v1 wire contract, refusing any non-contract dial on its own.
  proxy = await startScopedProxyFixture(sshPort, { requireTokenEquals: SCOPED_TOKEN_SENTINEL });

  // The framed far side: echoes what arrived so the test can assert the
  // exact request that crossed the tunnel.
  far = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/headers') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.headers));
        return;
      }
      if (req.url === '/chunked') {
        res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
        res.write('for');
        setTimeout(() => { res.write('ward'); res.end('-end'); }, 20);
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/landing' });
        res.end();
        return;
      }
      if (req.url === '/landing') {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'far=1' });
        res.end('<html><body>landed</body></html>');
        return;
      }
      if (req.url === '/echo') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(body);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>PS-FAR</title></head><body>PS-FAR-OK</body></html>');
    });
  });
  await new Promise<void>((resolve) => {
    far.listen(0, '127.0.0.1', () => {
      HTTP_PORT = (far.address() as net.AddressInfo).port;
      resolve();
    });
  });

  // The close-delimited far side: HTTP/1.1 with no length and no chunking —
  // the body ends only when the socket does.
  rawSide = net.createServer((sock) => {
    sock.on('data', () => {
      sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nclose-delim');
    });
  });
  await new Promise<void>((resolve) => {
    rawSide.listen(0, '127.0.0.1', () => {
      CLOSE_PORT = (rawSide.address() as net.AddressInfo).port;
      resolve();
    });
  });

  // Hold and release a port so something is genuinely NOT listening there.
  deadHolder = net.createServer();
  await new Promise<void>((resolve) => {
    deadHolder.listen(0, '127.0.0.1', () => {
      deadPort = (deadHolder.address() as net.AddressInfo).port;
      deadHolder.close(() => resolve());
    });
  });
});

afterAll(async () => {
  await proxy.close();
  sshd.close();
  far.close();
  rawSide.close();
  rmSync(HOME_DIR, { recursive: true, force: true });
});

/** In-memory known-hosts pins — the browser's envelope in miniature. */
function pinStore(initial: Record<string, { keyType: string; keyB64: string }> = {}): { hooks: KnownHostsHooks; map: Record<string, { keyType: string; keyB64: string }> } {
  const map = { ...initial };
  return {
    map,
    hooks: {
      lookup: async (host, port) => map[knownHostsToken(host, port)],
      pin: async (host, port, pin) => {
        map[knownHostsToken(host, port)] = pin;
      },
    },
  };
}

function channel(opts: {
  passphrase?: string;
  privateKey?: string;
  pins?: Record<string, { keyType: string; keyB64: string }>;
  hooks?: KnownHostsHooks;
  admissionOf?: ForwardDialSpec['admissionOf'];
} = {}): { ch: HostChannel; mints: number[] } {
  const mints: number[] = [];
  const store = pinStore(opts.pins);
  const spec: ForwardDialSpec = {
    hostname: SSH_HOSTNAME,
    port: sshPort,
    user: 'alexey',
    privateKey: opts.privateKey ?? readFileSync(USER_KEY, 'utf8'),
    ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
    scopedProxyUrl: proxy.serverUrl,
    allowInsecureWs: true,
    admissionOf: opts.admissionOf ?? (async () => {
      mints.push(1);
      return sentinelAdmission();
    }),
    knownHosts: opts.hooks ?? store.hooks,
  };
  return { ch: new HostChannel(() => ({ ...spec, knownHosts: spec.knownHosts })), mints };
}

function get(pathname: string, destPort = HTTP_PORT, opts: { headOnly?: boolean } = {}): Promise<ParsedResponse> {
  const { ch } = channel({ passphrase: PASSPHRASE });
  return ch.exchange(
    destPort,
    buildRequest('GET', pathname, SSH_HOSTNAME, destPort, [['accept', 'text/html']], null),
    opts,
  ).finally(() => ch.close());
}

describe('HostChannel: /fwd/ exchanges over direct-tcpip through the scoped proxy', () => {
  it('fetches an HTML document through the tunnel — with the exact dial census and only the scoped token', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toContain('PS-FAR-OK');
    expect(res.headers.map(([n]) => n.toLowerCase())).toContain('content-type');

    // Custody: the URL carried host/port ONLY; the fixture's own census
    // refuses anything else, and these assertions re-check the records.
    expect(proxy.records.upgradeUrls).toEqual([`/proxy/v1/ssh?host=${SSH_HOSTNAME}&port=${sshPort}`]);
    expect(proxy.records.authFrames).toEqual([{ type: 'auth', v: 1, token: SCOPED_TOKEN_SENTINEL }]);
    // The only TEXT frame ever sent was the auth frame; the private key
    // never crossed the proxy in any frame.
    const userKeyBody = readFileSync(USER_KEY, 'utf8').split('\n').slice(1, -2).join('');
    for (const text of proxy.records.textFrames) expect(text).not.toContain(userKeyBody.slice(0, 40));
    expect(proxy.records.upgradeUrls.join(' ')).not.toContain(SCOPED_TOKEN_SENTINEL);
  }, 30_000);

  it('delivers the exact wire request: stripped cookies, gzip-only, close, right Host', async () => {
    const { ch } = channel({ passphrase: PASSPHRASE });
    const res = await ch.exchange(
      HTTP_PORT,
      buildRequest(
        'GET',
        '/headers',
        SSH_HOSTNAME,
        HTTP_PORT,
        [
          ['cookie', 'app=secret'],
          ['sec-fetch-site', 'same-origin'],
          ['accept-encoding', 'br'],
        ],
        null,
      ),
    );
    ch.close();
    const seen = JSON.parse(Buffer.from(res.body).toString()) as Record<string, string>;
    expect(seen.cookie).toBeUndefined();
    expect(seen['sec-fetch-site']).toBeUndefined();
    expect(seen['accept-encoding']).toBe('gzip');
    expect(seen.connection).toBe('close');
    expect(seen.host).toBe(`${SSH_HOSTNAME}:${HTTP_PORT}`);
  }, 30_000);

  it('reassembles a chunked body', async () => {
    const res = await get('/chunked');
    expect(Buffer.from(res.body).toString()).toBe('forward-end');
  }, 30_000);

  it('resolves a close-delimited body at channel end', async () => {
    const res = await get('/', CLOSE_PORT);
    expect(Buffer.from(res.body).toString()).toBe('close-delim');
  }, 30_000);

  it('answers HEAD at the head without waiting for a body', async () => {
    const res = await get('/', HTTP_PORT, { headOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.byteLength).toBe(0);
  }, 30_000);

  it('round-trips a POST body', async () => {
    const { ch } = channel({ passphrase: PASSPHRASE });
    const res = await ch.exchange(
      HTTP_PORT,
      buildRequest('POST', '/echo', SSH_HOSTNAME, HTTP_PORT, [['content-type', 'text/plain']], new Uint8Array([1, 2, 3, 250])),
    );
    ch.close();
    expect(Buffer.from(res.body)).toEqual(Buffer.from([1, 2, 3, 250]));
  }, 30_000);

  it('hands the raw redirect through (rewriting is the forwarder\'s job)', async () => {
    const res = await get('/redirect');
    expect(res.status).toBe(302);
    expect(res.headers).toContainEqual(['location', '/landing']);
  }, 30_000);

  it('keeps concurrent exchanges independent on one connection — and mints ONCE for the shared dial', async () => {
    const dialsBefore = proxy.records.authFrames.length;
    const { ch, mints } = channel({ passphrase: PASSPHRASE });
    const [a, b] = await Promise.all([
      ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null)),
      ch.exchange(HTTP_PORT, buildRequest('GET', '/chunked', SSH_HOSTNAME, HTTP_PORT, [], null)),
    ]);
    ch.close();
    expect(Buffer.from(a.body).toString()).toContain('PS-FAR-OK');
    expect(Buffer.from(b.body).toString()).toBe('forward-end');
    // Concurrent cold exchanges coalesced onto ONE dial → ONE mint.
    expect(mints).toHaveLength(1);
    expect(proxy.records.authFrames.length).toBe(dialsBefore + 1);
  }, 30_000);

  it('rejects when the far port refuses', async () => {
    await expect(get('/', deadPort)).rejects.toThrow();
    expect(openedPorts).toContain(deadPort);
  }, 30_000);

  it('mints NOTHING extra on a healthy session, and a FRESH mint on every actual re-dial', async () => {
    const { ch, mints } = channel({ passphrase: PASSPHRASE });
    await ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null));
    const mintsAfterFirst = mints.length;
    const dialsAfterFirst = proxy.records.authFrames.length;
    // A second request over the healthy SSH session: no new mint, no new dial.
    await ch.exchange(HTTP_PORT, buildRequest('GET', '/chunked', SSH_HOSTNAME, HTTP_PORT, [], null));
    expect(mints.length).toBe(mintsAfterFirst);
    expect(proxy.records.authFrames.length).toBe(dialsAfterFirst);

    ch.close();
    // After close() the next exchange re-dials — with a FRESH mint.
    await ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null));
    ch.close();
    expect(mints.length).toBe(mintsAfterFirst + 1);
    expect(proxy.records.authFrames.length).toBe(dialsAfterFirst + 1);
  }, 45_000);

  it('a refusing admission provider (lock, sign-out, missing key) cancels the dial with ZERO sockets', async () => {
    const dialsBefore = proxy.records.upgradeUrls.length;
    const attemptsBefore = sshAuthAttempts;
    const { ch, mints } = channel({
      admissionOf: async () => {
        mints.push(1);
        throw new Error('PocketShell is locked in the app tab — the dial was refused before anything was sent.');
      },
    });
    await expect(ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null))).rejects.toThrow(/locked/);
    ch.close();
    expect(proxy.records.upgradeUrls.length).toBe(dialsBefore);
    expect(sshAuthAttempts).toBe(attemptsBefore);
  }, 30_000);

  it('a WRONG pin refuses BEFORE SSH userauth — the key was never offered', async () => {
    const attemptsBefore = sshAuthAttempts;
    const { ch } = channel({ passphrase: PASSPHRASE, pins: { [knownHostsToken(SSH_HOSTNAME, sshPort)]: IMPOSTOR_PIN } });
    await expect(ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null))).rejects.toThrow(
      /Host key mismatch/,
    );
    ch.close();
    expect(sshAuthAttempts).toBe(attemptsBefore);
  }, 30_000);

  it('a first contact with NO pin TOFU-pins it (the explicit trusted-pin flow), then verifies on the next dial', async () => {
    const store = pinStore();
    const { ch } = channel({ passphrase: PASSPHRASE, hooks: store.hooks });
    const res = await ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null));
    ch.close();
    expect(Buffer.from(res.body).toString()).toContain('PS-FAR-OK');
    const token = knownHostsToken(SSH_HOSTNAME, sshPort);
    expect(store.map[token]).toEqual(HOST_PIN);

    // The saved pin is now the trust record: a channel against an impostor
    // pin for the SAME host token refuses (covered above); the honest pin
    // verifies silently on a fresh dial.
    const { ch: ch2 } = channel({ passphrase: PASSPHRASE, hooks: store.hooks });
    const res2 = await ch2.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null));
    ch2.close();
    expect(Buffer.from(res2.body).toString()).toContain('PS-FAR-OK');
  }, 45_000);

  it('a spec WITHOUT a pin source refuses outright — `hostVerifier: () => true` is gone', async () => {
    const specSansHooks = {
      hostname: SSH_HOSTNAME,
      port: sshPort,
      user: 'alexey',
      privateKey: readFileSync(USER_KEY, 'utf8'),
      passphrase: PASSPHRASE,
      scopedProxyUrl: proxy.serverUrl,
      allowInsecureWs: true,
      admissionOf: async () => sentinelAdmission(),
      knownHosts: undefined,
    } as unknown as ForwardDialSpec;
    const ch = new HostChannel(() => specSansHooks);
    const attemptsBefore = sshAuthAttempts;
    await expect(ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null))).rejects.toThrow(
      /pin source/,
    );
    ch.close();
    expect(sshAuthAttempts).toBe(attemptsBefore);
  }, 30_000);
});
