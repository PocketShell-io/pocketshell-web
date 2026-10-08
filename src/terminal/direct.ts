import { SshConnection, type PtyChannel } from './connection';
import type { TerminalSession, SessionHandlers, SessionDialSpec } from './session';
import type { BridgeOpenOptions } from './bridge';

/**
 * Browser-direct SSH: the browser runs the SSH client itself and reaches the
 * host through the deployment's versioned scoped direct proxy
 * (`/proxy/v1/ssh`) — the proxy ferries opaque ciphertext toward host:port
 * and admits the dial with a broker-minted scoped token in the first text
 * frame. The private key never leaves the browser; the sign-in never rides
 * the URL, a header, or any frame; the proxy has nothing to read even in
 * principle.
 *
 * The admission is minted FRESH per actual open through the async provider —
 * never per keystroke, never per exec on an already-open session, and never
 * from a stored token. This is the sessions workspace's single-tab shape:
 * one SshConnection, one login-shell PTY. The workspace view drives
 * SshConnection directly when it needs exec channels and several session
 * tabs at once.
 */
export class DirectSshSession implements TerminalSession {
  private readonly conn = new SshConnection();
  private channel: PtyChannel | null = null;
  private closedByUs = false;

  constructor(
    private readonly dial: Extract<SessionDialSpec, { kind: 'direct' }>,
    private readonly handlers: SessionHandlers,
  ) {}

  /** Mint a fresh admission, dial the scoped proxy, run the SSH handshake
   * through it, start a shell, and resolve once the shell is live — the
   * `connected` equivalent. A failed mint or admission fails the session
   * with zero sockets and zero fallback. */
  async open(opts: BridgeOpenOptions): Promise<void> {
    const admission = await this.dial.dialOf();
    await this.conn.connect({
      scopedProxy: {
        serverUrl: this.dial.serverUrl,
        admission,
        ...(this.dial.allowInsecureWs ? { allowInsecureWs: true } : {}),
      },
      host: opts.host,
      port: opts.port,
      user: opts.user,
      auth: opts.auth,
      onStatus: (s) => this.handlers.onStatus?.(s),
      onClosed: () => {
        if (!this.closedByUs) this.handlers.onExit();
      },
    });
    this.channel = await this.conn.openPty({
      cols: opts.cols,
      rows: opts.rows,
      term: opts.term,
      onData: (bytes) => this.handlers.onData(bytes),
      onExit: () => {
        this.closedByUs = true;
        this.handlers.onExit();
      },
      onError: (message) => this.handlers.onError(message),
    });
  }

  sendInput(text: string) {
    this.channel?.write(text);
  }

  resize(cols: number, rows: number) {
    this.channel?.resize(rows, cols);
  }

  close() {
    this.closedByUs = true;
    this.conn.close();
  }
}
