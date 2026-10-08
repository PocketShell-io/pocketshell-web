/**
 * The one interface the terminal view needs from a session, whichever side
 * runs the SSH client: today the Lambda bridge (`bridge.ts`) — a distinct,
 * documented deployment boundary that receives the sign-in token on its
 * query string and SSH secrets in its connect frame — and the direct
 * session (`direct.ts`), where the browser speaks SSH itself through the
 * versioned scoped direct proxy. BridgeSession already satisfies this
 * structurally.
 */
import type { BridgeOpenOptions } from './bridge';
import type { ScopedProxyAdmission } from '../api/gatewayToken';

export interface SessionHandlers {
  onData: (bytes: Uint8Array) => void;
  onExit: () => void;
  onError: (message: string) => void;
  onStatus?: (status: string) => void;
}

export interface TerminalSession {
  open(opts: BridgeOpenOptions): Promise<void>;
  sendInput(text: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export type SessionKind = 'bridge' | 'direct';

/** Which transport a session dials, and with what:
 *
 *  - `bridge`: the Lambda bridge's URL and the sign-in token for its query
 *    string — the documented legacy boundary, byte-for-byte unchanged;
 *  - `direct`: the trusted scoped-proxy origin from deployment config plus
 *    an ASYNC provider that mints a FRESH typed admission per actual open.
 *    The provider is the caller's policy point: lock, sign-out and host
 *    edits refuse inside it BEFORE the broker is asked and before any
 *    socket exists. A stored token or a raw sign-in string cannot be
 *    supplied here — the type demands a mint. */
export type SessionDialSpec =
  | { kind: 'bridge'; url: string; idToken: string }
  | {
      kind: 'direct';
      serverUrl: string;
      dialOf: () => Promise<ScopedProxyAdmission>;
      /** Development escape hatch for ws:// endpoints — never in production. */
      allowInsecureWs?: boolean;
    };

/** Factory so the ssh2 bundle is only ever fetched when a scoped direct
 * proxy is actually dialed — Lambda-bridge users never download it. */
export async function createSession(spec: SessionDialSpec, handlers: SessionHandlers): Promise<TerminalSession> {
  if (spec.kind === 'direct') {
    const { DirectSshSession } = await import('./direct');
    return new DirectSshSession(spec, handlers);
  }
  const { BridgeSession } = await import('./bridge');
  return new BridgeSession(spec.url, spec.idToken, handlers);
}
