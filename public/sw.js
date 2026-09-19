/*
 * The /fwd/ shuttle — the browser-only port forwarder's service worker.
 *
 * Scope note: this worker is deliberately ROOT-scoped even though it only
 * ever answers /fwd/ URLs. A /fwd/-scoped worker could not be postMessaged
 * from the app tab (pages at / are not under its scope), and the app tab is
 * the side that owns the SSH connections. Everything not under /fwd/ falls
 * through untouched: the handler simply does not respondWith for it.
 *
 * No HTTP is parsed here. Each intercepted request is offered, over a
 * MessagePort, to whichever app tab said hello last; that tab resolves the
 * host alias, runs the exchange through an SSH direct-tcpip channel, and
 * returns a complete response. All crypto and all plaintext stay in the app.
 */

const CLIENT_TIMEOUT_MS = 60_000;

let appPort = null;
let seq = 0;
/** id -> resolve, one per in-flight forwarded request. */
const pending = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'fwd-hello' || !e.ports[0]) return;
  appPort = e.ports[0];
  appPort.onmessage = (ev) => {
    const msg = ev.data;
    const settle = msg && Number.isInteger(msg.id) ? pending.get(msg.id) : null;
    if (settle) {
      pending.delete(msg.id);
      settle(responseFromMsg(msg));
    }
  };
});

/** The app tab answers with {status, statusText, headers, body}; that is a
 * plain object, and respondWith needs a real Response. */
function responseFromMsg(msg) {
  if (!msg || typeof msg.status !== 'number' || msg.status < 200 || msg.status > 599) {
    return statusPage(502, 'The app tab returned no usable answer — reload this page.');
  }
  const headers = new Headers();
  for (const pair of msg.headers || []) {
    try {
      headers.append(pair[0], pair[1]);
    } catch {
      // a header the browser refuses to synthesize; skip it
    }
  }
  return new Response(msg.body ?? null, { status: msg.status, statusText: msg.statusText || '', headers });
}

async function nudgeClients() {
  const list = await self.clients.matchAll({ type: 'window' });
  for (const c of list) c.postMessage({ type: 'fwd-need-port' });
}

function statusPage(status, message) {
  const doc =
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>PocketShell forward</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;' +
    'color:#c9d1d9;font:15px/1.6 system-ui,sans-serif">' +
    '<p style="max-width:34em;padding:0 1.5em">' +
    String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]) +
    '</p></body>';
  return new Response(doc, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function shuttle(request) {
  if (appPort === null) {
    // Maybe a tab is open but its port died with an earlier worker; ask it
    // to re-hello (this very request still answers with guidance).
    await nudgeClients();
    return statusPage(
      503,
      'No PocketShell tab is connected yet. Open app.pocketshell.io in another tab, sign in, unlock, and reload this page — it is served through your own SSH connection.',
    );
  }
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
  const headers = [];
  request.headers.forEach((value, name) => headers.push([name, value]));
  const id = ++seq;
  const reply = new Promise((resolve) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.delete(id)) {
        resolve(statusPage(504, 'The forwarded request timed out — the app tab or the SSH connection may be gone.'));
      }
    }, CLIENT_TIMEOUT_MS);
  });
  appPort.postMessage({ id, method: request.method, url: request.url, headers, body }, body ? [body] : []);
  return reply;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (!url.pathname.startsWith('/fwd/')) return; // app traffic passes untouched
  e.respondWith(shuttle(e.request).catch(() => statusPage(502, 'The forward shuttle failed — reload the page.')));
});
