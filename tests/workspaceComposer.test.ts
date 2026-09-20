/**
 * The composer wiring contract — the pure layer between the vendored shared
 * modules and the view. Framing and timing themselves are the shared
 * modules' job (pinned in the desktop repo's suites); here we pin what the
 * web adds: the engine narrowing, the slash-token palette gate, acceptance
 * insertion, and the never-eat-a-prompt delivery refusal.
 */
import { describe, expect, it } from 'vitest';
import { commandsFor } from '../src/shared/agentCommands';
import {
  BP_END,
  BP_START,
  SUBMIT_KEY,
  composerTiming,
  sendRoute,
} from '../src/shared/composerSend';
import {
  acceptedInput,
  liveAgentKind,
  paletteFor,
  sendComposerLine,
} from '../src/workspace/composer';

describe('liveAgentKind', () => {
  it('narrows the raw engine id to a composer engine', () => {
    expect(liveAgentKind('claude')).toBe('claude');
    expect(liveAgentKind('CODEX')).toBe('codex');
    // A shell pane talks to no agent: no palette, plain typing.
    expect(liveAgentKind(' shell ')).toBeNull();
  });

  it('reads engines aplexer did not launch as no engine at all', () => {
    expect(liveAgentKind('python')).toBeNull();
    expect(liveAgentKind('')).toBeNull();
    expect(liveAgentKind(null)).toBeNull();
    expect(liveAgentKind(undefined)).toBeNull();
  });
});

describe('paletteFor', () => {
  it('never opens without a known engine', () => {
    expect(paletteFor('/', null)).toEqual([]);
    expect(paletteFor('/cl', null)).toEqual([]);
  });

  it('opens only while the input is exactly a slash token', () => {
    expect(paletteFor('fix the bug', 'claude')).toEqual([]);
    // A space means the user is typing an argument, not picking.
    expect(paletteFor('/compact extra', 'claude')).toEqual([]);
    expect(paletteFor('/', 'claude')).toHaveLength(commandsFor('claude').length);
  });

  it('filters over command, label, and description, catalog order intact', () => {
    // Command substring…
    expect(paletteFor('/comp', 'claude').map((r) => r.command)).toEqual(['/compact']);
    // …and description substring: /init's blurb says "CLI", which contains "cl".
    const rows = paletteFor('/cl', 'claude');
    expect(rows.map((r) => r.command)).toEqual(['/clear', '/init']);
  });

  it('offers the grok catalog for a grok pane', () => {
    expect(paletteFor('/', 'grok')).toHaveLength(commandsFor('grok').length);
  });
});

describe('acceptedInput', () => {
  it('inserts a bare command verbatim and an argument command with a trailing space', () => {
    const clear = commandsFor('claude').find((c) => c.command === '/clear');
    const compact = commandsFor('claude').find((c) => c.command === '/compact');
    expect(clear).toBeDefined();
    expect(compact).toBeDefined();
    expect(acceptedInput(clear!)).toBe('/clear');
    expect(acceptedInput(compact!)).toBe('/compact ');
  });
});

describe('sendComposerLine', () => {
  const recording = () => {
    const calls: string[] = [];
    return {
      calls,
      write: (data: string) => {
        calls.push(data);
        return Promise.resolve(true);
      },
    };
  };

  it('refuses an empty or whitespace-only line without touching the PTY', async () => {
    const channel = recording();
    await expect(sendComposerLine('   ', channel.write)).resolves.toBe(false);
    expect(channel.calls).toEqual([]);
  });

  it('sends a single line as body then submit key', async () => {
    const channel = recording();
    await expect(sendComposerLine('fix the failing test', channel.write)).resolves.toBe(true);
    expect(channel.calls).toEqual(['fix the failing test', SUBMIT_KEY]);
  });

  it('frames a multi-line payload in bracketed paste', async () => {
    const channel = recording();
    await sendComposerLine('line one\nline two', channel.write);
    expect(channel.calls[0]).toBe(BP_START + 'line one\nline two' + BP_END);
    expect(channel.calls[1]).toBe(SUBMIT_KEY);
  });

  it('keeps the text (false, no submit) when the channel refuses the body', async () => {
    const calls: string[] = [];
    const dead = (data: string) => {
      calls.push(data);
      return Promise.resolve(false);
    };
    await expect(sendComposerLine('hello', dead)).resolves.toBe(false);
    expect(calls).toEqual(['hello']);
  });
});

describe('the shared routing contract the uniform delivery relies on', () => {
  it('routes a live codex pane to the agent payload and everything else raw', () => {
    expect(sendRoute({ liveAgent: 'codex', presumedAgent: null, withEnter: true })).toBe(
      'agent-payload',
    );
    expect(sendRoute({ liveAgent: 'claude', presumedAgent: null, withEnter: true })).toBe('raw');
    expect(sendRoute({ liveAgent: null, presumedAgent: null, withEnter: true })).toBe('raw');
  });

  it('keeps the submit delay at the codex floor or above for every send', () => {
    expect(composerTiming.submitDelayMs).toBeGreaterThanOrEqual(250);
  });
});
