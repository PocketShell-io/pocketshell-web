/**
 * One SSH connection per host carrying many short-lived `direct-tcpip`
 * channels — SSH's own local-forwarding primitive, pointed at the host
 * itself. The transport is the sessions workspace's: the browser speaks SSH
 * through the dumb relay, so forwarded traffic crosses it as ciphertext and
 * the relay has nothing to read.
 *
 * The worker-facing contract is one method: `exchange` sends one serialized
 * request over a fresh channel and resolves with the whole response.
 */
import { Client as SSHClient } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { connectWebSocketDuplex } from '../terminal/wsduplex';
import { HttpResponseParser, serializeRequest, type BuiltRequest, type ParsedResponse } from './forwardHttp';

const CONNECT_TIMEOUT_MS = 20_000;
const EXCHANGE_TIMEOUT_MS = 45_000;

/** Everything needed to dial one host through the relay. Fetched fresh on
 * every (re)connect so a rotated Google ID token is picked up. */
export interface ForwardDialSpec {
  hostname: string;
  /** The SSH port — the relay dials this; the forwarded port is per-request. */
  port: number;
  user: string;
  privateKey: string;
  passphrase?: string;
  relayUrl: string;
  idToken: string;
}

export class HostChannel {
  private conn: SSHClient | null = null;
  private connecting: Promise<SSHClient> | null = null;

  constructor(private readonly specOf: () => ForwardDialSpec) {}

  get open(): boolean {
    return this.conn !== null;
  }

  close(): void {
    const c = this.conn;
    this.conn = null;
    this.connecting = null;
    try {
      c?.end();
    } catch {
      // the relay may already be gone; nothing to salvage
    }
  }

  private async client(): Promise<SSHClient> {
    if (this.conn !== null) return this.conn;
    if (this.connecting !== null) return this.connecting;
    this.connecting = this.dial().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async dial(): Promise<SSHClient> {
    const spec = this.specOf();
    const query = new URLSearchParams({
      host: spec.hostname,
      port: String(spec.port),
      token: spec.idToken,
    });
    const sock = await connectWebSocketDuplex(`${spec.relayUrl}?${query.toString()}`);
    const conn = new SSHClient();
    try {
      await new Promise<void>((resolve, reject) => {
        conn.on('ready', () => resolve());
        conn.on('error', (e: Error) => reject(e));
        conn.on('close', () => reject(new Error('connection closed during SSH handshake')));
        conn.connect({
          sock,
          username: spec.user,
          privateKey: spec.privateKey,
          ...(spec.passphrase ? { passphrase: spec.passphrase } : {}),
          tryKeyboard: false,
          readyTimeout: CONNECT_TIMEOUT_MS,
          keepaliveInterval: 30_000,
          hostHash: 'sha256',
          hostVerifier: () => true,
          // Same cipher/kex set the terminal sessions negotiate — the
          // browser polyfill speaks these and every OpenSSH server offers them.
          algorithms: {
            kex: ['ecdh-sha2-nistp256', 'diffie-hellman-group14-sha256'],
            cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
            serverHostKey: ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
          },
        });
      });
    } catch (e) {
      try {
        sock.destroy();
      } catch {
        // the relay may already be gone
      }
      try {
        conn.end();
      } catch {
        // nothing to end
      }
      throw e;
    }
    conn.on('close', () => {
      if (this.conn === conn) this.conn = null;
    });
    conn.on('error', () => {
      if (this.conn === conn) {
        this.conn = null;
        try {
          conn.end();
        } catch {
          // already dying
        }
      }
    });
    this.conn = conn;
    return conn;
  }

  /** One request–response exchange over a fresh direct-tcpip channel to
   * destPort on the SSH server's side. Never leaves a channel open. */
  async exchange(destPort: number, request: BuiltRequest, opts: { headOnly?: boolean } = {}): Promise<ParsedResponse> {
    const conn = await this.client();
    const spec = this.specOf();
    const bytes = serializeRequest(request);
    return await new Promise<ParsedResponse>((resolve, reject) => {
      let settled = false;
      let channel: ClientChannel | null = null;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          channel?.end();
        } catch {
          // ending an already-closed channel
        }
        fn();
      };
      const timer = setTimeout(() => settle(() => reject(new Error('forwarded request timed out'))), EXCHANGE_TIMEOUT_MS);
      conn.forwardOut('127.0.0.1', 0, spec.hostname, destPort, (err, ch) => {
        if (err) {
          settle(() => reject(new Error(err.message)));
          return;
        }
        channel = ch;
        const parser = new HttpResponseParser(opts.headOnly === true);
        ch.on('data', (chunk: Buffer) => {
          try {
            const out = parser.push(chunk);
            if (out !== null) settle(() => resolve(out));
          } catch (e) {
            settle(() => reject(e instanceof Error ? e : new Error(String(e))));
          }
        });
        ch.on('close', () => {
          const out = parser.finish();
          settle(() => (out !== null ? resolve(out) : reject(new Error('connection closed mid-response'))));
        });
        ch.on('error', (e: Error) => settle(() => reject(e)));
        ch.write(bytes);
      });
    });
  }
}
