/**
 * The page side of /fwd/ forwarding, running in every app tab: register the
 * service worker, hand it a MessagePort, and answer each intercepted request
 * by resolving the host alias against the synced list and piping the
 * exchange through a per-host SSH connection. The worker holds no state but
 * the port — every decision (auth, dial target, rewriting) happens here,
 * inside the authenticated app, exactly like the terminal sessions: keys
 * and decrypted traffic never leave the browser.
 */
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';
import { config } from '../config';
import {
  buildRequest,
  filterResponseHeaders,
  headerValue,
  isRewritableHtml,
  rewriteHtml,
  rewriteLocation,
} from './forwardHttp';
import { forwardPrefix, parseForwardPath, type ForwardTarget } from './forwardPath';
import { HostChannel, type ForwardDialSpec } from './forwardConn';

/** One intercepted request, as the service worker relays it. */
interface FwdRequest {
  id: number;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
}

/** One answer back. body rides as bytes; the worker wraps it in a Response. */
interface FwdReply {
  id: number;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array | null;
}

const channels = new Map<string, { sig: string; channel: HostChannel }>();
let started = false;
let port: MessagePort | null = null;

export function startForwarder(): void {
  if (started || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  started = true;
  // The worker is root-scoped (public/sw.js) so the app tab can postMessage
  // it; inside its fetch handler only /fwd/ URLs are intercepted.
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    // Insecure context or storage ban — /fwd/ URLs then just 404 from the
    // server; the terminal keeps working without forwarding.
  });
  wire();
  navigator.serviceWorker.addEventListener('controllerchange', wire);
  navigator.serviceWorker.addEventListener('message', (e) => {
    // The worker restarted and lost our port — it nudges every client.
    if ((e.data as { type?: string } | null)?.type === 'fwd-need-port') {
      port = null;
      wire();
    }
  });
  // Same recovery when no nudge sender exists (worker idle-exiled hard).
  setInterval(() => {
    if (port === null) wire();
  }, 25_000);
}

function wire(): void {
  const sw = navigator.serviceWorker.controller;
  if (sw === null || port !== null) return;
  const mc = new MessageChannel();
  port = mc.port1;
  mc.port1.onmessage = (e: MessageEvent) => {
    void answer(e.data as FwdRequest)
      .then((reply) => mc.port1.postMessage(reply))
      .catch(() => {
        // answer() already degrades to a status page; this is belt-and-braces
      });
  };
  sw.postMessage({ type: 'fwd-hello' }, [mc.port2]);
}

async function answer(msg: FwdRequest): Promise<FwdReply> {
  try {
    const u = new URL(msg.url);
    const target = parseForwardPath(u.pathname);
    if (target === null) {
      return htmlReply(msg.id, 404, 'This URL is not a forwarded address (/fwd/&lt;host&gt;:&lt;port&gt;/…).');
    }
    return await dispatch(msg, target, u.search);
  } catch (err) {
    return htmlReply(msg.id, 502, escapeHtml(err instanceof Error ? err.message : String(err)));
  }
}

async function dispatch(msg: FwdRequest, target: ForwardTarget, search: string): Promise<FwdReply> {
  const hosts = useHostsStore();
  const auth = useAuthStore();
  if (!auth.signedIn) {
    return htmlReply(msg.id, 503, 'Sign in to PocketShell in another tab first — this page is served through your SSH connection.');
  }
  if (config.directWsUrl === '') {
    return htmlReply(msg.id, 503, 'This deployment has no browser-direct relay configured.');
  }
  const entry = hosts.hosts.find((h) => h.name === target.host);
  if (entry === undefined) {
    return htmlReply(msg.id, 404, `No host named “${escapeHtml(target.host)}” in your list.`);
  }
  const secret = hosts.secrets[target.host];
  if (secret?.privateKeyPem === undefined || secret.privateKeyPem === '') {
    return htmlReply(msg.id, 503, 'No key attached for this host yet — open PocketShell → Hosts → Key… and attach one.');
  }
  if (!hosts.unlocked) {
    return htmlReply(msg.id, 503, 'PocketShell is locked in the app tab — unlock it there and reload this page.');
  }

  const sig = [entry.hostname, entry.port, entry.user, secret.privateKeyPem.length, secret.keyPassphrase?.length ?? 0].join('|');
  const existing = channels.get(entry.name);
  if (existing !== undefined && existing.sig !== sig) {
    existing.channel.close();
    channels.delete(entry.name);
  }
  let host = channels.get(entry.name)?.channel;
  if (host === undefined) {
    // specOf re-reads everything at dial time so reconnects pick up a fresh
    // Google token and any host-list edits made since.
    const spec = (): ForwardDialSpec => ({
      hostname: entry.hostname,
      port: entry.port,
      user: entry.user,
      privateKey: secret.privateKeyPem ?? '',
      passphrase: secret.keyPassphrase,
      relayUrl: config.directWsUrl,
      idToken: auth.getIdToken(),
    });
    host = new HostChannel(spec);
    channels.set(entry.name, { sig, channel: host });
  }

  const targetPath = (target.path === '' ? '/' : target.path) + search;
  const request = buildRequest(
    msg.method,
    targetPath,
    entry.hostname,
    target.port,
    msg.headers,
    msg.body === null ? null : new Uint8Array(msg.body),
  );
  const res = await host.exchange(target.port, request, { headOnly: msg.method === 'HEAD' });

  const prefix = forwardPrefix(target.host, target.port);
  const headers = filterResponseHeaders(res.headers).map(([n, v]) => {
    if (n.toLowerCase() === 'location' && res.status >= 300 && res.status < 400) {
      return [n, rewriteLocation(v, prefix, entry.hostname, target.port)] as [string, string];
    }
    return [n, v] as [string, string];
  });
  let body: Uint8Array = res.body;
  if (isRewritableHtml(res)) {
    if ((headerValue(res.headers, 'content-encoding') ?? '') .toLowerCase() === 'gzip') {
      body = await gunzip(body);
      for (let i = 0; i < headers.length; i += 1) {
        if (headers[i][0].toLowerCase() === 'content-encoding') headers.splice(i, 1);
      }
    }
    body = new TextEncoder().encode(rewriteHtml(new TextDecoder().decode(body), prefix));
  }
  return { id: msg.id, status: res.status, statusText: res.statusText, headers, body };
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (DS === undefined) return bytes; // old engine: serve the gzipped bytes as-is
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function htmlReply(id: number, status: number, messageHtml: string): FwdReply {
  const doc =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>PocketShell forward</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#c9d1d9;' +
    'font:15px/1.6 system-ui,sans-serif"><p style="max-width:34em;padding:0 1.5em">' +
    messageHtml +
    '</p></body>';
  return {
    id,
    status,
    statusText: '',
    headers: [['content-type', 'text/html; charset=utf-8']],
    body: new TextEncoder().encode(doc),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
