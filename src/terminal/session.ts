/**
 * The one interface the terminal view needs from a session, whichever side
 * runs the SSH client: today the Lambda bridge (`bridge.ts`), with the key
 * riding the connect frame; and the direct session (`direct.ts`), where the
 * browser speaks SSH itself through a dumb relay. BridgeSession already
 * satisfies this structurally.
 */
import type { BridgeOpenOptions } from './bridge';

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

/** Factory so the ssh2 bundle is only ever fetched when a direct relay is
 * actually configured — Lambda-bridge users never download it. */
export async function createSession(
  kind: SessionKind,
  url: string,
  idToken: string,
  handlers: SessionHandlers,
): Promise<TerminalSession> {
  if (kind === 'direct') {
    const { DirectSshSession } = await import('./direct');
    return new DirectSshSession(url, idToken, handlers);
  }
  const { BridgeSession } = await import('./bridge');
  return new BridgeSession(url, idToken, handlers);
}
