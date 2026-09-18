/**
 * The browser-direct path, end to end without a browser: DirectSshSession
 * dials a relay (the same WebSocket↔TCP pipe relay/src/worker.ts runs),
 * which dials an in-process ssh2 server. The user key is a real encrypted
 * OpenSSH ed25519 key with a one-space passphrase — the shape the app
 * actually stores.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { Server as SshServer } from 'ssh2';
import { DirectSshSession } from '../src/terminal/direct';
import type { SessionHandlers } from '../src/terminal/session';

const HOME_DIR = mkdtempSync(join(tmpdir(), 'directssh-'));
const HOST_KEY = join(HOME_DIR, 'host_ed25519');
const USER_KEY = join(HOME_DIR, 'user_ed25519');
const PASSPHRASE = ' ';

let sshd: SshServer;
let sshPort = 0;
let relay: WebSocketServer;
let relayPort = 0;

beforeAll(async () => {
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', HOST_KEY]);
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', PASSPHRASE, '-q', '-f', USER_KEY]);

  sshd = new SshServer({ hostKeys: [readFileSync(HOST_KEY, 'utf8')] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        // Real sshd always grants these; ssh2's server rejects what no
        // listener accepts.
        session.on('pty', (acceptPty) => acceptPty());
        session.on('window-change', (acceptResize) => acceptResize());
        session.once('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.on('data', (chunk: Buffer) => stream.write(`ECHO:${chunk.toString()}`));
        });
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

  // The relay, exactly as the worker pipes it: bytes in, bytes out.
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  relay.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const upstream = net.connect(Number(url.searchParams.get('port')), url.searchParams.get('host') ?? undefined);
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
});

afterAll(() => {
  relay.close();
  sshd.close();
  rmSync(HOME_DIR, { recursive: true, force: true });
});

function handlers(output: string[], events: { exit: number; errors: string[]; status: string[] }): SessionHandlers {
  return {
    onData: (bytes) => output.push(new TextDecoder().decode(bytes)),
    onExit: () => events.exit++,
    onError: (message) => events.errors.push(message),
    onStatus: (s) => events.status.push(s),
  };
}

async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('DirectSshSession over a dumb relay', () => {
  it('handshakes with an encrypted key, shells, and round-trips input', async () => {
    const output: string[] = [];
    const events = { exit: 0, errors: [] as string[], status: [] as string[] };
    const session = new DirectSshSession(`ws://127.0.0.1:${relayPort}`, 'test-token', handlers(output, events));

    await session.open({
      host: '127.0.0.1',
      port: sshPort,
      user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: PASSPHRASE },
    });

    session.sendInput('ping\n');
    await until(() => output.join('').includes('ECHO:ping'), 'echo round-trip');

    session.resize(120, 40);
    session.close();
    await until(() => events.exit > 0, 'exit event');
    expect(events.errors).toEqual([]);
    expect(events.status.some((s) => s.startsWith('host key '))).toBe(true);
  }, 30_000);

  it('surfaces a wrong passphrase as an open failure, not a hang', async () => {
    const output: string[] = [];
    const events = { exit: 0, errors: [] as string[], status: [] as string[] };
    const session = new DirectSshSession(`ws://127.0.0.1:${relayPort}`, 'test-token', handlers(output, events));
    await expect(session.open({
      host: '127.0.0.1',
      port: sshPort,
      user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: 'wrong' },
    })).rejects.toThrow();
    session.close();
  }, 30_000);

  it('rejects when no key is attached', async () => {
    const session = new DirectSshSession(`ws://127.0.0.1:${relayPort}`, 't', handlers([], { exit: 0, errors: [], status: [] }));
    await expect(session.open({
      host: '127.0.0.1', port: sshPort, user: 'alexey', auth: { kind: 'key' },
    })).rejects.toThrow(/No private key/);
  });
});
