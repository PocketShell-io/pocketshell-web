/**
 * The web's preview group: markdown/HTML/SVG previews served to the shared
 * Files tab as sandboxed-iframe documents.
 *
 * The desktop serves previews over a `psview:` handler in main, which buys
 * one thing the web does not have yet: RELATIVE references inside a preview
 * (a README's `![img](diagram.png)`) resolve against the previewed file's
 * folder. A blob: URL has no such folder, so on the web those references do
 * not load — the document renders, its links and text are exact, and its
 * relative images show as broken. Same-origin service-worker serving is the
 * eventual fix (the app already runs a root SW for /fwd/); until then this
 * degradation is honest and visible.
 *
 * The markdown converter is the desktop's (src/main/preview/markdownDocument.ts)
 * ported line for line — same marked options (gfm, no breaks, heading ids),
 * same raw-HTML-passes argument, same app-token stylesheet, which comes from
 * core (`@pocketshell/core/preview/previewStyle`) where the desktop's own
 * copy already lives. It is deliberately NOT lifted into core itself: core
 * carries zero runtime dependencies, and this is the one module that would
 * add one (marked).
 */
import { Marked } from 'marked';
import type { RendererObject } from 'marked';
import { markdownStylesheet, type PreviewStyle } from '@pocketshell/core/preview/previewStyle';

const OPTIONS = { gfm: true, breaks: false, pedantic: false, async: false } as const;

/** Heading ids, so in-document anchors work — the desktop's eight-line
 * replacement for marked's v5 removal, duplicates suffixed per document. */
function headingRenderer(): RendererObject {
  const seen = new Map<string, number>();
  return {
    heading(token) {
      const plain = this.parser.parseInline(token.tokens, this.parser.textRenderer);
      const base = plain
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const stem = base === '' ? 'section' : base;
      const id = count === 0 ? stem : `${stem}-${count}`;
      const body = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${id}">${body}</h${token.depth}>\n`;
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One markdown source -> a complete, self-contained HTML document. */
export function markdownToHtml(source: string, options: { title: string; style: PreviewStyle }): string {
  const doc = new Marked(OPTIONS);
  doc.use({ renderer: headingRenderer() });
  const body = doc.parse(source) as string;
  return [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8">`,
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${markdownStylesheet(options.style)}</style>`,
    '</head><body><main class="md">',
    body,
    '</main></body></html>',
  ].join('');
}

/** Wrap a raw SVG payload so it renders as a document, not as markup text. */
export function svgToHtml(svg: string, title: string): string {
  return [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8">`,
    `<title>${escapeHtml(title)}</title>`,
    '<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:transparent;}svg{max-width:100%;max-height:100%;}</style>',
    '</head><body>',
    svg,
    '</body></html>',
  ].join('');
}

/**
 * The preview mint: reads the file through the sftp group, converts, and
 * hands the shared store a blob: URL whose lifetime the `token` controls
 * (`release` revokes). Tokens are opaque; the store treats them that way.
 */
export class PreviewService {
  private readonly urls = new Map<string, string>();
  private nextToken = 1;

  constructor(private readonly readFile: (path: string) => Promise<string>) {}

  async openMarkdown(path: string, style: { palette: Record<string, string>; appearance: 'dark' | 'light' }) {
    const source = await this.readFile(path);
    const html = markdownToHtml(source, { title: path, style });
    return this.mint(html);
  }

  async openHtml(path: string) {
    const html = await this.readFile(path);
    return this.mint(html);
  }

  async openSvg(path: string) {
    const svg = await this.readFile(path);
    return this.mint(svgToHtml(svg, path));
  }

  release(token: string): void {
    const url = this.urls.get(token);
    if (url !== undefined) {
      this.urls.delete(token);
      // Revoke on a delay: the frame may still be navigating to the URL it
      // was handed on this very tick.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }

  private mint(html: string): { token: string; url: string } {
    const token = `preview-${this.nextToken++}`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    this.urls.set(token, url);
    return { token, url };
  }
}
