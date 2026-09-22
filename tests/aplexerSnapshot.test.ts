import { describe, expect, it } from 'vitest';
import {
  agentKindFromEngine,
  aplexerRecordToSummary,
  byOldestCreated,
  parseAplexerSnapshot,
} from '../src/shared/aplexerParsers';

const LIVE_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  workspace: '/home/alexey/git/pocketshell-web',
  tag: 'main',
  engine: 'codex',
  cwd: '/home/alexey/git/pocketshell-web',
  phase: 'running',
  worker_alive: true,
  created_at_ms: 1_000_000,
  last_activity_ms: 2_000_000,
};

describe('parseAplexerSnapshot', () => {
  it('parses the live rows in document order', () => {
    const rows = parseAplexerSnapshot(JSON.stringify([LIVE_ROW, { ...LIVE_ROW, id: '2', tag: 'ssh-broke' }]));
    expect(rows.map((r) => r.tag)).toEqual(['main', 'ssh-broke']);
  });

  it('drops dead workers and unenriched terminal phases — liveness is the pair, never the phase alone', () => {
    const dead = { ...LIVE_ROW, worker_alive: false };
    // No worker_alive field at all plus a terminal phase: an old host — a
    // session that will never attach again. (`worker_alive: undefined`
    // serialises out of JSON.stringify, which is the point.)
    const gone = { ...LIVE_ROW, phase: 'exited', worker_alive: undefined };
    const failed = { ...LIVE_ROW, phase: 'failed', worker_alive: undefined };
    // The host explicitly says alive: the row stays even on a terminal
    // phase — contradictory host data is the host's to prune, not ours to
    // hide. Same rule the desktop's parser pins.
    const exitedLive = { ...LIVE_ROW, phase: 'exited' };
    const rows = parseAplexerSnapshot(JSON.stringify([dead, gone, failed, exitedLive]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase).toBe('exited');
  });

  it('drops corrupt rows individually, not the batch', () => {
    const rows = parseAplexerSnapshot(
      JSON.stringify([{ nope: true }, LIVE_ROW, 'a string', { id: '', workspace: 'w', tag: 't' }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(LIVE_ROW.id);
  });

  it('answers [] for unparseable or non-array bodies', () => {
    expect(parseAplexerSnapshot('command not found')).toEqual([]);
    expect(parseAplexerSnapshot('{"not":"an array"}')).toEqual([]);
    expect(parseAplexerSnapshot('')).toEqual([]);
  });

  it('defaults missing optional fields', () => {
    const rows = parseAplexerSnapshot(
      JSON.stringify([{ id: 'x', workspace: '/w', tag: 't', phase: 'running', created_at_ms: 5 }]),
    );
    expect(rows[0]).toMatchObject({ engine: '', created_at_ms: 5 });
    expect('cwd' in rows[0]!).toBe(false);
    expect('last_activity_ms' in rows[0]!).toBe(false);
  });
});

describe('byOldestCreated', () => {
  it('sorts oldest first, stable within a tick', () => {
    const a = { ...LIVE_ROW, id: 'a', created_at_ms: 300 };
    const b = { ...LIVE_ROW, id: 'b', created_at_ms: 100 };
    const c = { ...LIVE_ROW, id: 'c', created_at_ms: 200 };
    expect(byOldestCreated([a, b, c]).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('agentKindFromEngine', () => {
  it('maps the known engines and refuses the rest', () => {
    expect(agentKindFromEngine('claude')).toBe('claude');
    expect(agentKindFromEngine('CODEX')).toBe('codex');
    expect(agentKindFromEngine(' opencode ')).toBe('opencode');
    expect(agentKindFromEngine('grok')).toBe('grok');
    expect(agentKindFromEngine('shell')).toBe('shell');
    expect(agentKindFromEngine('mystery')).toBeNull();
    expect(agentKindFromEngine('')).toBeNull();
  });
});

describe('aplexerRecordToSummary', () => {
  it('carries the tag as the name and the workspace as the path', () => {
    const summary = aplexerRecordToSummary(LIVE_ROW);
    expect(summary).toMatchObject({
      name: 'main',
      tag: 'main',
      workspace: LIVE_ROW.workspace,
      path: LIVE_ROW.workspace,
      aplexerId: LIVE_ROW.id,
      agentKind: 'codex',
      backend: 'aplexer',
      attached: false,
      created: 1000,
      activity: 2000,
      aplexerPhase: 'running',
    });
  });

  it('falls back to cwd when the workspace is unusable, and activity to created', () => {
    const summary = aplexerRecordToSummary({
      ...LIVE_ROW,
      workspace: '',
      cwd: '/tmp/fallback',
      last_activity_ms: undefined,
    });
    expect(summary.path).toBe('/tmp/fallback');
    expect(summary.activity).toBe(1000);
  });
});
