/**
 * One browser-direct SSH connection that carries MANY channels: the raw
 * terminal per open session tab, plus the on-demand execs (`a snapshot`,
 * `a warnings`, …) the sessions workspace polls — the shape the desktop's
 * SshService offers its renderer, minus the process boundary.
 *
 * The transport is the same as DirectSshSession's: the browser runs the SSH
 * client over a dumb WebSocket relay; the private key never leaves the tab.
 * Nothing here knows about Vue or the UI — the workspace controller drives
 * this class, and DirectSshSession is a one-shell wrapper over it.
 */
import { Client as SSHClient } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { Buffer } from 'node:buffer';
import { connectWebSocketDuplex } from './wsduplex';
import { decodePublicKeyBlob, verifyHostKeyPin, type HostKeyPin } from '../shared/knownHostsCore';
import { sha256Fingerprint } from './hostKeyFingerprint';
import type { BridgeAuth } from './bridge';

/** The desktop's ExecResult shape: exit code when the channel reached it. */
export interface ExecOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set only on transport-level failure (dial died, channel refused, timeout). */
  error: string | null;
}

export interface PtyHandlers {
  onData: (bytes: Uint8Array) => void;
  /** The channel closed — the command exited or the connection died. */
  onExit: () => void;
  onError: (message: string) => void;
}

export interface PtyRequest extends PtyHandlers {
  /** Run this command directly under the PTY (a session join) instead of a
   * login shell: no dotfiles, the first byte of output is the command's. */
  command?: string;
  cols?: number;
  rows?: number;
  term?: string;
}

export interface PtyChannel {
  write(text: string): void;
  resize(rows: number, cols: number): void;
  close(): void;
}

/** What the UI learns about a presented host key — the TOFU prompt's and
 * the mismatch warning's payload. */
export interface HostKeyInfo {
  keyType: string;
  /** SHA256:<base64>, the OpenSSH display format. */
  fingerprint: string;
}

/** The TOFU decision the OpenSSH prompt offers. */
export type TofuDecision = 'always' | 'once' | 'reject';

/**
 * Host-key pinning for one connection — the browser twin of the desktop's
 * `KnownHosts` + `tofuDecision` wiring in SshService: classify the presented
 * key against stored pins, persist on accept-always, hard-block on change.
 * Absent = keys are accepted (bridge-mode behaviour).
 */
export interface KnownHostsHooks {
  /** The pin stored for this host, if any. */
  lookup(host: string, port: number): Promise<HostKeyPin | undefined>;
  /** Persist a pin (the user's connect-and-pin decision). */
  pin(host: string, port: number, pin: HostKeyPin): Promise<void>;
  /** The unknown key needs a decision — the TOFU prompt. Absent = pin
   * silently (programmatic callers). Rejecting the promise also refuses. */
  decide?(info: HostKeyInfo): Promise<TofuDecision>;
  /** The key CHANGED against a stored pin — surfaced to the UI before the
   * connect fails. */
  onMismatch?(info: HostKeyInfo): void;
}

export interface ConnectOptions {
  /** The relay's wss:// base URL; host/port/token ride the query string. */
  url: string;
  idToken: string;
  host: string;
  port: number;
  user: string;
  auth: BridgeAuth;
  onStatus?: (status: string) => void;
  /** The SSH transport died (network, relay, server). Channels will each
   * deliver their own exit; this is for the connection-level indicator. */
  onClosed?: () => void;
  /** Host-key pinning (TOFU). Absent = accept the presented key. */
  knownHosts?: KnownHostsHooks;
}

const EXEC_TIMEOUT_MS = 30_000;
const EXEC_CAPTURE_CAP = 512_000;

export class SshConnection {
  private conn: SSHClient | null = null;
  private closedByUs = false;
  private onClosed: (() => void) | null = null;
  /** Set when the HOST KEY refused the handshake — the ssh2 error that
   * follows is a generic key-exchange failure, and this is the sentence the
   * user needs instead. */
  private hostKeyError: string | null = null;

  /** True between a successful connect() and close(). */
  get open(): boolean {
    return this.conn !== null && !this.closedByUs;
  }

  /** Dial the relay, run the SSH handshake through it, resolve when the
   * connection is authenticated and usable — the shell's `ready`. */
  async connect(opts: ConnectOptions): Promise<void> {
    const auth = this.authOf(opts.auth);
    this.closedByUs = false;
    this.onClosed = opts.onClosed ?? null;
    this.hostKeyError = null;
    const query = new URLSearchParams({
      host: opts.host,
      port: String(opts.port),
      token: opts.idToken,
    });
    const sock = await connectWebSocketDuplex(`${opts.url}?${query.toString()}`);
    sock.on('close', () => {
      if (!this.closedByUs) this.onClosed?.();
    });

    const conn = new SSHClient();
    this.conn = conn;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      conn.on('ready', () => {
        settled = true;
        resolve();
      });
      conn.on('error', (e: Error) => {
        if (!settled) {
          settled = true;
          // A refused handshake leaves a dead socket behind; drop it so a
          // retry starts from scratch instead of writing to a closed WS.
          try {
            sock.destroy();
          } catch {
            // the relay may already be gone
          }
          this.conn = null;
          reject(new Error(this.hostKeyError ?? e.message));
        }
      });
      conn.on('close', () => {
        if (!settled) {
          settled = true;
          this.conn = null;
          reject(new Error('connection closed during handshake'));
        } else if (!this.closedByUs) {
          this.onClosed?.();
        }
      });
      conn.connect({
        sock,
        username: opts.user,
        ...auth,
        tryKeyboard: false,
        // The TOFU prompt pauses the handshake mid-key-exchange, and the
        // prompt time counts against this budget — a fingerprint is read at
        // human speed (OpenSSH waits forever; we wait 90s).
        readyTimeout: opts.knownHosts ? 90_000 : 20_000,
        keepaliveInterval: 30_000,
        // No hostHash: the verifier gets the RAW key blob, decodes it, and
        // compares against the stored pin byte-for-byte — the desktop's
        // hostVerifier shape, not a hex digest of it.
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          const hooks = opts.knownHosts;
          if (!hooks) {
            opts.onStatus?.(`host key ${decodePublicKeyBlob(key).keyType}`);
            verify(true);
            return;
          }
          verifyHostKey(hooks, opts, key)
            .then((r) => {
              if (r.ok) {
                verify(true);
              } else {
                this.hostKeyError = r.reason;
                verify(false);
              }
            })
            .catch((e: unknown) => {
              // A pin store that cannot be read must not fail open.
              this.hostKeyError = e instanceof Error ? e.message : String(e);
              verify(false);
            });
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

  /**
   * One exec channel, collected. Never rejects — a transport failure comes
   * back as `error` with a null exit code, so a caller can treat "the host
   * said no" and "the road was out" differently without try/except glue.
   */
  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecOutcome> {
    const conn = this.conn;
    if (conn === null || this.closedByUs) {
      return { exitCode: null, stdout: '', stderr: '', error: 'connection is not open' };
    }
    return new Promise<ExecOutcome>((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let stream: ClientChannel | null = null;
      const settle = (out: ExecOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(out);
      };
      const timer = setTimeout(() => {
        try {
          stream?.close();
        } catch {
          // channel already gone
        }
        settle({ exitCode, stdout, stderr, error: `exec timed out after ${opts.timeoutMs ?? EXEC_TIMEOUT_MS}ms` });
      }, opts.timeoutMs ?? EXEC_TIMEOUT_MS);
      const append = (sink: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const rest = EXEC_CAPTURE_CAP - (sink === 'stdout' ? stdout.length : stderr.length);
        if (rest <= 0) return;
        if (sink === 'stdout') stdout += text.slice(0, rest);
        else stderr += text.slice(0, rest);
      };
      conn.exec(command, (err, ch) => {
        if (err) {
          settle({ exitCode: null, stdout: '', stderr: '', error: err.message });
          return;
        }
        stream = ch;
        ch.on('data', (chunk: Buffer) => append('stdout', chunk));
        ch.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
        ch.on('exit', (code: number | null) => {
          exitCode = typeof code === 'number' ? code : null;
        });
        ch.on('close', () => settle({ exitCode, stdout, stderr, error: null }));
      });
    });
  }

  /**
   * One interactive PTY channel — a login shell, or [command] run directly
   * under a PTY (session joins: the command IS the channel).
   */
  async openPty(req: PtyRequest): Promise<PtyChannel> {
    const conn = this.conn;
    if (conn === null || this.closedByUs) {
      throw new Error('connection is not open');
    }
    const pty = {
      term: req.term ?? 'xterm-256color',
      cols: req.cols ?? 80,
      rows: req.rows ?? 24,
    };
    return new Promise<PtyChannel>((resolve, reject) => {
      const done = (err: Error | undefined, channel: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }
        channel.on('data', (chunk: Buffer) => req.onData(new Uint8Array(chunk)));
        channel.on('close', () => req.onExit());
        channel.on('error', (e: Error) => req.onError(e.message));
        resolve({
          write: (text: string) => {
            channel.write(text);
          },
          resize: (rows: number, cols: number) => {
            try {
              channel.setWindow(rows, cols, 0, 0);
            } catch {
              // a closing channel takes a resize with it; the next tab wins
            }
          },
          close: () => {
            try {
              channel.close();
            } catch {
              // already closed
            }
          },
        });
      };
      if (req.command !== undefined) {
        conn.exec(req.command, { pty }, (err, channel) => done(err, channel));
      } else {
        conn.shell(pty, (err, channel) => done(err, channel));
      }
    });
  }

  close(): void {
    this.closedByUs = true;
    const conn = this.conn;
    this.conn = null;
    try {
      conn?.end();
    } catch {
      // the relay may already be gone; nothing to salvage
    }
    this.onClosed = null;
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
}

/**
 * Classify a presented host key and decide whether the handshake proceeds —
 * the browser twin of the desktop SshService's hostVerifier body:
 * trusted → proceed; mismatch → hard block (never silently replaced);
 * unknown → the TOFU decision, with connect-and-pin persisting it.
 * Exported for tests; the store failure path fails CLOSED (no connection).
 */
export async function verifyHostKey(
  hooks: KnownHostsHooks,
  opts: { host: string; port: number; onStatus?: (s: string) => void },
  keyBlob: Uint8Array,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { keyType, keyB64 } = decodePublicKeyBlob(keyBlob);
  const verdict = verifyHostKeyPin(await hooks.lookup(opts.host, opts.port), keyType, keyB64);
  if (verdict === 'trusted') {
    opts.onStatus?.('host key verified');
    return { ok: true };
  }
  const fingerprint = await sha256Fingerprint(keyBlob);
  if (verdict === 'mismatch') {
    const info: HostKeyInfo = { keyType, fingerprint };
    opts.onStatus?.('host key MISMATCH — refused');
    hooks.onMismatch?.(info);
    return {
      ok: false,
      reason: `Host key mismatch — the server's ${keyType} key (${fingerprint}) is not the pinned key. If the server was rebuilt or its key was rotated on purpose, remove the pin and reconnect.`,
    };
  }
  const decision = (await hooks.decide?.({ keyType, fingerprint })) ?? 'always';
  if (decision === 'reject') {
    opts.onStatus?.('host key rejected');
    return { ok: false, reason: 'Host key rejected — nothing was pinned.' };
  }
  if (decision === 'always') {
    await hooks.pin(opts.host, opts.port, { keyType, keyB64 });
    opts.onStatus?.(`first connect — pinned ${keyType} ${fingerprint}`);
  } else {
    opts.onStatus?.(`${keyType} accepted for this session only`);
  }
  return { ok: true };
}
