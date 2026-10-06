/**
 * The link transport for the browser: one WebSocket to a PocketShell relay,
 * behind the same surface as {@link SshConnection} (connect/exec/openPty/
 * sftp/close), so `webApi.connectHost` can hand the existing per-connection
 * services a link host exactly as it hands them an SSH one. A NAT'd host
 * runs `pocketshell link run`; this client dials the relay — no inbound
 * reachability anywhere (docs/link-transport.md, pocketshell-cli).
 *
 * The protocol lives in core (`createLinkCapability`); this file is the
 * browser glue: the native WebSocket factory, utf8/base64 plumbing, and the
 * `ExecOutcome`/`PtyChannel` shapes the workspace services already speak.
 * SFTP rejects with the typed link message — the Files pane degrades the
 * same way it does for a host without SFTP.
 */
import {
  browserLinkSocketFactory,
  createLinkCapability,
  type LinkSocketFactory,
  type LinkTransportTarget,
  type SshCapability,
} from '@pocketshell/core';
import type { ExecOutcome, PtyChannel, PtyRequest } from './connection';

export interface LinkConnectOptions {
  link: LinkTransportTarget;
  /** The shared relay token — the link host's one secret. */
  linkToken: string;
  /** The transport dropped (relay gone, daemon offline). */
  onClosed?: () => void;
}

const EXEC_TIMEOUT_MS = 30_000;
const PTY_POLL_WAIT_MS = 250;

/** utf8 → base64 without Node's Buffer: exec stdin and pty writes. */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

let idCounter = 0;

export class LinkSshConnection {
  private readonly socketFactory: LinkSocketFactory;
  private capability: SshCapability | null = null;
  private ref: { connectionId: string; generationId: string } | null = null;
  private closedByUs = false;
  private onClosed: (() => void) | null = null;

  /** The factory is injectable so tests drive a canned in-process host. */
  constructor(socketFactory: LinkSocketFactory = browserLinkSocketFactory) {
    this.socketFactory = socketFactory;
  }

  /** True between a successful connect() and close(). */
  get open(): boolean {
    return this.ref !== null && !this.closedByUs;
  }

  /** Dial the relay and pair with the host; resolves when the link is live. */
  async connect(opts: LinkConnectOptions): Promise<void> {
    this.closedByUs = false;
    this.onClosed = opts.onClosed ?? null;
    const capability = createLinkCapability({
      relayUrl: opts.link.relayUrl,
      token: opts.linkToken,
      hostId: opts.link.hostId,
      socketFactory: this.socketFactory,
    });
    void capability.addListener('connectionState', (event) => {
      if (event.state === 'lost' && !this.closedByUs) this.onClosed?.();
    });
    this.ref = await capability.connect({
      requestId: this.requestId(),
      generationId: `web-link-${idCounter += 1}`,
      hostId: opts.link.hostId,
      hostname: opts.link.relayUrl,
      port: 0,
      username: 'link',
      credential: { kind: 'link-token', token: opts.linkToken },
      expectedHostKey: null,
    });
    this.capability = capability;
  }

  /**
   * One exec channel, collected. Never rejects — the same contract as
   * {@link ExecOutcome}: transport failures come back as `error` with a
   * null exit code so callers can distinguish "the host said no" from "the
   * road was out" without try/except glue.
   */
  async exec(
    command: string,
    opts: { timeoutMs?: number; stdin?: string } = {},
  ): Promise<ExecOutcome> {
    const capability = this.capability;
    const ref = this.ref;
    if (capability === null || ref === null || this.closedByUs) {
      return { exitCode: null, stdout: '', stderr: '', error: 'connection is not open' };
    }
    try {
      const res = await capability.exec({
        requestId: this.requestId(),
        connectionId: ref.connectionId,
        generationId: ref.generationId,
        command,
        timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS,
        ...(opts.stdin !== undefined ? { stdinBase64: utf8ToBase64(opts.stdin) } : {}),
      });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, error: null };
    } catch (e) {
      return { exitCode: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * One interactive PTY channel — a login shell, or [command] run directly
   * under a PTY (session joins). Reads park on the capability's waitMs, so
   * an idle tab polls at 4 Hz instead of spinning.
   */
  async openPty(req: PtyRequest): Promise<PtyChannel> {
    const capability = this.capability;
    const ref = this.ref;
    if (capability === null || ref === null || this.closedByUs) {
      throw new Error('connection is not open');
    }
    const ptyRef = await capability.openPty({
      requestId: this.requestId(),
      connectionId: ref.connectionId,
      generationId: ref.generationId,
      // The daemon has no shell channel: a "login shell" is the user's
      // shell exec'd by the daemon's sh, exactly the desktop adapter's shape.
      command: req.command ?? 'exec "${SHELL:-/bin/bash}" -l',
      cols: req.cols ?? 80,
      rows: req.rows ?? 24,
      term: req.term ?? 'xterm-256color',
    });
    void this.pump(capability, ref, ptyRef.channelId, req);
    return {
      write: (text) => {
        void capability
          .writePty({
            requestId: this.requestId(),
            connectionId: ref.connectionId,
            generationId: ref.generationId,
            channelId: ptyRef.channelId,
            sequence: 0,
            dataBase64: utf8ToBase64(text),
          })
          .catch(() => undefined);
      },
      resize: (rows, cols) => {
        void capability
          .resizePty({
            requestId: this.requestId(),
            connectionId: ref.connectionId,
            generationId: ref.generationId,
            channelId: ptyRef.channelId,
            sequence: 0,
            cols,
            rows,
          })
          .catch(() => undefined);
      },
      close: () => {
        void capability
          .closePty({
            requestId: this.requestId(),
            connectionId: ref.connectionId,
            generationId: ref.generationId,
            channelId: ptyRef.channelId,
          })
          .catch(() => undefined);
      },
    };
  }

  private async pump(
    capability: SshCapability,
    ref: { connectionId: string; generationId: string },
    channelId: string,
    req: PtyRequest,
  ): Promise<void> {
    let sequence = 0;
    for (;;) {
      let chunk;
      try {
        chunk = await capability.readPty({
          requestId: this.requestId(),
          connectionId: ref.connectionId,
          generationId: ref.generationId,
          channelId,
          sequence: sequence++,
          waitMs: PTY_POLL_WAIT_MS,
        });
      } catch (e) {
        req.onError(e instanceof Error ? e.message : String(e));
        req.onExit();
        return;
      }
      if (chunk.dataBase64.length > 0) {
        req.onData(new Uint8Array(atob(chunk.dataBase64).split('').map((c) => c.charCodeAt(0))));
      }
      if (chunk.eof) break;
    }
    req.onExit();
  }

  /** The Files pane over link — rejected, never silently empty. */
  sftp(): Promise<never> {
    return Promise.reject(new Error('SFTP is not available over the link transport.'));
  }

  close(): void {
    this.closedByUs = true;
    const capability = this.capability;
    const ref = this.ref;
    this.capability = null;
    this.ref = null;
    this.onClosed = null;
    if (capability !== null && ref !== null) {
      void capability
        .closeConnection({ ...ref, requestId: this.requestId() })
        .catch(() => undefined);
    }
  }

  private requestId(): string {
    idCounter += 1;
    return `web-link-${idCounter.toString(36)}`;
  }
}
