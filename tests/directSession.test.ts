/**
 * The browser-direct path, end to end without a browser: DirectSshSession
 * dials the versioned scoped direct proxy (the same wire contract the Go
 * proxy implements — here an owned fixture, tests/scopedProxyFixture.ts),
 * which pipes an in-process ssh2 server. The user key is a real encrypted
 * OpenSSH ed25519 key with a one-space passphrase — the shape the app
 * actually stores. The sign-in token never rides the URL: the fixture
 * refuses any dial whose query is not exactly host/port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server as SshServer } from 'ssh2';
import { DirectSshSession } from '../src/terminal/direct';
import { SshConnection } from '../src/terminal/connection';
import type { SessionHandlers, SessionDialSpec } from '../src/terminal/session';
import { sentinelAdmission, startScopedProxyFixture, SCOPED_TOKEN_SENTINEL, type ScopedFixture, type ScopedFixtureMode } from './scopedProxyFixture';

const HOME_DIR = mkdtempSync(join(tmpdir(), 'directssh-'));
const HOST_KEY = join(HOME_DIR, 'host_ed25519');
const USER_KEY = join(HOME_DIR, 'user_ed25519');
const PASSPHRASE = ' ';

let sshd: SshServer;
let sshPort = 0;
let proxy: ScopedFixture;

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
        // listener accepts. The PTY of an exec-with-pty request arrives
        // here, before the exec — the exec's own info does not carry it.
        let ptySeen = false;
        session.on('pty', (acceptPty) => {
          ptySeen = true;
          acceptPty();
        });
        session.on('window-change', (acceptResize) => acceptResize());
        session.once('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.on('data', (chunk: Buffer) => stream.write(`ECHO:${chunk.toString()}`));
        });
        // The workspace's exec channels: answer with the command itself so
        // the test asserts what travelled, plus whether a PTY preceded it.
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`CMD:${info.command}`);
          if (ptySeen) stream.write(`\nPTY:yes`);
          stream.stderr?.write(`ERR:${info.command}`);
          stream.exit(0);
          stream.close();
        });
      });
    });
    client.on('error', () => {});
  });
  await new Promise<void>((resolve) => {
    sshd.listen(0, '127.0.0.1', () => {
      sshPort = (sshd.address() as import('node:net').AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await proxy?.close();
  sshd.close();
  rmSync(HOME_DIR, { recursive: true, force: true });
});

/** A scoped proxy fixture piped to the in-process sshd, in a failure mode
 * if asked. The fixture refuses non-contract dials on its own. */
async function startProxy(mode: ScopedFixtureMode = 'ok'): Promise<ScopedFixture> {
  const fixture = await startScopedProxyFixture(sshPort, { mode, requireTokenEquals: SCOPED_TOKEN_SENTINEL });
  return fixture;
}

function directSpec(serverUrl: string): Extract<SessionDialSpec, { kind: 'direct' }> {
  return { kind: 'direct', serverUrl, dialOf: async () => sentinelAdmission(), allowInsecureWs: true };
}

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

describe('DirectSshSession through the scoped direct proxy', () => {
  it('admits with the scoped token, handshakes with an encrypted key, shells, and round-trips input', async () => {
    proxy = await startProxy();
    const output: string[] = [];
    const events = { exit: 0, errors: [] as string[], status: [] as string[] };
    const session = new DirectSshSession(directSpec(proxy.serverUrl), handlers(output, events));

    await session.open({
      host: '127.0.0.1',
      port: sshPort,
      user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: PASSPHRASE },
    });

    // Custody: the dial URL carried host/port ONLY — the fixture records
    // every upgrade, and its own census refuses a token field.
    expect(proxy.records.upgradeUrls).toEqual([`/proxy/v1/ssh?host=127.0.0.1&port=${sshPort}`]);
    expect(proxy.records.authFrames).toEqual([{ type: 'auth', v: 1, token: SCOPED_TOKEN_SENTINEL }]);

    session.sendInput('ping\n');
    await until(() => output.join('').includes('ECHO:ping'), 'echo round-trip');

    session.resize(120, 40);
    session.close();
    await until(() => events.exit > 0, 'exit event');
    expect(events.errors).toEqual([]);
    expect(events.status.some((s) => s.startsWith('host key '))).toBe(true);
  }, 30_000);

  it('surfaces a wrong passphrase as an open failure, not a hang', async () => {
    proxy = await startProxy();
    const output: string[] = [];
    const events = { exit: 0, errors: [] as string[], status: [] as string[] };
    const session = new DirectSshSession(directSpec(proxy.serverUrl), handlers(output, events));
    await expect(session.open({
      host: '127.0.0.1',
      port: sshPort,
      user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: 'wrong' },
    })).rejects.toThrow();
    session.close();
  }, 30_000);

  it('rejects when no key is attached', async () => {
    proxy = await startProxy();
    const session = new DirectSshSession(directSpec(proxy.serverUrl), handlers([], { exit: 0, errors: [], status: [] }));
    await expect(session.open({
      host: '127.0.0.1', port: sshPort, user: 'alexey', auth: { kind: 'key' },
    })).rejects.toThrow(/No private key/);
  });

  it('a proxy that answers admission with binary refuses the session — the sshd never saw a login', async () => {
    proxy = await startProxy('binary-first');
    const session = new DirectSshSession(directSpec(proxy.serverUrl), handlers([], { exit: 0, errors: [], status: [] }));
    await expect(session.open({
      host: '127.0.0.1', port: sshPort, user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: PASSPHRASE },
    })).rejects.toThrow(/before admission/);
    session.close();
    // The client DID send its auth frame first; the attack came after it.
    expect(proxy.records.authFrames).toEqual([{ type: 'auth', v: 1, token: SCOPED_TOKEN_SENTINEL }]);
  });

  it('a proxy whose ready carries an advisory host-key field refuses — never guessed into shape', async () => {
    proxy = await startProxy('advisory-ready');
    const session = new DirectSshSession(directSpec(proxy.serverUrl), handlers([], { exit: 0, errors: [], status: [] }));
    await expect(session.open({
      host: '127.0.0.1', port: sshPort, user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: PASSPHRASE },
    })).rejects.toThrow(/malformed frame/);
    session.close();
  });
});

describe('SshConnection: exec and session joins through the scoped proxy', () => {
  it('collects stdout, stderr, and the exit code; never rejects', async () => {
    proxy = await startProxy();
    const conn = new SshConnection();
    await conn.connect({
      scopedProxy: { serverUrl: proxy.serverUrl, admission: sentinelAdmission(), allowInsecureWs: true },
      host: '127.0.0.1',
      port: sshPort,
      user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: PASSPHRASE },
    });
    const out = await conn.exec(`a snapshot --json --sort accessed`);
    expect(out.error).toBeNull();
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('CMD:a snapshot --json --sort accessed');
    expect(out.stderr).toContain('ERR:a snapshot');
    conn.close();
  }, 30_000);

  it('runs a join command directly under a PTY', async () => {
    proxy = await startProxy();
    const conn = new SshConnection();
    await conn.connect({
      scopedProxy: { serverUrl: proxy.serverUrl, admission: sentinelAdmission(), allowInsecureWs: true },
      host: '127.0.0.1',
      port: sshPort,
      user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: PASSPHRASE },
    });
    const received: string[] = [];
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const channel = await conn.openPty({
      command: `( PATH="$HOME/.local/bin:$PATH"; a attach 'u1' ) || printf boom; exit`,
      cols: 120,
      rows: 40,
      onData: (bytes) => received.push(new TextDecoder().decode(bytes)),
      onExit: () => resolveClosed(),
      onError: () => {},
    });
    void channel;
    await closed;
    const transcript = received.join('');
    expect(transcript).toContain('CMD:');
    expect(transcript).toContain("a attach 'u1'");
    expect(transcript).toContain('PTY:yes');
    conn.close();
  }, 30_000);

  it('surfaces a refused exec as error, not a rejection', async () => {
    proxy = await startProxy();
    const conn = new SshConnection();
    await conn.connect({
      scopedProxy: { serverUrl: proxy.serverUrl, admission: sentinelAdmission(), allowInsecureWs: true },
      host: '127.0.0.1',
      port: sshPort,
      user: 'alexey',
      auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: PASSPHRASE },
    });
    conn.close();
    const out = await conn.exec('anything');
    expect(out.exitCode).toBeNull();
    expect(out.error).toContain('not open');
  }, 30_000);

  it('refuses a dial with NO scoped target — the legacy query-token relay is gone', async () => {
    const conn = new SshConnection();
    await expect(
      conn.connect({
        host: '127.0.0.1',
        port: sshPort,
        user: 'alexey',
        auth: { kind: 'key', privateKey: readFileSync(USER_KEY, 'utf8'), passphrase: PASSPHRASE },
      }),
    ).rejects.toThrow(/no scoped direct-proxy target/);
  });
});
