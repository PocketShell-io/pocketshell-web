/**
 * An in-process fixture standing in for the Go scoped direct proxy: it
 * implements the EXACT v1 wire contract the shipping client must satisfy —
 * dial `ws(s)://host/proxy/v1/ssh?host=<host>&port=<port>` (ONLY those two
 * query fields), first message a bounded TEXT auth frame
 * `{type:"auth",v:1,token}`, the fixture answers the EXACT two-field ready,
 * and from there binary frames pipe both ways to a real TCP upstream (the
 * tests point it at an in-process ssh2 server).
 *
 * The fixture is deliberately fail-closed about the CLIENT's bytes: a wrong
 * path, an unknown query field, a duplicate field, a token in the URL, a
 * binary first frame, an auth frame with an extra field, or a second text
 * frame is recorded and the socket is killed with a close code — the tests
 * assert custody against what this fixture ACTUALLY saw, not against what
 * the client meant to send.
 */
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

export const SCOPED_TOKEN_SENTINEL = 'scoped-broker-jwt.sentinel.signature';

export type ScopedFixtureMode =
  /** admit, then pipe binary to the upstream */
  | 'ok'
  /** a binary frame arrives before any ready — the client must refuse */
  | 'binary-first'
  /** ready with an extra gateway-style field — the client must refuse */
  | 'advisory-ready'
  /** ready with the wrong version */
  | 'wrong-version-ready'
  /** a TEXT error frame instead of ready — the client must refuse */
  | 'error-text'
  /** close right after the auth frame (old server without the route) */
  | 'close-after-auth'
  /** close before the client even finishes the handshake */
  | 'close-immediately'
  /** never answer the auth frame at all */
  | 'stall'
  /** answer ready, then send a TEXT control frame mid-stream */
  | 'text-after-ready';

export interface ScopedFixtureRecords {
  /** Every upgrade URL, verbatim. */
  upgradeUrls: string[];
  /** The parsed auth frame(s) — what the client ACTUALLY sent first. */
  authFrames: Record<string, unknown>[];
  /** Every TEXT frame, verbatim (custody scans run over these). */
  textFrames: string[];
  /** Binary bytes received from the client AFTER admission. */
  binaryChunks: Buffer[];
  /** The refusal the fixture itself applied to the client's wire bytes. */
  refusals: string[];
  sshAuthAttempts: number;
}

export interface ScopedFixture {
  /** ws://127.0.0.1:<port> — a bare origin for the client's serverUrl. */
  serverUrl: string;
  records: ScopedFixtureRecords;
  close(): Promise<void>;
}

export function startScopedProxyFixture(
  upstreamPort: number,
  opts: { mode?: ScopedFixtureMode; requireTokenEquals?: string } = {},
): Promise<ScopedFixture> {
  const mode = opts.mode ?? 'ok';
  const records: ScopedFixtureRecords = {
    upgradeUrls: [],
    authFrames: [],
    textFrames: [],
    binaryChunks: [],
    refusals: [],
    sshAuthAttempts: 0,
  };

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    records.upgradeUrls.push(req.url ?? '');
    const refuse = (code: number, why: string) => {
      records.refusals.push(why);
      socket.write(`HTTP/1.1 400 Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    // EXACT route + query census: /proxy/v1/ssh, host and port ONCE each,
    // nothing else, no token field.
    if (url.pathname !== '/proxy/v1/ssh') return refuse(400, `wrong path ${url.pathname}`);
    const q = url.searchParams;
    const keys = [...q.keys()].sort();
    if (keys.length !== 2 || keys[0] !== 'host' || keys[1] !== 'port') {
      return refuse(400, `query census ${keys.join(',')}`);
    }
    if ((q.get('token') ?? null) !== null) return refuse(400, 'token in URL');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let admitted = false;
    let upstream: net.Socket | null = null;

    const kill = (code: number) => {
      try {
        ws.close(code);
      } catch {
        // already dead
      }
    };

    const pipeUpstream = () => {
      upstream = net.connect(upstreamPort, '127.0.0.1', () => undefined);
      upstream.on('data', (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      });
      upstream.on('error', () => kill(1011));
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          records.binaryChunks.push(Buffer.from(data as Buffer));
          if (upstream !== null && !upstream.destroyed) upstream.write(data as Buffer);
          return;
        }
        // TEXT after admission is a protocol violation on the server side
        records.textFrames.push(String(data));
        kill(4400);
      });
      ws.on('close', () => upstream?.destroy());
    };

    ws.on('message', (data, isBinary) => {
      if (admitted) return; // the piped handler owns post-ready traffic
      if (!isBinary) records.textFrames.push(String(data));
      if (mode === 'close-immediately') {
        kill(1006);
        return;
      }
      if (isBinary) {
        records.refusals.push('binary first frame');
        kill(4400);
        return;
      }
      // Strict auth-frame census: exactly type/v/token.
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        records.refusals.push('auth frame not JSON');
        kill(4400);
        return;
      }
      const keys = Object.keys(frame).sort();
      if (keys.length !== 3 || keys[0] !== 'token' || keys[1] !== 'type' || keys[2] !== 'v') {
        records.refusals.push(`auth frame fields ${keys.join(',')}`);
        kill(4400);
        return;
      }
      if (frame['type'] !== 'auth' || frame['v'] !== 1 || typeof frame['token'] !== 'string') {
        records.refusals.push('auth frame shape');
        kill(4400);
        return;
      }
      if (opts.requireTokenEquals !== undefined && frame['token'] !== opts.requireTokenEquals) {
        records.refusals.push('auth token mismatch');
        kill(4401);
        return;
      }
      records.authFrames.push(frame);
      if (mode === 'binary-first') {
        ws.send(Buffer.from([0x00]));
        kill(4400);
        return;
      }
      if (mode === 'error-text') {
        ws.send(JSON.stringify({ type: 'error', v: 1, code: 'denied', message: 'no' }));
        kill(4400);
        return;
      }
      if (mode === 'close-after-auth' || mode === 'stall') {
        if (mode === 'close-after-auth') kill(4404);
        return;
      }
      // Admit: the EXACT two-field ready.
      admitted = true;
      if (mode === 'advisory-ready') ws.send(JSON.stringify({ type: 'ready', v: 1, ssh_host_key: 'ssh-ed25519 AAAA' }));
      else if (mode === 'wrong-version-ready') ws.send(JSON.stringify({ type: 'ready', v: 2 }));
      else ws.send(JSON.stringify({ type: 'ready', v: 1 }));
      if (mode === 'text-after-ready') {
        ws.send('a control frame');
        kill(4400);
        return;
      }
      pipeUpstream();
    });

    ws.on('error', () => undefined);
    void url;
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as net.AddressInfo;
      resolve({
        serverUrl: `ws://127.0.0.1:${addr.port}`,
        records,
        close: () =>
          new Promise<void>((done) => {
            wss.close();
            httpServer.close(() => done());
          }),
      });
    });
  });
}

/** The typed admission the fixture's sentinel token rides — the same shape
 * the shipping mint produces. */
export function sentinelAdmission(): { credential: 'pocketshell-scoped-proxy-admission-v1'; token: string; expiresAtMs: number } {
  return { credential: 'pocketshell-scoped-proxy-admission-v1', token: SCOPED_TOKEN_SENTINEL, expiresAtMs: Date.now() + 300_000 };
}
