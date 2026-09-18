/**
 * PocketShell dumb relay — the whole point is that there is nothing here to
 * read: the browser speaks SSH itself (src/terminal/direct.ts) and this
 * worker just ferries bytes between its WebSocket and a TCP stream toward
 * host:port. The only intelligence is the front door: the Google ID token
 * is verified (JWKS + audience + allowlist) before the TCP leg opens, so
 * the endpoint is not an open relay.
 *
 * Deploy: see relay/README.md. Free tier covers this easily — one request
 * per session instead of API Gateway's per-message billing.
 */
import { connect } from 'cloudflare:sockets';

export interface Env {
  GOOGLE_CLIENT_ID: string;
  /** Comma-separated allowlist; empty means deny everyone (fail closed). */
  ALLOWLIST_EMAILS: string;
}

interface Claims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  email?: string;
  email_verified?: boolean;
}

function b64urlDecode(part: string): Uint8Array {
  const pad = 4 - (part.length % 4 || 4);
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonOf(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** RS256 verify against Google's JWKS (cached at the edge for an hour). */
async function verifyGoogleToken(token: string, env: Env): Promise<Claims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let claims: Claims;
  try {
    header = jsonOf(b64urlDecode(parts[0]));
    claims = jsonOf(b64urlDecode(parts[1])) as Claims;
  } catch {
    return null;
  }
  if (header['alg'] !== 'RS256') return null;

  const audience = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
  const now = Math.floor(Date.now() / 1000);
  const allow = env.ALLOWLIST_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e !== '');
  if (
    (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com')
    || audience !== env.GOOGLE_CLIENT_ID
    || claims.exp === undefined || claims.exp < now
    || !claims.email || !claims.email_verified
    || !allow.includes(claims.email.toLowerCase())
  ) {
    return null;
  }

  let jwks: { keys: Array<Record<string, unknown> & { kid: string }> };
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { cf: { cacheTtl: 3600 } });
    jwks = (await res.json()) as typeof jwks;
  } catch {
    return null;
  }
  const jwk = jwks.keys.find((k) => k.kid === header['kid']);
  if (!jwk) return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('jwk', jwk as unknown as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]) as unknown as ArrayBuffer, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  return ok ? claims : null;
}

/** The relay dials only public SSH endpoints — no ambient-metadata games. */
function isDialableHost(host: string): boolean {
  if (!/^[a-z0-9.:-]+$/i.test(host)) return false;
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10 || a === 169 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
  }
  return true;
}

async function pipe(server: WebSocket, tcp: Socket): Promise<void> {
  const writer = tcp.writable.getWriter();
  server.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) void writer.write(new Uint8Array(data));
    else if (typeof data === 'string') void writer.write(new TextEncoder().encode(data));
    else if (ArrayBuffer.isView(data)) void writer.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  });
  server.addEventListener('close', () => {
    try {
      tcp.close();
    } catch {
      // already gone
    }
  });
  server.addEventListener('error', () => {
    try {
      tcp.close();
    } catch {
      // already gone
    }
  });

  const reader = tcp.readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      server.send(value);
    }
  } catch {
    // dial reset or runtime shutdown — drop the client socket
  } finally {
    reader.releaseLock();
    try {
      server.close();
    } catch {
      // client already closed
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('pocketshell relay (websocket only)\n', { status: 426 });
    }
    const url = new URL(request.url);
    const token = url.searchParams.get('token') ?? '';
    const host = url.searchParams.get('host') ?? '';
    const port = Number(url.searchParams.get('port') ?? '22');
    if (host === '' || !isDialableHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return new Response('bad host or port', { status: 400 });
    }

    const claims = await verifyGoogleToken(token, env);
    if (claims === null) return new Response('unauthorized', { status: 401 });

    let tcp: Socket;
    try {
      tcp = connect(`${host}:${port}`);
    } catch {
      return new Response('dial failed', { status: 502 });
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    void pipe(server, tcp);
    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};
