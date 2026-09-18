/**
 * Local dev/test relay: the same dumb WebSocket↔TCP pipe the Cloudflare
 * Worker (`worker.js`) provides in production, minus the token check —
 * run one with:
 *
 *   node relay/dev-relay.mjs [port=8787]
 *
 * The browser speaks SSH end-to-end; whatever crosses here is ciphertext.
 * The target host/port arrive on the query string, chosen by the client.
 */
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.argv[2] ?? 8787);
const server = http.createServer((_req, res) => {
  res.writeHead(426).end('websocket relay — upgrade required');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const host = url.searchParams.get('host');
  const target = Number(url.searchParams.get('port') ?? 22);
  console.log(`relay: connection for ${host}:${target}`);
  if (host === null || host === '' || !Number.isInteger(target) || target < 1 || target > 65535) {
    ws.close(1008, 'bad target');
    return;
  }

  const upstream = net.connect({ host, port: target });
  upstream.setNoDelay(true);
  ws.binaryType = 'nodebuffer';

  ws.on('message', (data) => {
    if (!upstream.destroyed) upstream.write(data);
  });
  upstream.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });

  const bye = () => {
    try {
      upstream.destroy();
    } catch {
      // already gone
    }
    try {
      ws.close();
    } catch {
      // already gone
    }
  };
  ws.on('close', bye);
  ws.on('error', (err) => {
    console.log(`relay: ws error ${err.message}`);
    bye();
  });
  upstream.on('error', (err) => {
    // The SSH client sees a closed transport, which it reports as a
    // handshake failure — no upstream details leak through.
    console.log(`relay: upstream error ${err.message}`);
    ws.close(1011, 'upstream failed');
    bye();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dev relay on ws://127.0.0.1:${port} (dumb pipe; no auth)`);
});
