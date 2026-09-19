import { SshConnection, type PtyChannel } from './connection';
import type { TerminalSession, SessionHandlers } from './session';
import type { BridgeOpenOptions } from './bridge';

/**
 * Browser-direct SSH: the browser runs the SSH client itself and the relay
 * (relay/ — a dumb WebSocket↔TCP pipe, deployable as a free Cloudflare
 * Worker) only ferries ciphertext toward host:port. The private key never
 * leaves the browser; the relay has nothing to read even in principle.
 *
 * This is the sessions workspace's single-tab shape: one SshConnection, one
 * login-shell PTY. The workspace view drives SshConnection directly when it
 * needs exec channels and several session tabs at once.
 */
export class DirectSshSession implements TerminalSession {
  private readonly conn = new SshConnection();
  private channel: PtyChannel | null = null;
  private closedByUs = false;

  constructor(
    private readonly url: string,
    private readonly idToken: string,
    private readonly handlers: SessionHandlers,
  ) {}

  /** Dial the relay, run the SSH handshake through it, start a shell, and
   * resolve once the shell is live — the `connected` equivalent. */
  async open(opts: BridgeOpenOptions): Promise<void> {
    await this.conn.connect({
      url: this.url,
      idToken: this.idToken,
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
