import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { connect as tcpConnect, type AddressInfo, type Socket } from 'node:net';
import { createPinia, setActivePinia } from 'pinia';
import { generateKeyPairSync } from 'node:crypto';
import { Server as SshServer, utils as ssh2utils } from 'ssh2';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { HostEntry } from '@pocketshell/core';
import { config } from '../src/config';
import { useAuthStore } from '../src/stores/auth';
import { useHostPinsStore } from '../src/stores/hostPins';
import { useHostsStore } from '../src/stores/hosts';
import { webApi } from '../src/platform/webApi';
import { SshConnection, verifyGatewayHostKey } from '../src/terminal/connection';
import { sha256Fingerprint } from '../src/terminal/hostKeyFingerprint';

vi.mock('../src/api/sync', () => ({
  SyncConflictError: class SyncConflictError extends Error {},
  makeSyncService: () => {
    throw new Error('sync is not used by the gateway lab');
  },
}));

vi.hoisted(() => {
  const memoryStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => void map.clear(),
    };
  };
  const g = globalThis as Record<string, unknown>;
  g['window'] ??= { POCKETSHELL_WEB: {} };
  g['localStorage'] ??= memoryStorage();
  g['sessionStorage'] ??= memoryStorage();
});

/**
 * The gateway lab: a REAL ssh2 server (the host), and a fake gateway that
 * speaks the v1 client contract (auth TEXT frame → ready → opaque binary
 * pipe). The browser's SshConnection runs its actual ssh2 engine through it
 * — so a matching pin connects and execs end-to-end, a wrong pin is refused
 * before ANY SSH authentication happens, and the gateway demonstrably never
 * sees the private key or a token in a URL.
 */

const ID_TOKEN = 'id-token-abc';

const hostKp = ssh2utils.generateKeyPairSync('ed25519');
const clientKp = ssh2utils.generateKeyPairSync('ed25519');
/** An IMPOSTOR host key — what a lying gateway would like the pin to be. */
const impostorKp = ssh2utils.generateKeyPairSync('ed25519');
const parsedHost = Array.isArray(ssh2utils.parseKey(hostKp.private))
  ? ssh2utils.parseKey(hostKp.private)[0]!
  : ssh2utils.parseKey(hostKp.private)!;
const parsedImpostor = Array.isArray(ssh2utils.parseKey(impostorKp.private))
  ? ssh2utils.parseKey(impostorKp.private)[0]!
  : ssh2utils.parseKey(impostorKp.private)!;
const hostBlob: Buffer = parsedHost.getPublicSSH() as Buffer;
const hostKeyLine = `${parsedHost.type} ${hostBlob.toString('base64')}`;
const impostorBlob: Buffer = parsedImpostor.getPublicSSH() as Buffer;
const impostorKeyLine = `${parsedImpostor.type} ${impostorBlob.toString('base64')}`;

/** SHA256:<unpadded>, the same display form the browser computes. */
function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}
const HOST_FP = fingerprintOf(hostBlob);

class FakeGateway {
  readonly wss: WebSocketServer;
  readonly httpServer = http.createServer();
  readonly sshd: SshServer;
  sshPort = 0;
  httpPort = 0;

  /** Custody records — what the gateway ACTUALLY saw. */
  connections = 0;
  upgradeUrls: string[] = [];
  authFrames: Record<string, unknown>[] = [];
  textFrames: string[] = [];
  binaryChunks: Buffer[] = [];
  sshAuthAttempts = 0;

  /** What the ready frame CLAIMS the host key is — advisory metadata a
   * hostile gateway controls. Tests flip this to prove the client never
   * trusts it. Defaults to the lab host's true line. */
  readyKeyLine = hostKeyLine;

  private pipes: Set<Socket> = new Set();

  constructor() {
    this.sshd = new SshServer({ hostKeys: [hostKp.private] });
    this.sshd.on('connection', (client) => {
      client.on('error', () => {}); // a refused KEX tears down loudly; the lab records attempts, not errors
      client.on('authentication', (ctx) => {
        this.sshAuthAttempts += 1;
        ctx.accept();
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (accept2) => {
            const stream = accept2();
            stream.write('gateway-lab exec ok\n');
            stream.exit(0);
            stream.end();
          });
          session.on('shell', (accept2) => {
            const stream = accept2();
            stream.write('gateway-lab shell ok\n');
            stream.exit(0);
            stream.end();
          });
        });
      });
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws: WsSocket, req) => {
      this.connections += 1;
      this.upgradeUrls.push(req.url ?? '');
      let sawAuth = false;
      let pipe: Socket | null = null;
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary && !sawAuth) {
          sawAuth = true;
          this.authFrames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
          // The real gateway answers ready only after the host ACKs; the lab
          // dials its sshd right here, then hands the pipe over.
          pipe = tcpConnect(this.sshPort, '127.0.0.1');
          this.pipes.add(pipe);
          pipe.on('data', (d: Buffer) => {
            if (ws.readyState === ws.OPEN) ws.send(d); // binary frames to the browser
          });
          pipe.on('error', () => ws.close());
          ws.send(JSON.stringify({ type: 'ready', v: 1, device_id: 'dev-01', ssh_host_key: this.readyKeyLine }));
          return;
        }
        if (!isBinary) {
          this.textFrames.push(data.toString('utf8')); // protocol violation after handshake
          ws.close();
          return;
        }
        this.binaryChunks.push(Buffer.from(data));
        pipe?.write(data);
      });
      ws.on('close', () => {
        pipe?.destroy();
        if (pipe) this.pipes.delete(pipe);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.sshd.listen(0, '127.0.0.1', resolve));
    this.sshPort = (this.sshd.address() as AddressInfo).port;
    await new Promise<void>((resolve) => this.httpServer.listen(0, '127.0.0.1', resolve));
    this.httpPort = (this.httpServer.address() as AddressInfo).port;
  }

  stop(): void {
    for (const pipe of this.pipes) pipe.destroy();
    this.wss.close();
    this.httpServer.close();
    this.sshd.close(() => {});
  }

  get serverUrl(): string {
    return `ws://127.0.0.1:${this.httpPort}`;
  }

  /** Every byte the gateway relayed, for custody assertions. */
  allRelayedText(): string {
    return this.binaryChunks.map((c) => c.toString('latin1')).join('\u0000');
  }
}

let gw: FakeGateway;

beforeAll(async () => {
  gw = new FakeGateway();
  await gw.start();
});

afterAll(() => {
  gw.stop();
});

function gatewayConnect(overrides: {
  pinnedFingerprint?: string;
  auth?: { kind: 'key'; privateKey: string; passphrase?: string } | { kind: 'password'; password: string };
  /** What rides the gateway auth frame. The web app mints this via
   * getGatewayToken — it is NOT the Google sign-in. */
  idToken?: string;
} = {}): Promise<SshConnection> {
  const conn = new SshConnection();
  return conn
    .connect({
      url: '',
      idToken: overrides.idToken ?? ID_TOKEN,
      host: 'label-host',
      port: 22,
      user: 'tester',
      auth: overrides.auth ?? { kind: 'key', privateKey: clientKp.private },
      gateway: {
        serverUrl: gw.serverUrl,
        deviceId: 'dev-01',
        pinnedFingerprint: overrides.pinnedFingerprint ?? HOST_FP,
        allowInsecureWs: true,
      },
    })
    .then(() => conn);
}

describe('the gateway connection over a real ssh2 host', () => {
  it('a paired fingerprint connects, authenticates with the key, and execs end-to-end', async () => {
    const conn = await gatewayConnect();
    try {
      const outcome = await conn.exec('a snapshot');
      expect(outcome.error).toBeNull();
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('gateway-lab exec ok');
    } finally {
      conn.close();
    }

    // Routing custody: the token rode the auth FRAME, never the URL.
    expect(gw.upgradeUrls.every((u) => !u.includes('token') && !u.includes(ID_TOKEN))).toBe(true);
    expect(gw.authFrames).toEqual([{ type: 'auth', v: 1, token: ID_TOKEN, device_id: 'dev-01' }]);
    // And the SSH session really did reach the real sshd.
    expect(gw.sshAuthAttempts).toBeGreaterThanOrEqual(1);
  });

  it('the gateway never sees the private key — not in frames, not in the auth frame', async () => {
    const marker = 'OPENSSH PRIVATE KEY';
    expect(gw.upgradeUrls.join(' ')).not.toContain(marker);
    expect(JSON.stringify(gw.authFrames)).not.toContain(marker);
    expect(gw.allRelayedText()).not.toContain(marker);
    // The key is not on the wire as its base64 body either.
    const keyBody = clientKp.private.split('\n').slice(1, -2).join('');
    expect(gw.allRelayedText()).not.toContain(keyBody.slice(0, 40));
  });

  it('an unpaired device refuses BEFORE any dial — the gateway sees no connection', async () => {
    const connectionsBefore = gw.connections;
    const authBefore = gw.sshAuthAttempts;
    await expect(gatewayConnect({ pinnedFingerprint: '' })).rejects.toThrow(/no verified key fingerprint/);
    expect(gw.connections).toBe(connectionsBefore);
    expect(gw.sshAuthAttempts).toBe(authBefore);
  });

  it('a mismatched pin refuses BEFORE SSH authentication — no key material offered', async () => {
    const authBefore = gw.sshAuthAttempts;
    const wrongPin = fingerprintOf(Buffer.alloc(32, 7));
    await expect(gatewayConnect({ pinnedFingerprint: wrongPin })).rejects.toThrow(/Host key mismatch/);
    // The ssh2 handshake died in key exchange: the host never saw a login.
    expect(gw.sshAuthAttempts).toBe(authBefore);
  });

  it('password auth has no place on the gateway transport — refused before any dial', async () => {
    const connectionsBefore = gw.connections;
    await expect(
      gatewayConnect({ auth: { kind: 'password', password: 'hunter2' } }),
    ).rejects.toThrow(/authenticate with your SSH key/);
    expect(gw.connections).toBe(connectionsBefore);
  });

  it('after the handshake the transport carries binary only — a control frame would be a violation', async () => {
    // The lab asserted this live on every message it received; the happy
    // path above produced zero text frames after auth.
    expect(gw.textFrames).toEqual([]);
  });

  it('the auth frame carries the BROKER token — the original Google sign-in never reaches the gateway', async () => {
    // The web app mints this via getGatewayToken (src/api/gatewayToken.ts);
    // here it is simply a token DIFFERENT from the Google sign-in, which is
    // the property the custody rule needs.
    const brokerToken = 'broker-minted-gateway-jwt.payload.signature';
    const googleToken = 'original-google-signin-token.never-for-the-gateway';
    const conn = await gatewayConnect({ idToken: brokerToken });
    try {
      // Consume one exec so the session is real, not just handshaken.
      const outcome = await conn.exec('a warnings');
      expect(outcome.error).toBeNull();
    } finally {
      conn.close();
    }
    // NEITHER token may ride a URL.
    for (const url of gw.upgradeUrls) {
      expect(url).not.toContain(brokerToken);
      expect(url).not.toContain(googleToken);
    }
    // The auth frame carried the BROKER token, exactly once, and the Google
    // token appears nowhere in anything the gateway received.
    expect(gw.authFrames.at(-1)).toEqual({ type: 'auth', v: 1, token: brokerToken, device_id: 'dev-01' });
    expect(JSON.stringify(gw.authFrames)).not.toContain(googleToken);
    expect(gw.textFrames.every((t) => !t.includes(googleToken))).toBe(true);
  });
});

describe('verifyGatewayHostKey (the verifier body)', () => {
  it('trusts the paired key, computed the way the pairing flow stored it', async () => {
    const presented = await sha256Fingerprint(new Uint8Array(hostBlob));
    await expect(verifyGatewayHostKey(HOST_FP, new Uint8Array(hostBlob))).resolves.toEqual({ ok: true });
    expect(presented).toBe(HOST_FP);
  });

  it('refuses a different key with the pairing remedy in the reason', async () => {
    const other = await sha256Fingerprint(new Uint8Array(Buffer.alloc(32, 9)));
    const result = await verifyGatewayHostKey(HOST_FP, new Uint8Array(Buffer.alloc(32, 9)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/mismatch/i);
      expect(result.reason).toContain(other.slice(0, 7));
    }
  });

  it('refuses an unpaired host — no TOFU arm exists', async () => {
    for (const pin of [undefined, null, '', 'not a fingerprint']) {
      const result = await verifyGatewayHostKey(pin as string | null | undefined, new Uint8Array(hostBlob));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/pair/i);
    }
  });
});

describe('key custody at the browser signing boundary', () => {
  it('an ECDSA key refuses at the connect gate — no socket, no signature attempt', async () => {
    // SEC1 is the form ECDSA keys actually take here (ssh2 re-serializes to
    // it; its parser accepts no other EC container). The classifier must
    // call it refused BEFORE any socket exists.
    const { privateKey: ecdsaPem } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(ecdsaPem).toContain('BEGIN EC PRIVATE KEY');
    const connectionsBefore = gw.connections;
    const authBefore = gw.sshAuthAttempts;
    await expect(gatewayConnect({ auth: { kind: 'key', privateKey: ecdsaPem } })).rejects.toThrow(
      /can't sign from the browser/i,
    );
    // The gate sits before the dial: the gateway saw no WebSocket at all.
    expect(gw.connections).toBe(connectionsBefore);
    expect(gw.sshAuthAttempts).toBe(authBefore);
  });

  it('an encrypted RSA key is INDETERMINATE, not refused — ssh2 decrypts it and the dial succeeds', async () => {
    const { privateKey: encryptedRsaPem } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'lab-pass' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(encryptedRsaPem).toContain('ENCRYPTED');
    const conn = await gatewayConnect({
      auth: { kind: 'key', privateKey: encryptedRsaPem, passphrase: 'lab-pass' },
    });
    try {
      const outcome = await conn.exec('a snapshot');
      expect(outcome.error).toBeNull();
      expect(outcome.stdout).toContain('gateway-lab exec ok');
    } finally {
      conn.close();
    }
    expect(gw.sshAuthAttempts).toBeGreaterThanOrEqual(1);
  });

  it('a ready frame LYING about the host key buys nothing: the pin wins, zero SSH auth', async () => {
    // Pair the fingerprint the gateway's ready metadata CLAIMS — the
    // impostor line — while the lab sshd presents its real key. The verdict
    // must come from the independently paired pin vs the PRESENTED key,
    // never from ready.ssh_host_key.
    const impostorFp = fingerprintOf(impostorBlob);
    gw.readyKeyLine = impostorKeyLine;
    const authBefore = gw.sshAuthAttempts;
    try {
      await expect(gatewayConnect({ pinnedFingerprint: impostorFp })).rejects.toThrow(
        /Host key mismatch/,
      );
      expect(gw.sshAuthAttempts).toBe(authBefore);
    } finally {
      gw.readyKeyLine = hostKeyLine;
    }
  });
});

describe('webApiExchangesGoogleAndSendsOnlyScopedToken — the full web dial path', () => {
  const GOOGLE_TOKEN = 'google-signin-original.never-for-gateways.sentinel';
  const BROKER_SENTINEL = 'broker-minted.scoped-routing.jwt';
  const SYNC_BASE = 'https://accounts.example';
  const brokerCalls: { url: string; init: RequestInit }[] = [];
  let realFetch: typeof fetch;

  function brokerResponse(): Response {
    return new Response(
      JSON.stringify({
        token: BROKER_SENTINEL,
        token_type: 'Bearer',
        expires_in: 300,
        expires_at: Math.floor(Date.now() / 1000) + 300,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  beforeAll(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      brokerCalls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(brokerResponse());
    }) as typeof fetch;
    config.syncApiBase = SYNC_BASE;
    config.gatewayAllowInsecureWs = true;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    config.gatewayAllowInsecureWs = false;
  });

  it('the browser exchanges the Google sign-in at the trusted broker and the gateway auth frame carries ONLY the scoped token', async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    const auth = useAuthStore();
    auth.idToken = GOOGLE_TOKEN;
    const hosts = useHostsStore();
    hosts.pulled = true;
    hosts.passphrase = 'sync-pass';
    const labEntry: HostEntry = {
      name: 'gw-lab',
      hostname: 'gw-lab.example',
      port: 22,
      user: 'tester',
      identityFile: null,
      proxyJump: null,
      forwardAgent: false,
      localForwards: [],
      remoteForwards: [],
      fromConfig: false,
      gateway: { serverUrl: gw.serverUrl, deviceId: 'dev-01' },
    };
    hosts.hosts = [labEntry];
    hosts.secrets = { 'gw-lab': { privateKeyPem: clientKp.private } };
    hosts.secretHosts = ['gw-lab'];
    await useHostPinsStore().setGatewayPin('dev-01', HOST_FP);

    const result = await webApi.ssh.connect({ host: 'gw-lab.example', port: 22, user: 'tester' });
    expect(result.ok).toBe(true);
    try {
      if (!result.ok) return;
      const outcome = await webApi.ssh.exec(result.connectionId, 'a snapshot');
      expect(outcome.exitCode).toBe(0);
    } finally {
      if (result.ok) await webApi.ssh.close(result.connectionId);
    }

    // The EXCHANGE: one POST to the independently trusted account service,
    // empty body (broker contract), Google token ONLY in the Authorization
    // header, redirect refusal armed, no key material anywhere in the request.
    expect(brokerCalls).toHaveLength(1);
    const call = brokerCalls[0]!;
    expect(call.url).toBe(`${SYNC_BASE}/gateway/token`);
    expect(call.init.method).toBe('POST');
    expect(call.init.body ?? null).toBeNull();
    expect(call.init.redirect).toBe('error');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${GOOGLE_TOKEN}`);
    expect(JSON.stringify(call.init)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(call.init)).not.toContain(BROKER_SENTINEL);

    // The GATEWAY saw only the scoped token: auth frame exactly once, no
    // Google token in any frame, URL, or relayed byte; no private key either.
    expect(gw.authFrames.at(-1)).toEqual({ type: 'auth', v: 1, token: BROKER_SENTINEL, device_id: 'dev-01' });
    expect(JSON.stringify(gw.authFrames)).not.toContain(GOOGLE_TOKEN);
    for (const url of gw.upgradeUrls) {
      expect(url).not.toContain(GOOGLE_TOKEN);
      expect(url).not.toContain(BROKER_SENTINEL);
    }
    expect(gw.allRelayedText()).not.toContain(GOOGLE_TOKEN);
    const keyBody = clientKp.private.split('\n').slice(1, -2).join('');
    expect(gw.allRelayedText()).not.toContain(keyBody.slice(0, 40));
    // The SSH login really happened, end-to-end, with the real key.
    expect(gw.sshAuthAttempts).toBeGreaterThanOrEqual(1);
  });
});
