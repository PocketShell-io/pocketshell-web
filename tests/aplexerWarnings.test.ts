import { describe, expect, it } from 'vitest';
import {
  buildAplexerCommand,
  extractMarkedOutput,
  formatAge,
  parseWarningsJson,
  type AplexerWarning,
} from '../src/aplexer/warnings';

const NONCE = 'testn01';

const ROW: AplexerWarning = {
  session: '6f0a9bd4-8e4f-4a2b-9b6e-1c2d3e4f5a6b',
  workspace: '/home/alexey/git/aplexer',
  tag: 'fix-oom',
  engine: 'zcode',
  kind: 'oom',
  detail: 'workload was killed by the kernel OOM killer (code None, signal Some(9))',
  created_at_ms: 1_700_000_000_000,
};

/** A realistic PTY transcript: MOTD, prompt, the echoed command line (whose
 * printf arguments carry the markers as literal backslash-n text), then the
 * printed GO sentinel, the payload, the END sentinel, and a fresh prompt. */
function transcript(payload: string): string {
  return [
    'Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0 x86_64)\r\n\r\n',
    'Last login: Wed Sep 17 21:00:00 2025\r\n',
    'alex@host:~$ ',
    buildAplexerCommand(NONCE, ['warnings', '--json']).replace(/\n$/, '\r\n'),
    `__PSW_${NONCE}_GO__\r\n`,
    payload,
    `__PSW_${NONCE}_END__\r\n`,
    'alex@host:~$ ',
  ].join('');
}

describe('buildAplexerCommand', () => {
  it('embeds both sentinels, silences echo, and submits one line', () => {
    const command = buildAplexerCommand(NONCE, ['warnings', '--json']);
    expect(command).toContain('stty -echo');
    expect(command).toContain(`__PSW_${NONCE}_GO__`);
    expect(command).toContain(`__PSW_${NONCE}_END__`);
    expect(command).toContain(` a 'warnings' '--json';`);
    expect(command.endsWith('\n')).toBe(true);
  });

  it('single-quotes arguments so odd selectors survive the shell', () => {
    const command = buildAplexerCommand(NONCE, ['ack', 'my work:tag']);
    expect(command).toContain(`a 'ack' 'my work:tag';`);
  });
});

describe('extractMarkedOutput', () => {
  it('returns exactly what the command printed', () => {
    const json = JSON.stringify([ROW]);
    expect(extractMarkedOutput(transcript(json), NONCE)).toBe(json);
  });

  it('keeps multi-line payloads verbatim but hands the last newline to the sentinel', () => {
    // The shell separates the command's output from the END sentinel with
    // one line terminator; that terminator (and only that one) is stripped.
    expect(extractMarkedOutput(transcript('line one\r\nline two\r\n'), NONCE)).toBe(
      'line one\r\nline two',
    );
    expect(extractMarkedOutput(transcript(''), NONCE)).toBe('');
  });

  it('ignores the marker text inside the echoed command line', () => {
    // The echo precedes the printed GO sentinel; a naive first-occurrence
    // anchor would return the MOTD. The transcript's payload position is
    // what the result must reflect.
    const json = JSON.stringify([]);
    const out = extractMarkedOutput(transcript(json), NONCE);
    expect(out).toBe(json);
    expect(out).not.toContain('Welcome to Ubuntu');
  });

  it('returns null when a sentinel never lands', () => {
    expect(extractMarkedOutput('', NONCE)).toBeNull();
    const partial = transcript(JSON.stringify([])).replace(`__PSW_${NONCE}_END__\r\n`, '');
    expect(extractMarkedOutput(partial, NONCE)).toBeNull();
    expect(extractMarkedOutput(`__PSW_${NONCE}_END__\r\n`, NONCE)).toBeNull();
  });
});

describe('parseWarningsJson', () => {
  it('parses a well-formed warning list', () => {
    expect(parseWarningsJson(JSON.stringify([ROW, { ...ROW, kind: 'crash' }]))).toEqual([
      ROW,
      { ...ROW, kind: 'crash' },
    ]);
  });

  it('parses an empty list', () => {
    expect(parseWarningsJson('[]')).toEqual([]);
  });

  it('tolerates PTY carriage returns around and between rows', () => {
    // Raw \r\n lands outside the JSON tokens (a PTY echoes them around the
    // payload); it must never be injected inside string literals, where a
    // control character would make the JSON unparseable.
    const second = { ...ROW, kind: 'crash' as const };
    const spread = `[${JSON.stringify(ROW)},\r\n${JSON.stringify(second)}]`;
    expect(parseWarningsJson(`\r\n${spread}\r\n`)).toEqual([ROW, second]);
  });

  it('rejects shell noise, wrong shapes, and bad rows with null', () => {
    expect(parseWarningsJson('bash: a: command not found')).toBeNull();
    expect(parseWarningsJson('{"warnings":[]}')).toBeNull();
    expect(parseWarningsJson(JSON.stringify([{ ...ROW, kind: 'kaboom' }]))).toBeNull();
    expect(parseWarningsJson(JSON.stringify([{ ...ROW, created_at_ms: '1700' }]))).toBeNull();
    expect(parseWarningsJson(JSON.stringify([{ ...ROW, tag: undefined }]))).toBeNull();
  });
});

describe('formatAge', () => {
  const now = 1_700_000_360_000;
  it('renders the usual buckets', () => {
    expect(formatAge(now, now - 30_000)).toBe('just now');
    expect(formatAge(now, now - 90_000)).toBe('1m ago');
    expect(formatAge(now, now - 7_200_000)).toBe('2h ago');
    expect(formatAge(now, now - 72 * 3_600_000)).toBe('3d ago');
  });

  it('never renders a negative age from clock skew', () => {
    expect(formatAge(now, now + 60_000)).toBe('just now');
  });
});
