import { describe, expect, it } from 'vitest';
import { forwardPrefix, forwardUrl, parseForwardPath } from '../src/forward/forwardPath';
import {
  buildRequest,
  filterResponseHeaders,
  HttpResponseParser,
  rewriteHtml,
  rewriteLocation,
  serializeRequest,
  type ParsedResponse,
} from '../src/forward/forwardHttp';

describe('parseForwardPath', () => {
  it('parses host, port, and path', () => {
    expect(parseForwardPath('/fwd/hetzner:3000/')).toEqual({ host: 'hetzner', port: 3000, path: '/' });
    expect(parseForwardPath('/fwd/hetzner:3000')).toEqual({ host: 'hetzner', port: 3000, path: '' });
    expect(parseForwardPath('/fwd/hetzner:3000/app/main.css')).toEqual({
      host: 'hetzner',
      port: 3000,
      path: '/app/main.css',
    });
    expect(parseForwardPath('/fwd/my.server.tld:8080/x?a=1'.split('?')[0])).toEqual({
      host: 'my.server.tld',
      port: 8080,
      path: '/x',
    });
  });

  it('rejects anything that is not a clean /fwd/<host>:<port> address', () => {
    expect(parseForwardPath('/sessions')).toBeNull();
    expect(parseForwardPath('/fwd/')).toBeNull();
    expect(parseForwardPath('/fwd/hetzner')).toBeNull();
    expect(parseForwardPath('/fwd/hetzner:0/')).toBeNull();
    expect(parseForwardPath('/fwd/hetzner:99999/')).toBeNull();
    expect(parseForwardPath('/fwd/hetzner:abc/')).toBeNull();
    expect(parseForwardPath('/fwd/hetzner:3000:x/')).toBeNull(); // second colon fails HOST_RE
    expect(parseForwardPath('/fwd/a%20b:3000/')).toBeNull(); // decoded space fails HOST_RE
  });

  it('builds the prefix and full URL', () => {
    expect(forwardPrefix('hetzner', 3000)).toBe('/fwd/hetzner:3000');
    expect(forwardUrl('hetzner', 3000)).toBe('/fwd/hetzner:3000/');
  });
});

describe('buildRequest', () => {
  it('strips pinned-to-origin and hop-by-hop headers, keeps the rest', () => {
    const req = buildRequest(
      'GET',
      '/x',
      'example.com',
      3000,
      [
        ['accept', 'text/html'],
        ['cookie', 'session=secret'],
        ['sec-fetch-site', 'same-origin'],
        ['connection', 'keep-alive'],
        ['ACCEPT-ENCODING', 'br'],
      ],
      null,
    );
    const names = req.headers.map(([n]) => n.toLowerCase());
    expect(names).toContain('accept');
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('sec-fetch-site');
    // The browser's accept-encoding is replaced, not kept: gzip only, so an
    // HTML body can still be decoded for rewriting.
    expect(req.headers.filter(([n]) => n.toLowerCase() === 'accept-encoding')).toEqual([['accept-encoding', 'gzip']]);
  });

  it('adds the far-side Host header, close, gzip, and length for bodies', () => {
    const body = new Uint8Array([1, 2, 3]);
    const post = buildRequest('POST', '/submit', 'example.com', 3000, [['content-type', 'text/plain']], body);
    expect(post.headers).toContainEqual(['host', 'example.com:3000']);
    expect(post.headers).toContainEqual(['connection', 'close']);
    expect(post.headers).toContainEqual(['accept-encoding', 'gzip']);
    expect(post.headers).toContainEqual(['content-length', '3']);

    const get80 = buildRequest('GET', '/', 'example.com', 80, [], null);
    expect(get80.headers).toContainEqual(['host', 'example.com']);
    expect(get80.body).toBeNull();

    const smuggle = buildRequest('GET', '/', 'example.com', 80, [], body);
    expect(smuggle.body).toBeNull();
    expect(smuggle.headers.some(([n]) => n.toLowerCase() === 'content-length')).toBe(false);
  });
});

describe('serializeRequest', () => {
  it('writes the exact wire bytes', () => {
    const req = buildRequest('GET', '/a?b=c', 'h', 3000, [['accept', '*/*']], null);
    expect(Buffer.from(serializeRequest(req)).toString()).toBe('GET /a?b=c HTTP/1.1\r\naccept: */*\r\nhost: h:3000\r\nconnection: close\r\naccept-encoding: gzip\r\n\r\n');
  });

  it('appends the body after the head', () => {
    const req = buildRequest('POST', '/s', 'h', 80, [], new Uint8Array([104, 105]));
    const bytes = Buffer.from(serializeRequest(req));
    expect(bytes.subarray(-2).toString()).toBe('hi');
    expect(bytes.toString().startsWith('POST /s HTTP/1.1\r\nhost: h\r\n')).toBe(true);
    expect(bytes.toString()).toContain('content-length: 2\r\n');
  });
});

function res(partial: Partial<ParsedResponse>): ParsedResponse {
  return { status: 200, statusText: 'OK', headers: [], body: new Uint8Array(0), ...partial };
}

describe('HttpResponseParser', () => {
  it('parses a content-length body in one push', () => {
    const wire = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello');
    expect(parser().push(wire)).toEqual(
      res({ headers: [['Content-Type', 'text/plain'], ['Content-Length', '5']], body: Buffer.from('hello') }),
    );
  });

  it('parses across split pushes', () => {
    const wire = Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno');
    const p = parser();
    expect(p.push(wire.subarray(0, 10))).toBeNull();
    expect(p.push(wire.subarray(10, 20))).toBeNull();
    const out = p.push(wire.subarray(20));
    expect(out?.status).toBe(404);
    expect(Buffer.from(out!.body).toString()).toBe('no');
  });

  it('decodes chunked bodies with size extensions', () => {
    const wire = Buffer.from(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n',
    );
    const out = parser().push(wire);
    expect(Buffer.from(out!.body).toString()).toBe('Wikipedia');
  });

  it('resolves close-delimited bodies in finish()', () => {
    const p = parser();
    expect(p.push(Buffer.from('HTTP/1.1 200 OK\r\n\r\npart-'))).toBeNull();
    expect(p.push(Buffer.from('two'))).toBeNull();
    const out = p.finish();
    expect(Buffer.from(out!.body).toString()).toBe('part-two');
  });

  it('refuses a truncated content-length body', () => {
    const p = parser();
    p.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc'));
    expect(p.finish()).toBeNull();
  });

  it('answers 204 with an empty body immediately', () => {
    const out = parser().push(Buffer.from('HTTP/1.1 204 No Content\r\n\r\n'));
    expect(out?.status).toBe(204);
    expect(out!.body.byteLength).toBe(0);
  });

  it('skips a 100-continue interim response', () => {
    const wire = Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok');
    const out = parser().push(wire);
    expect(out?.status).toBe(201);
    expect(Buffer.from(out!.body).toString()).toBe('ok');
  });

  it('resolves HEAD requests at the head, ignoring the missing body', () => {
    const p = new HttpResponseParser(true);
    const out = p.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\n'));
    expect(out?.status).toBe(200);
  });

  function parser(): HttpResponseParser {
    return new HttpResponseParser();
  }
});

describe('rewriteHtml', () => {
  const prefix = '/fwd/hetzner:3000';

  it('injects base and the runtime patch into <head>', () => {
    const out = rewriteHtml('<html><head><title>t</title></head><body></body></html>', prefix);
    expect(out).toContain(`<base href="${prefix}/">`);
    expect(out).toContain('window.fetch');
    expect(out).toContain('XMLHttpRequest');
    expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<title'));
  });

  it('prefixes root-relative references but not protocol-relative or foreign ones', () => {
    const html = '<a href="/login">x</a><img src="//cdn.example/x.png"><script src="https://else/y.js"></script>';
    const out = rewriteHtml(html, prefix);
    expect(out).toContain(`href="${prefix}/login"`);
    expect(out).toContain('src="//cdn.example/x.png"');
    expect(out).toContain('src="https://else/y.js"');
  });

  it('leaves already-prefixed references alone', () => {
    const html = `<link href="${prefix}/app.css" rel="stylesheet">`;
    expect(rewriteHtml(html, prefix)).toContain(`href="${prefix}/app.css"`);
  });

  it('rewrites each srcset candidate', () => {
    const out = rewriteHtml('<img srcset="/a.png 1x, /b.png 2x">', prefix);
    expect(out).toContain(`srcset="${prefix}/a.png 1x, ${prefix}/b.png 2x"`);
  });
});

describe('filterResponseHeaders', () => {
  it('drops framing, cookie, and origin-pinned headers, keeps the rest', () => {
    const out = filterResponseHeaders([
      ['Content-Type', 'text/html'],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
      ['Content-Length', '10'],
      ['Transfer-Encoding', 'chunked'],
      ['Content-Security-Policy', "default-src 'self'"],
      ['X-Frame-Options', 'DENY'],
      ['Server', 'nginx'],
    ]);
    const names = out.map(([n]) => n.toLowerCase());
    expect(names).toEqual(['content-type', 'server']);
  });
});

describe('rewriteLocation', () => {
  const prefix = '/fwd/hetzner:3000';

  it('prefixes root-relative Locations', () => {
    expect(rewriteLocation('/login?next=/', prefix, 'hetzner.example', 3000)).toBe(`${prefix}/login?next=/`);
  });

  it('prefixes absolute Locations that point back at the dialled server', () => {
    expect(rewriteLocation('http://hetzner.example:3000/w', prefix, 'hetzner.example', 3000)).toBe(`${prefix}/w`);
  });

  it('leaves foreign, protocol-relative, and bare-relative Locations alone', () => {
    expect(rewriteLocation('https://other.example/w', prefix, 'hetzner.example', 3000)).toBe('https://other.example/w');
    expect(rewriteLocation('//evil.example/w', prefix, 'hetzner.example', 3000)).toBe('//evil.example/w');
    expect(rewriteLocation('other.html', prefix, 'hetzner.example', 3000)).toBe('other.html');
  });
});
