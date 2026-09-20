/**
 * HostChannel (the /fwd/ exchange primitive) against a real SSH server: the
 * same in-process sshd + dumb-relay shape as directSession.test.ts, plus a
 * far side the server's `direct-tcpip` handler dials into — a node http
 * server for framed responses, a raw socket for a close-delimited one, and
 * a route to a dead port for refusals. The user key is a real encrypted
 * OpenSSH ed25519 key with a one-space passphrase — the shape the app
 * stores.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { Server as SshServer } from 'ssh2';
import { buildRequest, type ParsedResponse } from '../src/forward/forwardHttp';
import { HostChannel, type ForwardDialSpec } from '../src/forward/forwardConn';

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
let relay: WebSocketServer;
let relayPort = 0;
let handshakeCount = 0;
const openedPorts: number[] = [];

let far: http.Server;
let rawSide: net.Server;
let deadHolder: net.Server;
let deadPort = 0;

beforeAll(async () => {
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', HOST_KEY]);
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', PASSPHRASE, '-q', '-f', USER_KEY]);

  sshd = new SshServer({ hostKeys: [readFileSync(HOST_KEY, 'utf8')] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') ctx.accept();
      else ctx.reject();
    });
    handshakeCount += 1;
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

  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  relay.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // The query names 'far.test', the fixture's alias — dial it on loopback.
    const upstream = net.connect(Number(url.searchParams.get('port')), '127.0.0.1');
    ws.on('message', (data) => upstream.write(data as Buffer));
    upstream.on('data', (chunk) => ws.send(chunk));
    const bothDown = () => {
      try { ws.close(); } catch { /* gone */ }
      upstream.destroy();
    };
    ws.on('close', () => upstream.destroy());
    upstream.on('close', bothDown);
    upstream.on('error', bothDown);
  });
  await new Promise<void>((resolve) => {
    relay.on('listening', () => {
      relayPort = (relay.address() as net.AddressInfo).port;
      resolve();
    });
  });

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

afterAll(() => {
  relay.close();
  sshd.close();
  far.close();
  rawSide.close();
  rmSync(HOME_DIR, { recursive: true, force: true });
});

function channel(passphrase: string | undefined, privateKey: string = readFileSync(USER_KEY, 'utf8')): HostChannel {
  const spec: ForwardDialSpec = {
    hostname: SSH_HOSTNAME,
    port: sshPort,
    user: 'alexey',
    privateKey,
    ...(passphrase !== undefined ? { passphrase } : {}),
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    idToken: 'test-token',
  };
  return new HostChannel(() => ({ ...spec }));
}

function get(pathname: string, destPort = HTTP_PORT, opts: { headOnly?: boolean } = {}): Promise<ParsedResponse> {
  const ch = channel(PASSPHRASE);
  return ch.exchange(
    destPort,
    buildRequest('GET', pathname, SSH_HOSTNAME, destPort, [['accept', 'text/html']], null),
    opts,
  ).finally(() => ch.close());
}

describe('HostChannel: /fwd/ exchanges over direct-tcpip', () => {
  it('fetches an HTML document through the tunnel', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toContain('PS-FAR-OK');
    expect(res.headers.map(([n]) => n.toLowerCase())).toContain('content-type');
  }, 30_000);

  it('delivers the exact wire request: stripped cookies, gzip-only, close, right Host', async () => {
    const ch = channel(PASSPHRASE);
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
    const ch = channel(PASSPHRASE);
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

  it('keeps concurrent exchanges independent on one connection', async () => {
    const ch = channel(PASSPHRASE);
    const [a, b] = await Promise.all([
      ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null)),
      ch.exchange(HTTP_PORT, buildRequest('GET', '/chunked', SSH_HOSTNAME, HTTP_PORT, [], null)),
    ]);
    ch.close();
    expect(Buffer.from(a.body).toString()).toContain('PS-FAR-OK');
    expect(Buffer.from(b.body).toString()).toBe('forward-end');
  }, 30_000);

  it('rejects when the far port refuses', async () => {
    await expect(get('/', deadPort)).rejects.toThrow();
    expect(openedPorts).toContain(deadPort);
  }, 30_000);

  it('re-dials after close() and after a wrong-passphrase failure', async () => {
    const bad = channel('wrong');
    await expect(bad.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null))).rejects.toThrow();
    bad.close();

    const ch = channel(PASSPHRASE);
    const before = handshakeCount;
    await ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null));
    ch.close();
    expect(handshakeCount).toBeGreaterThanOrEqual(before + 1);

    await ch.exchange(HTTP_PORT, buildRequest('GET', '/', SSH_HOSTNAME, HTTP_PORT, [], null));
    ch.close();
    expect(handshakeCount).toBeGreaterThanOrEqual(before + 2);
  }, 45_000);
});
