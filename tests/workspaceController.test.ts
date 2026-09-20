import { describe, expect, it, vi } from 'vitest';
import { HostWorkspaceController, type WorkspaceLink } from '../src/workspace/controller';
import type { ExecOutcome, PtyChannel, PtyRequest } from '../src/terminal/connection';
import type { ConnectOptions } from '../src/terminal/connection';

const LINK: WorkspaceLink = {
  url: 'ws://relay.test',
  idToken: 'tok',
  host: 'hetzner.test',
  port: 22,
  user: 'alexey',
  auth: { kind: 'password', password: 'pw' },
};

const RECORD = {
  id: 'u1',
  workspace: '/home/a/git/proj',
  tag: 'main',
  engine: 'shell',
  phase: 'running',
  worker_alive: true,
  created_at_ms: 1_000,
  last_activity_ms: 2_000,
};

class FakePty implements PtyChannel {
  writes: string[] = [];
  resizes: { rows: number; cols: number }[] = [];
  closed = false;
  constructor(
    public readonly command: string | undefined,
    private readonly req: PtyRequest,
  ) {}
  write(text: string) {
    this.writes.push(text);
  }
  resize(rows: number, cols: number) {
    this.resizes.push({ rows, cols });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.req.onExit();
  }
  /** The far end speaking. */
  emit(text: string) {
    this.req.onData(new TextEncoder().encode(text));
  }
}

class FakeConnection {
  connectCalls: ConnectOptions[] = [];
  execCalls: string[] = [];
  ptys: FakePty[] = [];
  closed = false;
  connectReject = false;
  hasA = true;
  onClosedHook: (() => void) | null = null;
  /** The host's live records — mutations answer the next snapshot. */
  records: Record<string, unknown>[] = [RECORD];

  async connect(opts: ConnectOptions): Promise<void> {
    this.connectCalls.push(opts);
    this.onClosedHook = opts.onClosed ?? null;
    if (this.connectReject) throw new Error('all authentication methods failed');
  }

  async exec(command: string): Promise<ExecOutcome> {
    this.execCalls.push(command);
    // The client PATH-wraps every command, so inner quotes arrive escaped
    // (`a ack '\''u9'\'''`); un-escape once and parse the shell's view.
    const inner = command.replaceAll("'\\''", "'");
    if (inner.includes('command -v a')) {
      return this.hasA
        ? { exitCode: 0, stdout: '/home/a/.local/bin/a\n', stderr: '', error: null }
        : { exitCode: 1, stdout: '', stderr: '', error: null };
    }
    if (inner.includes('a snapshot --json')) {
      return { exitCode: 0, stdout: JSON.stringify(this.records), stderr: '', error: null };
    }
    if (inner.includes('a warnings --json')) {
      return { exitCode: 0, stdout: '[]', stderr: '', error: null };
    }
    if (inner.includes('a start --workspace')) {
      const created = { ...RECORD, id: 'u2', tag: 'side' };
      this.records.push(created);
      return { exitCode: 0, stdout: JSON.stringify(created), stderr: '', error: null };
    }
    if (inner.includes('a kill')) {
      this.records = this.records.filter((r) => !inner.includes(`'${r['id']}'`));
      return { exitCode: 0, stdout: '', stderr: '', error: null };
    }
    if (inner.includes('a rename')) {
      const newTag = /--tag '([^']*)'/.exec(inner)?.[1] ?? '';
      this.records = this.records.map((r) =>
        inner.includes(`'${r['id']}'`) ? { ...r, tag: newTag } : r,
      );
      return { exitCode: 0, stdout: '', stderr: '', error: null };
    }
    if (inner.includes('pocketshell agent --help')) {
      return {
        exitCode: 0,
        stdout:
          'Usage: pocketshell agent [OPTIONS] COMMAND\n\nCommands:\n' +
          '  claude    Launch `claude`.\n  codex     Launch `codex`.\n',
        stderr: '',
        error: null,
      };
    }
    if (inner.includes('pocketshell --version')) {
      return { exitCode: 0, stdout: 'pocketshell, version 0.4.44\n', stderr: '', error: null };
    }
    if (inner.includes('pocketshell profiles list')) {
      return { exitCode: 0, stdout: '{"profiles": []}', stderr: '', error: null };
    }
    return { exitCode: 0, stdout: '', stderr: '', error: null };
  }

  async openPty(req: PtyRequest): Promise<PtyChannel> {
    const pty = new FakePty(req.command, req);
    this.ptys.push(pty);
    return pty;
  }

  close(): void {
    this.closed = true;
  }
}

function makeController(pollMs = 60_000) {
  const conn = new FakeConnection();
  const controller = new HostWorkspaceController({
    link: LINK,
    makeConnection: () => conn as unknown as import('../src/terminal/connection').SshConnection,
    pollMs,
  });
  return { conn, controller };
}

async function started(pollMs = 60_000) {
  const { conn, controller } = makeController(pollMs);
  await controller.start();
  return { conn, controller };
}

describe('workspace start', () => {
  it('connects, probes aplexer, and lists the snapshot', async () => {
    const { conn, controller } = await started();
    expect(conn.connectCalls).toHaveLength(1);
    expect(controller.state.phase).toBe('ready');
    expect(controller.state.aplexer).toBe(true);
    expect(controller.state.rows.map((r) => r.tag)).toEqual(['main']);
    expect(controller.state.groups).toHaveLength(1);
    expect(controller.state.groups[0]).toMatchObject({
      workspace: '/home/a/git/proj',
      label: 'proj',
    });
    // Availability was probed under the PATH-aware wrapper, like the desktop.
    expect(conn.execCalls[0]).toContain('command -v a');
    expect(conn.execCalls[0]).toContain('.local/bin');
  });

  it('connect failure lands in state, phase failed, no throw', async () => {
    const { conn, controller } = makeController();
    conn.connectReject = true;
    await controller.start();
    expect(controller.state.phase).toBe('failed');
    expect(controller.state.error).toContain('authentication');
  });

  it('a host without `a` gets one raw shell tab and no sessions', async () => {
    const { conn, controller } = makeController();
    conn.hasA = false;
    await controller.start();
    expect(controller.state.aplexer).toBe(false);
    expect(controller.state.rows).toEqual([]);
    expect(controller.state.tabs.map((t) => t.key)).toEqual(['shell']);
    expect(controller.state.activeKey).toBe('shell');
    expect(conn.ptys[0]!.command).toBeUndefined();
  });
});

describe('session tabs', () => {
  it('opens a session tab with the join command under a PTY and activates it', async () => {
    const { conn, controller } = await started();
    const row = controller.state.rows[0]!;
    await controller.openSession(row);
    const tab = controller.state.tabs[0]!;
    expect(tab.key).toBe(`apx:u1`);
    expect(tab.label).toBe('main');
    expect(tab.subtitle).toBe('proj');
    expect(controller.state.activeKey).toBe('apx:u1');
    // The join is exec'd directly under the PTY, by uuid — not typed into a
    // login shell.
    expect(conn.ptys[0]!.command).toContain(`a attach 'u1'`);
  });

  it('re-activates an existing tab instead of joining twice', async () => {
    const { controller } = await started();
    const row = controller.state.rows[0]!;
    await controller.openSession(row);
    await controller.openSession(row);
    expect(controller.state.tabs).toHaveLength(1);
  });

  it('channel data reaches the tab-keyed listener; close flips the tab dead', async () => {
    const { conn, controller } = await started();
    await controller.openSession(controller.state.rows[0]!);
    const seen: { key: string; text: string }[] = [];
    controller.onChannelData((key, bytes) => seen.push({ key, text: new TextDecoder().decode(bytes) }));
    conn.ptys[0]!.emit('hello');
    expect(seen).toEqual([{ key: 'apx:u1', text: 'hello' }]);

    conn.ptys[0]!.close();
    expect(controller.state.tabs[0]!.live).toBe(false);
  });

  it('keystrokes and resizes reach the tab channel; closeTab removes it', async () => {
    const { conn, controller } = await started();
    await controller.openSession(controller.state.rows[0]!);
    controller.writeToTab('apx:u1', 'ls\r');
    expect(conn.ptys[0]!.writes).toEqual(['ls\r']);
    controller.resizeTab('apx:u1', 120, 40);
    expect(conn.ptys[0]!.resizes).toEqual([{ rows: 40, cols: 120 }]);
    controller.closeTab('apx:u1');
    expect(controller.state.tabs).toHaveLength(0);
    expect(controller.state.activeKey).toBeNull();
    expect(conn.ptys[0]!.closed).toBe(true);
  });

  it('deliverToTab reports refusal for a missing channel, success for a live one', async () => {
    const { conn, controller } = await started();
    // No tab yet: the composer's send must be a refused send, not a swallow.
    expect(controller.deliverToTab('apx:none', 'x')).toBe(false);
    await controller.openSession(controller.state.rows[0]!);
    expect(controller.deliverToTab('apx:u1', 'echo hi\r')).toBe(true);
    expect(conn.ptys[0]!.writes).toEqual(['echo hi\r']);
  });

  it('a poll that loses the session marks the tab gone', async () => {
    const { conn, controller } = await started();
    await controller.openSession(controller.state.rows[0]!);
    conn.records = [];
    await controller.refresh();
    expect(controller.state.tabs[0]!.phase).toBe('gone');
    // The tab itself stays until its channel exits.
    expect(controller.state.tabs).toHaveLength(1);
  });
});

describe('create / kill / rename', () => {
  it('createSession starts, refreshes, and opens the new tab', async () => {
    const { controller } = await started();
    const out = await controller.createSession('/home/a/git/proj', 'side');
    expect(out.ok).toBe(true);
    expect(controller.state.rows.map((r) => r.tag)).toEqual(['main', 'side']);
    expect(controller.state.tabs.map((t) => t.key)).toEqual(['apx:u2']);
  });

  it('createSession failure surfaces the host sentence, opens nothing', async () => {
    const { conn, controller } = makeController();
    const realExec = conn.exec.bind(conn);
    vi.spyOn(conn, 'exec').mockImplementation(async (command: string) => {
      if (command.includes('a start --workspace')) {
        return { exitCode: 1, stdout: '', stderr: 'a: workspace path does not exist', error: null };
      }
      return realExec(command);
    });
    await controller.start();
    const out = await controller.createSession('/nope', 'x');
    expect(out.ok).toBe(false);
    expect(controller.state.actionError).toContain('workspace path does not exist');
    expect(controller.state.tabs).toHaveLength(0);
  });

  it('killSession drops the row and closes nothing the user still has', async () => {
    const { conn, controller } = await started();
    await controller.openSession(controller.state.rows[0]!);
    // The tab stays open on kill — its channel exits on its own when the
    // workload dies; the user closes the dead tab.
    await controller.killSession(controller.state.rows[0]!);
    expect(controller.state.rows).toHaveLength(0);
    expect(controller.state.tabs).toHaveLength(1);
  });

  it('renameSession updates the open tab label', async () => {
    const { controller } = await started();
    await controller.openSession(controller.state.rows[0]!);
    await controller.renameSession(controller.state.rows[0]!, 'renamed');
    expect(controller.state.tabs[0]!.label).toBe('renamed');
  });
});

describe('warnings + dispose', () => {
  it('acks one warning and refetches', async () => {
    const { conn, controller } = await started();
    const realExec = conn.exec.bind(conn);
    vi.spyOn(conn, 'exec').mockImplementation(async (command: string) => {
      conn.execCalls.push(command);
      if (command.includes('a warnings --json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              session: 'u9',
              workspace: '/w',
              tag: 't',
              engine: 'codex',
              kind: 'oom',
              detail: 'killed',
              created_at_ms: 1,
            },
          ]),
          stderr: '',
          error: null,
        };
      }
      return realExec(command);
    });
    await controller.refresh();
    expect(controller.state.warnings).toHaveLength(1);
    await controller.ackWarning('u9');
    // The wire command is PATH-wrapped with escaped inner quotes
    // (`a ack '\''u9'\'''`), so match on the pieces that survive escaping.
    expect(conn.execCalls.some((c) => c.includes('a ack') && c.includes("'u9'"))).toBe(true);
    // Refetch after ack: the spy still answers the same list — the refetch
    // is the refresh's business, the host owns the truth.
    expect(conn.execCalls.filter((c) => c.includes('a warnings --json')).length).toBeGreaterThanOrEqual(2);
  });

  it('dispose closes the connection and every channel', async () => {
    const { conn, controller } = await started();
    await controller.openSession(controller.state.rows[0]!);
    controller.dispose();
    expect(conn.closed).toBe(true);
    expect(conn.ptys[0]!.closed).toBe(true);
  });

  it('connection death marks every tab dead and stops the status', async () => {
    const { conn, controller } = await started();
    await controller.openSession(controller.state.rows[0]!);
    conn.onClosedHook!();
    expect(controller.state.status).toBe('disconnected');
    expect(controller.state.tabs[0]!.live).toBe(false);
  });
});

describe('agent probe + launch', () => {
  function makeLaunchController() {
    const conn = new FakeConnection();
    const controller = new HostWorkspaceController({
      link: LINK,
      makeConnection: () => conn as unknown as import('../src/terminal/connection').SshConnection,
      pollMs: 60_000,
      launchTimeoutMs: 200,
    });
    return { conn, controller };
  }

  it('probeAgent answers from the helper help, PATH-wrapped, never cached shut', async () => {
    const { conn, controller } = makeLaunchController();
    await controller.start();
    const before = conn.execCalls.length;
    await controller.probeAgent();
    const probeCalls = conn.execCalls.slice(before);
    expect(probeCalls.some((c) => c.includes('pocketshell agent --help'))).toBe(true);
    expect(probeCalls.every((c) => c.includes('.local/bin'))).toBe(true);
    expect(controller.state.agentSupport?.subcommands).toEqual(['claude', 'codex']);
    expect(controller.state.agentProbing).toBe(false);
  });

  it('launch creates the session, waits for the PTY to speak, then types the line', async () => {
    const { conn, controller } = makeLaunchController();
    await controller.start();
    conn.execCalls.length = 0;
    const p = controller.launchAgentSession(
      { kind: 'claude', dir: '/home/a/git/proj', skipPermissions: true, profile: null },
      '/home/a/git/proj',
      'side',
    );
    const pty = () => conn.ptys.at(-1)!;
    await vi.waitFor(
      () => {
        expect(controller.state.tabs.some((t) => t.key === 'apx:u2')).toBe(true);
        // One emit per poll: whichever lands after the launch armed its wait
        // resolves it, and the assert then holds on the NEXT poll (the write
        // lands in a microtask after the resolver fires).
        pty().emit('main $ ');
        expect(pty().writes.join('')).toContain('pocketshell agent');
      },
      { interval: 5, timeout: 500 },
    );
    const outcome = await p;
    expect(outcome.ok).toBe(true);
    // The helper's WRAPPER line, not a bare `claude` — and Enter with it.
    expect(pty().writes.at(-1)).toBe("pocketshell agent claude --dir '/home/a/git/proj'\r");
    expect(controller.state.actionError).toBe('');
  });

  it('a PTY that never speaks expires into the paste-it-yourself remedy', async () => {
    const { conn, controller } = makeLaunchController();
    await controller.start();
    const p = controller.launchAgentSession(
      { kind: 'claude', dir: '/home/a/git/proj', skipPermissions: true, profile: null },
      '/home/a/git/proj',
      'side',
    );
    const outcome = await p;
    expect(outcome.ok).toBe(true); // the session itself is real either way
    expect(controller.state.actionError).toContain('did not come up in time');
    expect(controller.state.actionError).toContain("pocketshell agent claude --dir '/home/a/git/proj'");
    expect(conn.ptys.at(-1)!.writes).toEqual([]);
  });

  it('a launch the host would refuse costs nothing: no session, no exec', async () => {
    const { conn, controller } = makeLaunchController();
    await controller.start();
    const before = conn.execCalls.length;
    const outcome = await controller.launchAgentSession(
      { kind: 'claude', dir: '', skipPermissions: true, profile: null },
      '/home/a/git/proj',
      'side',
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('cannot be launched');
    expect(controller.state.actionError).toContain('cannot be launched');
    expect(conn.execCalls.length).toBe(before);
  });
});


