import { Client as SSHClient } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { Buffer } from 'node:buffer';
import { connectWebSocketDuplex } from './wsduplex';
import type { TerminalSession, SessionHandlers } from './session';
import type { BridgeAuth, BridgeOpenOptions } from './bridge';

/**
 * Browser-direct SSH: the browser runs the SSH client itself and the relay
 * (relay/ — a dumb WebSocket↔TCP pipe, deployable as a free Cloudflare
 * Worker) only ferries ciphertext toward host:port. The private key never
 * leaves the browser; the relay has nothing to read even in principle.
 *
 * The host, port, and ID token ride the WebSocket URL; the relay verifies
 * the token against Google's JWKS before opening the TCP leg (the same
 * check the Lambda bridge does on $connect).
 */
export class DirectSshSession implements TerminalSession {
  private conn: SSHClient | null = null;
  private stream: ClientChannel | null = null;
  private closedByUs = false;

  constructor(
    private readonly url: string,
    private readonly idToken: string,
    private readonly handlers: SessionHandlers,
  ) {}

  /** Dial the relay, run the SSH handshake through it, start a shell, and
   * resolve once the shell is live — the `connected` equivalent. */
  async open(opts: BridgeOpenOptions): Promise<void> {
    const auth = this.authOf(opts.auth);
    const query = new URLSearchParams({
      host: opts.host,
      port: String(opts.port),
      token: this.idToken,
    });
    const sock = await connectWebSocketDuplex(`${this.url}?${query.toString()}`);
    sock.on('close', () => {
      if (!this.closedByUs) this.handlers.onExit();
    });

    const conn = new SSHClient();
    this.conn = conn;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (!settled) {
          settled = true;
          reject(e);
        } else {
          this.handlers.onError(e.message);
        }
      };

      conn.on('ready', () => {
        conn.shell({ term: opts.term ?? 'xterm-256color', cols: opts.cols ?? 80, rows: opts.rows ?? 24 }, (err, stream) => {
          if (err) return fail(err);
          this.stream = stream;
          stream.on('data', (chunk: Buffer) => this.handlers.onData(new Uint8Array(chunk)));
          stream.on('close', () => {
            this.closedByUs = true;
            this.handlers.onExit();
          });
          settled = true;
          resolve();
        });
      });
      conn.on('error', (e: Error) => fail(e));
      conn.on('close', () => {
        if (!this.closedByUs) this.handlers.onExit();
      });

      conn.connect({
        sock,
        username: opts.user,
        ...auth,
        tryKeyboard: false,
        readyTimeout: 20_000,
        keepaliveInterval: 30_000,
        hostHash: 'sha256',
        hostVerifier: (hex: string) => {
          // Trust-on-first-use comes later; surface the fingerprint for now.
          this.handlers.onStatus?.(`host key ${hex.slice(0, 16)}…`);
          return true;
        },
        // The browser's crypto polyfill speaks the CTR ciphers and
        // ECDH-nistp; every OpenSSH server still offers both.
        algorithms: {
          kex: ['ecdh-sha2-nistp256', 'diffie-hellman-group14-sha256'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
          serverHostKey: ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
        },
      });
    });
  }

  private authOf(auth: BridgeAuth): { privateKey: string; passphrase?: string } | { password: string } {
    if (auth.kind === 'key') {
      if (!auth.privateKey) throw new Error('No private key in this browser for this host');
      const out: { privateKey: string; passphrase?: string } = { privateKey: auth.privateKey };
      if (auth.passphrase) out.passphrase = auth.passphrase;
      return out;
    }
    return { password: auth.password ?? '' };
  }

  sendInput(text: string) {
    this.stream?.write(text);
  }

  resize(cols: number, rows: number) {
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  close() {
    this.closedByUs = true;
    try {
      this.stream?.close();
      this.conn?.end();
    } catch {
      // the relay may already be gone; nothing to salvage
    }
  }
}
