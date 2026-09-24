import { describe, expect, it } from 'vitest';
import { ShellService } from '../src/platform/shellService';
import { HostHelper } from '../src/platform/hostHelper';
import { ProjectsService } from '../src/platform/projectsService';
import { safeScopePath } from '../src/platform/webAttachments';
import type { ExecOutcome, PtyChannel, PtyRequest } from '../src/terminal/connection';

/** A deterministic fake connection: exec answers from a table, PTY opens
 * record their request so tests can assert the join command spelling. */
class FakeConnection {
  openedPtys: PtyRequest[] = [];
  execTable: Record<string, ExecOutcome> = {};
  channelFactory: (req: PtyRequest) => PtyChannel = (req) => fakeChannel(req);

  async exec(command: string): Promise<ExecOutcome> {
    for (const key of Object.keys(this.execTable)) {
      if (command.includes(key)) return this.execTable[key]!;
    }
    return { exitCode: 0, stdout: '', stderr: '', error: null };
  }

  async openPty(req: PtyRequest): Promise<PtyChannel> {
    this.openedPtys.push(req);
    return this.channelFactory(req);
  }
}

function fakeChannel(_req: PtyRequest): PtyChannel {
  return {
    write: () => {},
    resize: () => {},
    close: () => {},
  };
}

/** An `a` that answers available, with a snapshot the projects flow reads. */
const A_SNAPSHOT = [
  { id: 'uuid-1', workspace: '/home/u/git/mixer', tag: 'main', phase: 'running', created: 100, activity: 200, engine: null, path: '/home/u/git/mixer' },
  { id: 'uuid-2', workspace: '/home/u/git/mixer', tag: 'docs', phase: 'running', created: 100, activity: 300, engine: 'claude', path: '/home/u/git/mixer' },
];

function aplexerConnection(): FakeConnection {
  const conn = new FakeConnection();
  conn.execTable['command -v a'] = { exitCode: 0, stdout: '/usr/local/bin/a\n', stderr: '', error: null };
  conn.execTable['a --version'] = { exitCode: 0, stdout: 'aplexer 1.0\n', stderr: '', error: null };
  conn.execTable['a snapshot'] = {
    exitCode: 0,
    stdout: `${JSON.stringify(A_SNAPSHOT)}\n`,
    stderr: '',
    error: null,
  };
  return conn;
}

describe('ShellService (the TmuxClientPool twin)', () => {
  it('attachSession opens a PTY whose command IS the aplexer join, and re-attach switches', async () => {
    const conn = new FakeConnection();
    const shell = new ShellService();
    const first = await shell.attachSession(conn, 'conn-1', {
      connectionId: 'conn-1',
      sessionName: 'main',
      backend: 'aplexer',
      workspace: '/home/u/git/mixer',
      tag: 'main',
      aplexerId: 'uuid-1',
      cols: 80,
      rows: 24,
    });
    expect(first.switched).toBe(false);
    expect(conn.openedPtys).toHaveLength(1);
    expect(conn.openedPtys[0]!.command).toContain('a attach');
    expect(conn.openedPtys[0]!.command).toContain('uuid-1');

    const second = await shell.attachSession(conn, 'conn-1', {
      connectionId: 'conn-1',
      sessionName: 'main',
      backend: 'aplexer',
      workspace: '/home/u/git/mixer',
      tag: 'main',
      aplexerId: 'uuid-1',
    });
    expect(second).toEqual({ shellId: first.shellId, switched: true });
    expect(conn.openedPtys).toHaveLength(1);
  });

  it('an aplexer tag in another workspace is a DIFFERENT tab — the pool keys by workspace+tag', async () => {
    const conn = new FakeConnection();
    const shell = new ShellService();
    await shell.attachSession(conn, 'conn-1', {
      connectionId: 'conn-1', sessionName: 'main', backend: 'aplexer', workspace: '/a', tag: 'main',
    });
    await shell.attachSession(conn, 'conn-1', {
      connectionId: 'conn-1', sessionName: 'main', backend: 'aplexer', workspace: '/b', tag: 'main',
    });
    expect(conn.openedPtys).toHaveLength(2);
  });

  it('input honours the fence: a stale sessionName is refused with false', async () => {
    const conn = new FakeConnection();
    const shell = new ShellService();
    const { shellId } = await shell.attachSession(conn, 'conn-1', {
      connectionId: 'conn-1', sessionName: 'main', backend: 'aplexer', workspace: '/a', tag: 'main',
    });
    expect(await shell.input(shellId, 'ls', 'main', '/a')).toBe(true);
    expect(await shell.input(shellId, 'ls', 'docs', '/a')).toBe(false);
    expect(await shell.input('shell-999', 'ls')).toBe(false);
  });

  it('a closed shell is dropped from the pool — the next attach joins fresh', async () => {
    const conn = new FakeConnection();
    const shell = new ShellService();
    const { shellId } = await shell.attachSession(conn, 'conn-1', {
      connectionId: 'conn-1', sessionName: 'main', backend: 'aplexer', workspace: '/a', tag: 'main',
    });
    await shell.close(shellId);
    expect(shell.holds(shellId)).toBe(false);
    await shell.attachSession(conn, 'conn-1', {
      connectionId: 'conn-1', sessionName: 'main', backend: 'aplexer', workspace: '/a', tag: 'main',
    });
    expect(conn.openedPtys).toHaveLength(2);
  });
});

describe('HostHelper (the helper group twin)', () => {
  it('sessionsList returns the aplexer snapshot wholesale, and [] (never null) when `a` is absent', async () => {
    const withA = aplexerConnection();
    const helperWithA = new HostHelper(withA as never);
    const rows = await helperWithA.listSessions();
    expect(rows.map((r) => r.name)).toEqual(['main', 'docs']);

    const withoutA = new FakeConnection();
    withoutA.execTable['command -v a'] = { exitCode: 1, stdout: '', stderr: '', error: null };
    withoutA.execTable['list-sessions'] = { exitCode: 1, stdout: 'no server running', stderr: '', error: null };
    const helper = new HostHelper(withoutA as never);
    await expect(helper.listSessions()).resolves.toEqual([]);
  });

  it('usage throws with the host line when the helper ran and failed, [] when it is absent', async () => {
    const failed = new FakeConnection();
    failed.execTable['pocketshell usage'] = { exitCode: 1, stdout: '', stderr: 'boom\n', error: null };
    failed.execTable['command -v pocketshell'] = { exitCode: 0, stdout: '/bin/pocketshell\n', stderr: '', error: null };
    const helper = new HostHelper(failed as never);
    await expect(helper.usage()).rejects.toThrow('boom');

    const absent = new FakeConnection();
    absent.execTable['pocketshell usage'] = { exitCode: 127, stdout: '', stderr: '/bin/sh: pocketshell: command not found\n', error: null };
    await expect(new HostHelper(absent as never).usage()).resolves.toEqual([]);
  });
});

describe('ProjectsService (the folder-first flow twin)', () => {
  it('reuses a live aplexer session under the reuse policy', async () => {
    const conn = aplexerConnection();
    conn.execTable['printf %s "$HOME"'] = { exitCode: 0, stdout: '/home/u', stderr: '', error: null };
    conn.execTable['cd -- '] = { exitCode: 0, stdout: '/home/u/git/mixer\n', stderr: '', error: null };
    const projects = new ProjectsService(conn as never, 'conn-1');
    const result = await projects.startSession({ folder: '/home/u/git/mixer' });
    expect(result).toMatchObject({
      ok: true,
      sessionName: 'main',
      folder: '/home/u/git/mixer',
      reused: true,
      via: 'aplexer',
      aplexerId: 'uuid-1',
    });
  });

  it('unique walks to a free tag in the workspace and refuses when the host did not answer', async () => {
    const conn = aplexerConnection();
    conn.execTable['printf %s "$HOME"'] = { exitCode: 0, stdout: '/home/u', stderr: '', error: null };
    conn.execTable['cd -- '] = { exitCode: 0, stdout: '/home/u/git/mixer\n', stderr: '', error: null };
    conn.execTable['a start'] = {
      exitCode: 0,
      stdout: `${JSON.stringify({ id: 'uuid-3', tag: 'main-2' })}\n`,
      stderr: '',
      error: null,
    };
    const projects = new ProjectsService(conn as never, 'conn-1');
    const result = await projects.startSession({
      folder: '/home/u/git/mixer',
      namePolicy: 'unique',
    });
    expect(result.ok).toBe(true);
    expect(result.sessionName).toBe('main-2');

    // A snapshot that cannot be read fails CLOSED: nothing created.
    const broken = new FakeConnection();
    broken.execTable['command -v a'] = { exitCode: 0, stdout: '/usr/local/bin/a\n', stderr: '', error: null };
    broken.execTable['a snapshot'] = { exitCode: 1, stdout: '', stderr: 'no', error: null };
    const failing = new ProjectsService(broken as never, 'conn-1');
    await expect(failing.startSession({ folder: '/x', namePolicy: 'unique' })).resolves.toMatchObject({
      ok: false,
      code: 'folder-missing',
    });
  });

  it('kill of an aplexer row goes by id and reports the ordinary stale race', async () => {
    const conn = aplexerConnection();
    // `a kill` reports the stale race on stderr with a non-zero exit.
    conn.execTable['a kill'] = { exitCode: 1, stdout: '', stderr: 'a: no matching session\n', error: null };
    const projects = new ProjectsService(conn as never, 'conn-1');
    const result = await projects.killSession('docs', { workspace: '/home/u/git/mixer' });
    expect(result).toMatchObject({ ok: false, code: 'not-found' });
  });
});

describe('attachment scope folding', () => {
  it('matches the desktop stager: segments fold, traversal folds away, blank is session', () => {
    expect(safeScopePath('/home/u/git/mixer/main')).toBe('home/u/git/mixer/main');
    expect(safeScopePath('../etc/passwd')).toBe('etc/passwd');
    expect(safeScopePath('///')).toBe('session');
  });
});
