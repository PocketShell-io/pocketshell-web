/** PocketShell design contract: status belongs in fills/text, never borders. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import postcss from 'postcss';

const statusToken = /--(?:accent|danger|warn|ok|success|error|focus-ring)(?:[\w-]*)\b/i;
const colorLiteral = /#[\da-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|color)\([^)]*\)|\b(?:cyan|green|red|amber|orange|yellow|blue|purple|magenta|lime|teal|pink)\b/gi;

function colored(value, tokens, seen = new Set()) {
  if (statusToken.test(value)) return true;
  for (const match of value.matchAll(/var\((--[\w-]+)/g)) {
    if (seen.has(match[1])) continue;
    const next = new Set(seen).add(match[1]);
    if ((tokens.get(match[1]) ?? []).some(v => colored(v, tokens, next))) return true;
  }
  return [...value.matchAll(colorLiteral)].some(([color]) => {
    if (/^#/.test(color)) {
      let hex = color.slice(1);
      if (hex.length < 5) hex = [...hex].map(c => c + c).join('');
      const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
      // Neutral grays may have a small cool/warm tint (the border tokens do).
      return Math.max(...rgb) - Math.min(...rgb) > 24;
    }
    if (/^rgba?\(/i.test(color)) {
      const rgb = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      return rgb.length !== 3 || Math.max(...rgb) - Math.min(...rgb) > 24;
    }
    return true;
  });
}

export function accentBorderViolations(css, inheritedTokens = new Map()) {
  const root = postcss.parse(css);
  const tokens = new Map([...inheritedTokens].map(([key, values]) => [key, [...values]]));
  root.walkDecls(/^--/, d => tokens.set(d.prop, [...(tokens.get(d.prop) ?? []), d.value]));
  const violations = [];
  root.walkDecls(d => {
    if (!/^(?:border(?:-(?!radius)[\w-]+)?|outline(?:-(?:color|width|style))?|box-shadow)$/.test(d.prop)) return;
    const selector = d.parent.selector ?? '';
    const focus = postcss.list.comma(selector).every(s => /:focus-visible\b/.test(s));
    if (focus && /^(outline|box-shadow)/.test(d.prop)) return;
    const currentColor = d.parent.nodes.find(n => n.prop === 'color')?.value ?? '';
    const value = d.value.replace(/currentcolor/gi, currentColor);
    const sideStripe = /^border-(?:left|right|top|bottom|inline|block)(?:-(?:start|end))?$/.test(d.prop)
      && !/\b(?:transparent|none)\b/.test(value)
      && /(?:^|\s)(?:[2-9]\d*|1\d+)(?:px)\b/.test(value);
    if (colored(value, tokens) || sideStripe) {
      violations.push({ line: d.source.start.line, selector, property: d.prop, value: d.value, reason: sideStripe ? 'side accent thicker than a neutral hairline' : 'accent/status color on a border, outline, or shadow' });
    } else if (/^border-(?:width|color|style)$/.test(d.prop)) {
      const sides = postcss.list.space(d.value);
      if (sides.length > 1 && new Set(sides).size > 1) {
        violations.push({ line: d.source.start.line, selector, property: d.prop, value: d.value, reason: 'unequal per-side border list' });
      }
    }
  });
  return violations;
}

export function styleSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return styleSources(file);
    if (!['.css', '.vue'].includes(extname(file))) return [];
    const source = readFileSync(file, 'utf8');
    if (extname(file) === '.css') return [{ file, css: source }];
    return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(m => ({ file, css: m[1] }));
  });
}

export function scanAccentBorders(directory) {
  const sources = styleSources(directory);
  const tokens = new Map();
  for (const { css } of sources) postcss.parse(css).walkDecls(/^--/, d => tokens.set(d.prop, [...(tokens.get(d.prop) ?? []), d.value]));
  return sources.flatMap(({ file, css }) => accentBorderViolations(css, tokens).map(v => ({ file, ...v })));
}
