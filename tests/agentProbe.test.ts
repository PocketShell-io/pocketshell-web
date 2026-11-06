import { describe, expect, it } from 'vitest';
import {
  PocketshellProbe,
  parseEngineCatalog,
  parseProfilesEnvelope,
} from '../src/workspace/agentProbe';
import type { ExecOutcome } from '../src/terminal/connection';

describe('parseEngineCatalog', () => {
  it('keeps custom available IDs, deduplicates and excludes unavailable engines and shell',()=>{
    expect(parseEngineCatalog(JSON.stringify([{name:'claude',available:true},{name:'custom-ai',available:true},{name:'custom-ai',available:true},{name:'codex',available:false},{name:'shell',available:true}]),0)).toEqual(['claude','custom-ai']);
  });
  it('distinguishes a successful empty catalog from failure',()=>{
    expect(parseEngineCatalog('[]',0)).toEqual([]);expect(parseEngineCatalog('[]',2)).toBeNull();
  });
  it('refuses malformed JSON, rows, envelope and availability flags',()=>{
    for(const s of ['bad','{}','[null]','[[]]','[{"name":"a","available":"yes"}]','[{"name":"","available":true}]'])expect(parseEngineCatalog(s,0)).toBeNull();
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

describe('PocketshellProbe', () => {
  it('PATH-wraps the live catalog command and reports the host answer', async () => {
    const calls: string[] = [];
    const transport = {
      async exec(command: string): Promise<ExecOutcome> {
        calls.push(command);
        if (command.includes('a engines --json')) {
          return { exitCode: 0, stdout: JSON.stringify([{name:'claude',available:true},{name:'custom-ai',available:true}]), stderr: '', error: null };
        }
        return { exitCode: 0, stdout: 'pocketshell, version 0.4.44\n', stderr: '', error: null };
      },
    };
    const probe = new PocketshellProbe(transport);
    const support = await probe.agentSupport();
    expect(calls.every((c) => c.includes('/bin/sh -lc') && c.includes('$HOME/.local/bin'))).toBe(true);
    expect(support.engineIds).toEqual(['claude', 'custom-ai']);
    expect(calls).toHaveLength(1);

    const profiles = await probe.listProfiles();
    expect(profiles).toEqual([]);
  });

  it('never throws on a dead transport: null catalog, empty profiles', async () => {
    const probe = new PocketshellProbe({
      async exec() {
        throw new Error('channel closed');
      },
    });
    const support = await probe.agentSupport();
    expect(support.engineIds).toBeNull();
    expect(await probe.listProfiles()).toEqual([]);
  });
});
