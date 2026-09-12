/**
 * The WebSocket bridge protocol (implemented by the Lambda in aws-infra
 * sandbox/pocketshell-web). All frames are JSON text:
 *
 *   client → server: {type:"connect", host, port, username, auth, cols, rows}
 *                      where auth = {kind:"key", privateKey, passphrase?}
 *                                 | {kind:"password", password}
 *                    {type:"data",   data:"<raw text>"}     // keystrokes
 *                    {type:"resize", cols, rows}
 *                    {type:"ping"}
 *   server → client: {type:"connected"}
 *                    {type:"data",  data:"<base64>"}        // PTY bytes
 *                    {type:"exit"}
 *                    {type:"error", message}
 *                    {type:"session_lost"}                  // cold env; retry
 *                    {type:"pong"}
 *
 * The ID token rides the `?token=` query parameter; the bridge verifies it
 * against Google's JWKS (+ audience and email allowlist) on $connect. SSH
 * secrets live in the browser and travel once, in the `connect` frame, to
 * the bridge — which uses them in memory to open the SSH connection; the
 * Lambda neither persists nor logs them (verified in aws-infra source).
 */
export interface BridgeAuth {
  kind: 'key' | 'password';
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

export interface BridgeOpenOptions {
  host: string;
  port: number;
  user: string;
  term?: string;
  cols?: number;
  rows?: number;
  auth: BridgeAuth;
}

export class BridgeSession {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private openOptions: BridgeOpenOptions | null = null;
  private reconnects = 0;

  constructor(
    private readonly url: string,
    private readonly idToken: string,
    private readonly handlers: {
      onData: (bytes: Uint8Array) => void;
      onExit: () => void;
      onError: (message: string) => void;
      onStatus?: (status: string) => void;
    },
  ) {}

  /** Open the socket (token on the query string) and resolve once the shell
   * reports `connected`. One transparent reconnect on `session_lost` — the
   * bridge sometimes serves a frame from a cold environment. */
  async open(opts: BridgeOpenOptions): Promise<void> {
    this.openOptions = opts;
    this.reconnects = 0;
    await this.connectAndStart();
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.url === '') {
        reject(new Error('Bridge URL is not configured yet (deploy the pocketshell-web stack)'));
        return;
      }
      const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(this.idToken)}`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => this.handlers.onError('WebSocket connection failed');
      ws.onmessage = (ev) => this.onMessage(ev);
      ws.onclose = () => {
        this.stopPing();
        this.handlers.onExit();
      };
    });
  }

  private async connectAndStart(): Promise<void> {
    await this.connectSocket();
    const opts = this.openOptions!;
    const connected = new Promise<void>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
    });
    this.send({
      type: 'connect',
      host: opts.host,
      port: opts.port,
      username: opts.user,
      auth: opts.auth,
      term: opts.term ?? 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    });
    this.ping = setInterval(() => this.send({ type: 'ping' }), 240_000);
    await connected;
  }

  private pendingConnect: { resolve: () => void; reject: (e: Error) => void } | null = null;

  private onMessage(ev: MessageEvent) {
    if (typeof ev.data !== 'string') return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (frame['type']) {
      case 'connected':
        this.reconnects = 0;
        this.pendingConnect?.resolve();
        this.pendingConnect = null;
        break;
      case 'data':
        if (typeof frame['data'] === 'string') this.handlers.onData(b64ToBytes(frame['data']));
        break;
      case 'exit':
        this.handlers.onExit();
        break;
      case 'error':
        this.handlers.onError(typeof frame['message'] === 'string' ? frame['message'] : 'bridge error');
        this.pendingConnect?.reject(new Error(String(frame['message'])));
        this.pendingConnect = null;
        break;
      case 'session_lost':
        // The frame landed on a cold Lambda environment. Reconnect once.
        if (this.reconnects++ < 1 && this.openOptions !== null) {
          this.handlers.onStatus?.('reconnecting…');
          this.ws?.close();
          this.connectAndStart().catch((e) => this.handlers.onError(e instanceof Error ? e.message : String(e)));
        } else {
          this.handlers.onError('bridge lost the session');
        }
        break;
      case 'pong':
        break;
    }
  }

  sendInput(text: string) {
    // Keystrokes go as raw text; PTY output comes back base64 (see header).
    this.send({ type: 'data', data: text });
  }

  resize(cols: number, rows: number) {
    this.send({ type: 'resize', cols, rows });
  }

  private send(frame: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private stopPing() {
    if (this.ping !== null) clearInterval(this.ping);
    this.ping = null;
  }

  close() {
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
