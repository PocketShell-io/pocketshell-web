import { describe, expect, it } from 'vitest';
// @ts-expect-error The shared policy scanner is native JavaScript.
import { accentBorderViolations, scanAccentBorders } from '../scripts/accent-borders.mjs';

describe('no accent borders design contract', () => {
  it.each([
    'border-left: 3px solid var(--accent)',
    'border-inline-start: 2px solid cyan',
    'border-left: 3px solid var(--border)',
    'border-block-end: 2px solid #23272e',
    'border-block-end: 1px solid var(--warning)',
    'border: 1px solid var(--danger)',
    'border-color: #ff0000',
    'outline: 2px solid rgb(255, 0, 0)',
    'box-shadow: inset 0 0 0 1px var(--ok)',
    'box-shadow: 0 0 0 2px var(--success-soft)',
    'border-width: 1px 0 0 3px',
    'border-color: #23272e #33383f',
  ])('rejects %s', declaration => {
    expect(accentBorderViolations(`.card { ${declaration}; }`)).not.toEqual([]);
  });

  it.each([
    '.card { border: 1px solid var(--border); }',
    '.row { border-top: 1px solid #23272e; border-bottom: 1px solid var(--border-soft); }',
    'input:hover { border-color: var(--border-strong); }',
    'button:focus-visible { outline: 2px solid var(--accent); }',
    'input:focus-visible { box-shadow: 0 0 0 2px var(--accent); }',
    '.warning { background: var(--error-soft); color: var(--error); border: none; }',
    '.card { border-width: 1px 1px 1px 1px; }',
  ])('allows %s', css => expect(accentBorderViolations(css)).toEqual([]));

  it('does not exempt non-focus selectors in a selector list', () => {
    expect(accentBorderViolations('.card, button:focus-visible { outline: 1px solid red; }')).toHaveLength(1);
  });

  it('catches status color through currentColor', () => {
    expect(accentBorderViolations('.card { color: var(--error); border: 1px solid currentColor; }')).toHaveLength(1);
  });

  it('follows color token aliases', () => {
    expect(accentBorderViolations(':root { --stripe: var(--error); } .card { border: 1px solid var(--stripe); }')).toHaveLength(1);
  });

  it('web styles contain no accent borders', () => {
    expect(scanAccentBorders(new URL('../src', import.meta.url).pathname)).toEqual([]);
  });
});
