import { describe, expect, it } from 'vitest';
import type { ExecOutcome } from '../src/terminal/connection';
import { AplexerClient } from '../src/aplexer/client';
import { aplexerAckCommand, aplexerProbeCommand, aplexerSnapshotCommand } from '../src/shared/aplexerCommands';
import { pathAwareCommand } from '../src/shared/aplexerCommands';

const RECORD = {
  id: 'u1',
  workspace: '/home/a/git/proj',
  tag: 'main',
  engine: 'shell',
  phase: 'running',
  worker_alive: true,
  created_at_ms: 5_000,
  last_activity_ms: 6_000,
};

class FakeTransport {
  calls: { command: string; opts: { timeoutMs?: number } | undefined }[] = [];
  private routes: { pattern: RegExp; reply: (command: string) => ExecOutcome | Promise<ExecOutcome> }[] = [];

  /** First matching route answers; an unmatched command is a generic fail. */
  on(pattern: RegExp, reply: (command: string) => ExecOutcome | Promise<ExecOutcome>): void {
    this.routes.push({ pattern, reply });
  }

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecOutcome> {
    this.calls.push({ command, opts });
    for (const route of this.routes) {
      if (route.pattern.test(command)) return await route.reply(command);
    }
    return fail('no route for: ' + command);
  }
}

function ok(stdout = '', stderr = ''): ExecOutcome {
  return { exitCode: 0, stdout, stderr, error: null };
}

function fail(stderr = 'boom', stdout = '', exitCode = 1): ExecOutcome {
  return { exitCode, stdout, stderr, error: null };
}

describe('AplexerClient availability', () => {
  it('probes once and remembers the positive', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => ok('/home/a/.local/bin/a\n'));
    const client = new AplexerClient(transport);
    expect(await client.isAvailable()).toBe(true);
    expect(await client.isAvailable()).toBe(true);
    const probes = transport.calls.filter((c) => c.command === pathAwareCommand('command -v a') || c.command.includes('command -v a'));
    expect(probes).toHaveLength(1);
  });

  it('remembers the negative too, and listSessions answers null', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => fail('sh: 1: a: not found'));
    const client = new AplexerClient(transport);
    expect(await client.listSessions()).toBeNull();
    expect(await client.listSessions()).toBeNull();
    expect(transport.calls).toHaveLength(1);
  });

  it('treats an exec failure as "no aplexer", not a crash', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => ({ exitCode: null, stdout: '', stderr: '', error: 'connection is not open' }));
    const client = new AplexerClient(transport);
    expect(await client.isAvailable()).toBe(false);
  });

  it('evict clears the cache', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => fail(''));
    const client = new AplexerClient(transport);
    await client.isAvailable();
    client.evict();
    await client.isAvailable();
    expect(transport.calls).toHaveLength(2);
  });
});

describe('AplexerClient.listSessions', () => {
  it('runs the sorted snapshot and keeps its document order', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => ok('/bin/a'));
    transport.on(/a snapshot --json --sort accessed/, () =>
      ok(JSON.stringify([RECORD, { ...RECORD, id: 'u0', tag: 'older-tag' }])),
    );
    const client = new AplexerClient(transport);
    const rows = await client.listSessions();
    expect(rows).toHaveLength(2);
    expect(rows![0]!.name).toBe('main');
    const snap = transport.calls.find((c) => c.command.includes('snapshot'))!;
    expect(snap.command).toBe(pathAwareCommand(aplexerSnapshotCommand('accessed')));
  });

  it('falls back to the unsorted snapshot when the host refuses --sort, and remembers', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => ok('/bin/a'));
    transport.on(/--sort/, () => fail('a: error: unrecognized argument: --sort'));
    transport.on(/a snapshot --json'/, () => ok(JSON.stringify([
      { ...RECORD, id: 'new', created_at_ms: 9_000 },
      { ...RECORD, id: 'old', created_at_ms: 1_000 },
    ])));
    const client = new AplexerClient(transport);
    const rows = await client.listSessions();
    // Client-side oldest-created order for a host without the flag.
    expect(rows!.map((r) => r.aplexerId)).toEqual(['old', 'new']);
    await client.listSessions();
    // The second tick skips the refused flag entirely.
    expect(transport.calls.filter((c) => c.command.includes('--sort'))).toHaveLength(1);
  });

  it('does NOT remember the fallback for a non-usage failure', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => ok('/bin/a'));
    transport.on(/--sort/, () => fail('boom: the host fell over'));
    transport.on(/a snapshot --json'/, () => ok('[]'));
    const client = new AplexerClient(transport);
    await client.listSessions();
    await client.listSessions();
    expect(transport.calls.filter((c) => c.command.includes('--sort'))).toHaveLength(2);
  });

  it('answers [] when the host has a but the exec dies', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => ok('/bin/a'));
    transport.on(/a snapshot --json --sort accessed/, () => {
      throw new Error('socket gone');
    });
    transport.on(/a snapshot --json'/, () => ({ exitCode: null, stdout: '', stderr: '', error: 'socket gone' }));
    const client = new AplexerClient(transport);
    expect(await client.listSessions()).toEqual([]);
  });
});

describe('AplexerClient mutations', () => {
  function clientWithStart(exitCode: number, stdout: string, stderr: string) {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => ok('/bin/a'));
    transport.on(/a snapshot --json --sort accessed/, () => ok('[]'));
    transport.on(/a snapshot --json'/, () => ok(JSON.stringify([RECORD])));
    transport.on(/a start --workspace/, () => ({ exitCode, stdout, stderr, error: null }));
    transport.on(/a kill/, () => ok());
    transport.on(/a rename/, () => ok());
    return { transport, client: new AplexerClient(transport) };
  }

  it('startSession returns the echoed record', async () => {
    const { client } = clientWithStart(0, JSON.stringify(RECORD), '');
    const out = await client.startSession({ workspace: '/home/a/git/proj', tag: 'main' });
    expect(out).toMatchObject({ ok: true, id: 'u1', tag: 'main', liveRefusal: false, error: null });
  });

  it('startSession maps the live refusal', async () => {
    const { client } = clientWithStart(1, '', 'a: workspace /home/a/git/proj already belongs to session main');
    const out = await client.startSession({ workspace: '/home/a/git/proj', tag: 'main' });
    expect(out.ok).toBe(false);
    expect(out.liveRefusal).toBe(true);
  });

  it('startSession surfaces other failures with the host sentence', async () => {
    const { client } = clientWithStart(1, '', 'a: workspace path does not exist');
    const out = await client.startSession({ workspace: '/nope', tag: 'x' });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('a: workspace path does not exist');
  });

  it('killSession distinguishes gone from error', async () => {
    const { client } = clientWithStart(0, '', '');
    expect(await client.killSession('u1')).toMatchObject({ ok: true, notFound: false });
    const transport2 = new FakeTransport();
    transport2.on(/a kill/, () => fail('a: no matching session'));
    const client2 = new AplexerClient(transport2);
    expect(await client2.killSession('zz')).toMatchObject({ ok: false, notFound: true });
  });

  it('renameSession ok and notFound', async () => {
    const { client } = clientWithStart(0, '', '');
    expect(await client.renameSession('u1', 'renamed')).toMatchObject({ ok: true });
    const transport2 = new FakeTransport();
    transport2.on(/a rename/, () => fail('a: no matching session'));
    const client2 = new AplexerClient(transport2);
    expect(await client2.renameSession('zz', 'x')).toMatchObject({ ok: false, notFound: true });
  });

  it('warnings and ack ride the availability cache', async () => {
    const transport = new FakeTransport();
    transport.on(/command -v a/, () => ok('/bin/a'));
    transport.on(/a warnings --json/, () => ok('[]'));
    transport.on(/a ack/, () => ok());
    const client = new AplexerClient(transport);
    expect(await client.listWarnings()).toEqual([]);
    await client.ackWarnings();
    await client.ackWarnings('some-uuid');
    const acks = transport.calls.filter((c) => c.command.includes('a ack'));
    expect(acks.map((a) => a.command)).toEqual([
      pathAwareCommand(aplexerAckCommand()),
      pathAwareCommand(aplexerAckCommand('some-uuid')),
    ]);
    expect(
      transport.calls.filter((c) => c.command === pathAwareCommand(aplexerProbeCommand())),
    ).toHaveLength(1);
  });
});
