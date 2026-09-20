import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PocketshellProbe,
  parseAgentSubcommands,
  parseHelperVersion,
  parseProfilesEnvelope,
} from '../src/workspace/agentProbe';
import type { ExecOutcome } from '../src/terminal/connection';

const FIXTURE = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('parseAgentSubcommands', () => {
  it('reads the Commands: block of the pinned 0.4.44 help', () => {
    expect(parseAgentSubcommands(FIXTURE('v0.4.44-agent-help.txt'), 0)).toEqual([
      'claude',
      'codex',
      'opencode',
    ]);
  });

  it('answers null on the exit 2 of a subcommand the helper lacks', () => {
    expect(
      parseAgentSubcommands(FIXTURE('v0.4.44-agent-no-such-command.stderr.txt'), 2),
    ).toBeNull();
  });

  it('answers null with no Commands: header even at exit 0', () => {
    expect(parseAgentSubcommands('Usage: pocketshell agent [OPTIONS]\n', 0)).toBeNull();
  });

  it('carries PTY carriage returns fine and skips continuation lines', () => {
    const text = 'Usage: x\r\n\r\nCommands:\r\n  claude    Launch `claude`.\r\n            more words\r\n  codex     Launch `codex`.\r\n';
    expect(parseAgentSubcommands(text, 0)).toEqual(['claude', 'codex']);
  });
});

describe('parseProfilesEnvelope', () => {
  it('unwraps the 0.4.44 {"profiles": [...]} envelope', () => {
    const body = JSON.stringify({
      profiles: [
        { name: 'Claude (Z.AI)', engine: 'claude', config_dir: '/home/a/.claude-zai', default: false },
        { name: 'default', engine: 'claude', config_dir: null, default: true },
      ],
    });
    expect(parseProfilesEnvelope(body)).toHaveLength(2);
  });

  it('answers [] for a bare array, a non-JSON body, or a wrong envelope', () => {
    expect(parseProfilesEnvelope('[]')).toEqual([]);
    expect(parseProfilesEnvelope('command not found')).toEqual([]);
    expect(parseProfilesEnvelope('{"rows": []}')).toEqual([]);
  });
});

describe('parseHelperVersion', () => {
  it('takes the first line only', () => {
    expect(parseHelperVersion('pocketshell, version 0.4.44\nnext\n')).toBe('pocketshell, version 0.4.44');
    expect(parseHelperVersion('\n')).toBeNull();
  });
});

describe('PocketshellProbe', () => {
  it('PATH-wraps both probe commands and reports the host answer', async () => {
    const calls: string[] = [];
    const transport = {
      async exec(command: string): Promise<ExecOutcome> {
        calls.push(command);
        if (command.includes('agent --help')) {
          return { exitCode: 0, stdout: FIXTURE('v0.4.44-agent-help.txt'), stderr: '', error: null };
        }
        return { exitCode: 0, stdout: 'pocketshell, version 0.4.44\n', stderr: '', error: null };
      },
    };
    const probe = new PocketshellProbe(transport);
    const support = await probe.agentSupport();
    expect(calls.every((c) => c.includes('/bin/sh -lc') && c.includes('$HOME/.local/bin'))).toBe(true);
    expect(support.subcommands).toEqual(['claude', 'codex', 'opencode']);
    expect(support.helperVersion).toContain('0.4.44');

    const profiles = await probe.listProfiles();
    expect(profiles).toEqual([]);
  });

  it('never throws on a dead transport: null subcommands, empty profiles', async () => {
    const probe = new PocketshellProbe({
      async exec() {
        throw new Error('channel closed');
      },
    });
    const support = await probe.agentSupport();
    expect(support.subcommands).toBeNull();
    expect(await probe.listProfiles()).toEqual([]);
  });
});
