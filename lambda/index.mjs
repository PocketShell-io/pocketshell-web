/**
 * pocketshell-web terminal bridge.
 *
 * The browser cannot speak SSH, so it opens a WebSocket here and this
 * Lambda holds the matching ssh2 connection, shuttling bytes both ways.
 * Sessions live in warm-execution-environment state keyed by the API
 * Gateway connectionId — one user, sequential frames, so the same warm
 * environment serves a connection in practice. If a frame ever lands on a
 * cold environment (state miss) the client gets `session_lost` and
 * transparently reconnects the shell.
 *
 * Auth: the browser appends `?token=<Google ID token>` on connect. There is
 * no native JWT authorizer for WebSocket APIs, so $connect verifies it
 * directly against Google's JWKS (signature, iss, aud, exp) plus the same
 * email allowlist the sync API enforces. A connection is authorized once at
 * connect time; API Gateway caps WebSocket connections at 2 hours anyway.
 *
 * Secrets (private keys / passwords for the TARGET host) travel only
 * inside the `connect` frame over WSS and stay in the session object in
 * memory. They are never logged and never persisted — this Lambda has no
 * table.
 *
 * Frame protocol (JSON both ways):
 *   client -> {type:'connect', host, port, username,
 *              auth:{kind:'key', privateKey, passphrase?}|{kind:'password', password},
 *              cols, rows}
 *             {type:'data', data}          // raw keystrokes
 *             {type:'resize', cols, rows}
 *             {type:'ping'}
 *   server -> {type:'connected'} | {type:'data', data /*b64*\/} |
 *             {type:'exit'} | {type:'pong'} |
 *             {type:'error', message} | {type:'session_lost'}
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { Client as SshClient } from 'ssh2';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';

const { GOOGLE_CLIENT_IDS, ALLOWED_EMAILS, GOOGLE_ISSUER } = process.env;
const ACCEPTED_AUDIENCES = (GOOGLE_CLIENT_IDS || '').split(',').filter(Boolean);
const ALLOWLIST = new Set((ALLOWED_EMAILS || '').split(',').filter(Boolean));
const ISSUER = GOOGLE_ISSUER || 'https://accounts.google.com';

const IDLE_MS = 10 * 60 * 1000; // API Gateway kills sockets at 10 min idle
const MAX_AGE_MS = 110 * 60 * 1000; // API Gateway hard-caps connections at 2 h
const FLUSH_MS = 25;
const POST_CHUNK = 28 * 1024; // postToConnection frames cap at 32 KB

/** connectionId -> session; warm-state only, rebuilt from nothing on cold start. */
const sessions = new Map();

let jwksCache = { fetchedAt: 0, keys: [] };

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > IDLE_MS || now - s.createdAt > MAX_AGE_MS) {
      console.log(JSON.stringify({ msg: 'session expired', connectionId: id }));
      destroySession(s, 'idle timeout');
    }
  }
}, 60 * 1000);
sweep.unref?.();

export const handler = async (event) => {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;

  if (routeKey === '$connect') return await handleConnect(event, connectionId);
  if (routeKey === '$disconnect') {
    const s = sessions.get(connectionId);
    if (s) destroySession(s, 'client disconnect');
    return { statusCode: 200 };
  }

  const gateway = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  // $default carries every data frame.
  let frame;
  try {
    frame = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400 };
  }

  const s = sessions.get(connectionId);
  if (!s) {
    // The only legitimate first frame on a live socket.
    if (frame.type === 'ping') {
      await post(gateway, connectionId, { type: 'pong' });
      return { statusCode: 200 };
    }
    await post(gateway, connectionId, { type: 'session_lost' }).catch(() => {});
    return { statusCode: 200 };
  }

  s.lastActivity = Date.now();
  try {
    switch (frame.type) {
      case 'connect':
        await startSession(s, gateway, frame);
        break;
      case 'data':
        if (s.stream) await s.chain(() => new Promise((res, rej) =>
          s.stream.write(String(frame.data ?? ''), (err) => (err ? rej(err) : res()))));
        break;
      case 'resize':
        if (s.stream) s.stream.rows = frame.rows;
        if (s.stream) s.stream.cols = frame.cols;
        if (s.ssh) await s.chain(() => new Promise((res, rej) =>
          s.ssh.setWindow(frame.rows, frame.cols, (err) => (err ? rej(err) : res()))));
        break;
      case 'ping':
        await post(gateway, connectionId, { type: 'pong' });
        break;
      default:
        await post(gateway, connectionId, { type: 'error', message: `unknown frame ${frame.type}` });
    }
  } catch (err) {
    console.log(JSON.stringify({ msg: 'frame failed', connectionId, err: String(err) }));
    await post(gateway, connectionId, { type: 'error', message: 'frame failed' }).catch(() => {});
  }
  return { statusCode: 200 };
};

// ---- $connect: verify the Google ID token -------------------------------

async function handleConnect(event, connectionId) {
  const idToken = (event.queryStringParameters || {}).token;
  const ok = await verifyIdToken(idToken);
  if (!ok) {
    console.log(JSON.stringify({ msg: 'connect rejected', connectionId }));
    return { statusCode: 401, body: 'unauthorized' };
  }
  sessions.set(connectionId, {
    connectionId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    ssh: null,
    stream: null,
    buffer: [],
    bufferedBytes: 0,
    chain: serialize(),
  });
  return { statusCode: 200 };
}

async function verifyIdToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch {
    return false;
  }
  if (header.alg !== 'RS256' || !header.kid) return false;
  if (!ACCEPTED_AUDIENCES.includes(payload.aud)) return false;
  if (payload.iss !== ISSUER && payload.iss !== 'accounts.google.com') return false;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return false;
  if (!ALLOWLIST.has(payload.email) || payload.email_verified !== true) return false;

  const jwk = await lookupKey(header.kid);
  if (!jwk) return false;
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  return cryptoVerify('RSA-SHA256', data, key, sig);
}

async function lookupKey(kid) {
  if (Date.now() - jwksCache.fetchedAt > 3600 * 1000 || !jwksCache.keys.some((k) => k.kid === kid)) {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
    jwksCache = { fetchedAt: Date.now(), keys: await res.json().then((j) => j.keys) };
  }
  return jwksCache.keys.find((k) => k.kid === kid) || null;
}

// ---- SSH session ---------------------------------------------------------

async function startSession(s, gateway, frame) {
  if (s.ssh) destroySession(s, 'reconnect'); // stale shell under the same socket

  const auth = frame.auth || {};
  const options = {
    host: String(frame.host),
    port: Number(frame.port) || 22,
    username: String(frame.username || ''),
    readyTimeout: 20_000,
    keepaliveInterval: 30_000,
    keepaliveCountMax: 3,
  };
  if (auth.kind === 'password') {
    options.password = String(auth.password || '');
  } else if (auth.kind === 'key') {
    options.privateKey = String(auth.privateKey || '');
    if (auth.passphrase) options.passphrase = String(auth.passphrase);
  } else {
    throw new Error('auth.kind must be key or password');
  }

  const ssh = new SshClient();
  s.ssh = ssh;

  await new Promise((resolve, reject) => {
    const fail = (err) => { console.log(JSON.stringify({ msg: 'ssh failed', connectionId: s.connectionId, err: String(err) })); reject(new Error('ssh connect failed')); };
    ssh.once('ready', resolve);
    ssh.once('error', fail);
    ssh.connect(options);
  }).catch(async (err) => {
    ssh.end();
    s.ssh = null;
    await post(gateway, s.connectionId, { type: 'error', message: err.message }).catch(() => {});
    return err;
  }).then(async (err) => {
    if (err) return;
    ssh.shell({ cols: frame.cols || 80, rows: frame.rows || 24, term: frame.term || 'xterm-256color' }, (shellErr, stream) => {
      if (shellErr) {
        console.log(JSON.stringify({ msg: 'shell failed', connectionId: s.connectionId, err: String(shellErr) }));
        post(gateway, s.connectionId, { type: 'error', message: 'shell failed' }).catch(() => {});
        ssh.end();
        s.ssh = null;
        return;
      }
      s.stream = stream;
      s.sink = gateway;
      stream.on('data', (chunk) => enqueueOutput(s, chunk));
      stream.stderr?.on('data', (chunk) => enqueueOutput(s, chunk));
      stream.on('close', () => {
        post(gateway, s.connectionId, { type: 'exit' }).catch(() => {});
        s.stream = null;
      });
      post(gateway, s.connectionId, { type: 'connected' }).catch(() => {});
    });
  });
}

function enqueueOutput(s, chunk) {
  s.buffer.push(chunk);
  s.bufferedBytes += chunk.length;
  if (s.flushTimer) return;
  s.flushTimer = setTimeout(() => void flushOutput(s), FLUSH_MS);
}

async function flushOutput(s) {
  s.flushTimer = null;
  if (!s.sink || s.buffer.length === 0) return;
  const blob = Buffer.concat(s.buffer);
  s.buffer = [];
  s.bufferedBytes = 0;
  for (let off = 0; off < blob.length; off += POST_CHUNK) {
    const slice = blob.subarray(off, Math.min(off + POST_CHUNK, blob.length));
    try {
      await s.chain(() => post(s.sink, s.connectionId, { type: 'data', data: slice.toString('base64') }));
    } catch (err) {
      if (err instanceof GoneException) {
        destroySession(s, 'socket gone');
        return;
      }
      console.log(JSON.stringify({ msg: 'post failed', connectionId: s.connectionId, err: String(err) }));
      return;
    }
  }
}

function destroySession(s, why) {
  console.log(JSON.stringify({ msg: 'destroy', connectionId: s.connectionId, why }));
  sessions.delete(s.connectionId);
  if (s.flushTimer) clearTimeout(s.flushTimer);
  s.sink = null;
  try { s.stream?.end(); } catch {}
  try { s.ssh?.end(); } catch {}
  s.stream = null;
  s.ssh = null;
}

// ---- plumbing -------------------------------------------------------------

/** One-at-a-time execution so interleaved frames keep their order. */
function serialize() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
  };
}

async function post(gateway, connectionId, message) {
  await gateway.send(new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: Buffer.from(JSON.stringify(message)),
  }));
}
