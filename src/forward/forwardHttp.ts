/**
 * Pure HTTP plumbing for the /fwd/ tunnel: shape the wire request the far
 * side should see, parse the one response back, and rewrite HTML documents
 * so their references stay inside the /fwd/ scope. Everything with a
 * checkable answer lives here (node-tested); the service worker only
 * shuffles bytes and the forwarder only glues this to SSH channels.
 *
 * Scope limits, stated once and in the user's terms: forwarded traffic is
 * plain HTTP inside the SSH tunnel (an HTTPS port cannot be terminated in a
 * page), each response buffers fully in memory, cookies are dropped, and
 * apps that hard-code absolute URLs or speak WebSocket escape the scope.
 * That is the price of needing no infrastructure — no wildcard DNS, no
 * per-host subdomain, no per-server daemon.
 */
import { Buffer } from 'node:buffer';

/**
 * Headers that must not cross the tunnel: hop-by-hop machinery, plus the
 * ones the browser pins to THIS origin that a remote app must never see
 * (cookies for app.pocketshell.io, the sec-fetch hints). accept-encoding is
 * replaced with gzip specifically — never br — so an HTML body can still be
 * decoded for rewriting by DecompressionStream.
 */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'cookie',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'sec-fetch-credentials',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
]);

export interface BuiltRequest {
  method: string;
  /** Path + query on the far side, starting with '/'. */
  target: string;
  headers: Array<[string, string]>;
  body: Uint8Array | null;
}

/**
 * Shape one intercepted request into wire form. `Connection: close` is the
 * load-bearing line: it lets the one-channel-per-request exchange end at
 * the server's own close instead of parsing keep-alive framing.
 */
export function buildRequest(
  method: string,
  target: string,
  destHost: string,
  destPort: number,
  browserHeaders: Array<[string, string]>,
  body: Uint8Array | null,
): BuiltRequest {
  const hostHeader = destPort === 80 ? destHost : `${destHost}:${destPort}`;
  const headers: Array<[string, string]> = [];
  for (const [name, value] of browserHeaders) {
    if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers.push([name, value]);
  }
  headers.push(['host', hostHeader]);
  headers.push(['connection', 'close']);
  headers.push(['accept-encoding', 'gzip']);
  let outBody = body;
  // A GET or HEAD with a body (a worker replay quirk) reads as smuggling.
  if (outBody !== null && (method === 'GET' || method === 'HEAD' || outBody.byteLength === 0)) {
    outBody = null;
  }
  if (outBody !== null) headers.push(['content-length', String(outBody.byteLength)]);
  return { method, target, headers, body: outBody };
}

export function serializeRequest(req: BuiltRequest): Uint8Array {
  const head =
    `${req.method} ${req.target} HTTP/1.1\r\n` +
    req.headers.map(([n, v]) => `${n}: ${v}`).join('\r\n') +
    '\r\n\r\n';
  const headBytes = Buffer.from(head, 'utf8');
  if (req.body === null || req.body.byteLength === 0) return headBytes;
  return Buffer.concat([headBytes, Buffer.from(req.body)]);
}

export function headerValue(headers: Array<[string, string]>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [n, v] of headers) {
    if (n.toLowerCase() === lower) return v;
  }
  return null;
}

/** One parsed HTTP response. The body is decoded of transfer framing
 * (chunked) but NOT content-encoding — these are the bytes as served. */
export interface ParsedResponse {
  status: number;
  statusText: string;
  /** Original casing, duplicates preserved (Set-Cookie). */
  headers: Array<[string, string]>;
  body: Uint8Array;
}

type ResponseHead = {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyless: boolean;
};

function parseHead(headText: string): ResponseHead | 'interim' | null {
  const lines = headText.split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? '');
  if (m === null) return null;
  const status = Number(m[1]);
  if (status >= 100 && status < 200) return 'interim';
  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c <= 0) continue;
    headers.push([line.slice(0, c).trim(), line.slice(c + 1).trim()]);
  }
  // 204 and 304 carry no body by definition; HEAD is handled via headOnly.
  return { status, statusText: m[2] ?? '', headers, bodyless: status === 204 || status === 304 };
}

/**
 * Incremental HTTP/1.1 response parser for the one request per channel
 * exchange. `push` until it returns a response (content-length and chunked
 * bodies know their own end); for a close-delimited body call `finish` when
 * the channel ends.
 */
export class HttpResponseParser {
  private buf = Buffer.alloc(0);
  private headDone = false;
  private pending: {
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
    parts: Buffer[];
    /** Bytes still owed; -1 = chunked or close-delimited. */
    remaining: number;
    chunked: boolean;
    afterChunkHead: boolean;
  } | null = null;

  /** Resolve as soon as the head is parsed (HEAD requests: a content-length
   * with no following body is legal there). */
  constructor(private readonly headOnly = false) {}

  push(chunk: Uint8Array): ParsedResponse | null {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    for (;;) {
      if (!this.headDone) {
        const sep = this.buf.indexOf('\r\n\r\n');
        if (sep === -1) return null;
        const headText = this.buf.subarray(0, sep).toString('utf8');
        this.buf = Buffer.from(this.buf.subarray(sep + 4));
        const head = parseHead(headText);
        if (head === null) throw new Error('malformed HTTP response head');
        if (head === 'interim') continue; // 1xx — the real response may sit right behind it
        this.headDone = true;
        if (this.headOnly || head.bodyless) {
          return { status: head.status, statusText: head.statusText, headers: head.headers, body: new Uint8Array(0) };
        }
        const te = headerValue(head.headers, 'transfer-encoding') ?? '';
        const cl = headerValue(head.headers, 'content-length');
        const chunked = te.toLowerCase().includes('chunked');
        this.pending = {
          status: head.status,
          statusText: head.statusText,
          headers: head.headers,
          parts: [],
          remaining: chunked || cl === null ? -1 : Number(cl),
          chunked,
          afterChunkHead: true,
        };
      }
      return this.consume();
    }
  }

  /** The channel closed — resolves a close-delimited body, or null when the
   * framing said more was coming (a truncated body; the caller reports it). */
  finish(): ParsedResponse | null {
    const p = this.pending;
    if (p === null) return null;
    if (!p.chunked && p.remaining === -1) {
      // Close-delimited: whatever the read buffer holds IS the body.
      const body = Buffer.concat([...p.parts, Buffer.from(this.buf)]);
      this.pending = null;
      return { status: p.status, statusText: p.statusText, headers: p.headers, body };
    }
    return null;
  }

  private consume(): ParsedResponse | null {
    const p = this.pending;
    if (p === null) return null;
    if (p.chunked) {
      const body = this.decodeChunked();
      if (body === null) return null;
      return { status: p.status, statusText: p.statusText, headers: p.headers, body };
    }
    if (p.remaining === -1) return null; // close-delimited: finish() owns it
    if (this.buf.byteLength < p.remaining) return null;
    const body = Buffer.from(this.buf.subarray(0, p.remaining));
    return { status: p.status, statusText: p.statusText, headers: p.headers, body };
  }

  private decodeChunked(): Buffer | null {
    const p = this.pending!;
    for (;;) {
      if (p.afterChunkHead) {
        const sep = this.buf.indexOf('\r\n');
        if (sep === -1) return null;
        const sizeText = this.buf.subarray(0, sep).toString('utf8').split(';')[0].trim();
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size) || size < 0) throw new Error('malformed chunk size');
        this.buf = Buffer.from(this.buf.subarray(sep + 2));
        p.afterChunkHead = false;
        if (size === 0) return Buffer.concat(p.parts); // trailers ride the close
        p.remaining = size;
      }
      if (this.buf.byteLength < p.remaining + 2) return null;
      p.parts.push(Buffer.from(this.buf.subarray(0, p.remaining)));
      this.buf = Buffer.from(this.buf.subarray(p.remaining + 2)); // CRLF after the chunk
      p.afterChunkHead = true;
    }
  }
}

function isHtml(contentType: string | null): boolean {
  return contentType !== null && /text\/html/i.test(contentType);
}

/** True when the worker should decode + rewrite this document. */
export function isRewritableHtml(res: ParsedResponse): boolean {
  return isHtml(headerValue(res.headers, 'content-type'));
}

/**
 * Rewrite one HTML document so its references stay inside the /fwd/ scope:
 * a <base> for document-relative URLs, an attribute pass for the
 * root-relative ones <base> cannot reach, and a fetch/XHR patch for code
 * that builds paths at runtime. Absolute foreign URLs are left alone —
 * they escape the scope honestly rather than break silently.
 */
export function rewriteHtml(html: string, prefix: string): string {
  const skip = (val: string): boolean => val.startsWith('//') || val === prefix || val.startsWith(prefix + '/');
  let out = html.replace(
    /(\s(?:src|href|action|poster|formaction)\s*=\s*)(["'])(\/[^"']*)\2/gi,
    (m, lead: string, q: string, val: string) => (skip(val) ? m : `${lead}${q}${prefix}${val}${q}`),
  );
  out = out.replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (m, lead: string, q: string, val: string) => {
    const fixed = val.replace(/(^|[\s,])(\/[^,\s]*)/g, (seg, sep: string, url: string) =>
      skip(url) ? seg : `${sep}${prefix}${url}`,
    );
    return fixed === val ? m : `${lead}${q}${fixed}${q}`;
  });
  const script =
    '<script>(function(){' +
    'var P=' +
    JSON.stringify(prefix) +
    ';' +
    'function fix(u){' +
    'return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.slice(0,P.length+1)!==P+"/"?P+u:u}' +
    'var of=window.fetch;' +
    'window.fetch=function(i,init){try{' +
    'if(typeof i==="string")i=fix(i);' +
    'else if(i&&typeof i.url==="string"&&!(i instanceof Request))i=fix(String(i));' +
    '}catch(e){}return of.call(window,i,init)};' +
    'var oo=XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open=function(){try{arguments[1]=fix(String(arguments[1]))}catch(e){}return oo.apply(this,arguments)};' +
    '})();</script>';
  const inject = `<base href="${prefix}/">${script}`;
  const headOpen = /<head[^>]*>/i.exec(out);
  if (headOpen !== null) {
    const at = headOpen.index + headOpen[0].length;
    out = out.slice(0, at) + inject + out.slice(at);
  } else {
    out = inject + out;
  }
  return out;
}

/**
 * Response headers that must not be replayed to the page. content-length
 * goes too: the body was decoded from transfer framing and possibly
 * rewritten, so the Response sets its own. content-encoding is stripped by
 * the forwarder only when it actually decoded the body — not here.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  // Written for the app's real origin; replayed it can only break the page.
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  // Site-scoped cookies for the real origin must not leak into this one.
  'set-cookie',
]);

export function filterResponseHeaders(headers: Array<[string, string]>): Array<[string, string]> {
  return headers.filter(([n]) => !STRIP_RESPONSE_HEADERS.has(n.toLowerCase()));
}

/** Rewrite a Location so same-server redirects stay in the scope.
 * Root-relative (the common case) always matches; absolute URLs match only
 * when they point at the very server we dialled. Anything else escapes. */
export function rewriteLocation(location: string, prefix: string, destHost: string, destPort: number): string {
  if (location.startsWith('/') && !location.startsWith('//')) return prefix + location;
  try {
    const u = new URL(location);
    const samePort = u.port === String(destPort) || (u.port === '' && destPort === 80);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname === destHost && samePort) {
      return prefix + u.pathname + u.search + u.hash;
    }
  } catch {
    // A bare relative Location ('other.html') resolves against <base>.
  }
  return location;
}
