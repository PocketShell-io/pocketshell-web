/**
 * The web half of the transport seam: one PocketShellApi implementation over
 * the browser transport (WebSocket SSH via SshConnection, WorkspaceSftp, the
 * sync service), provided to the shared app tree through provideApi().
 *
 * Groups whose members run today are spelled out; the groups still unbacked
 * resolve through the unsupported proxy at the bottom, so every hole fails
 * loudly with its own method name instead of silently rendering nothing. The
 * workspace adoption round replaces them one group at a time, each backed by
 * `SshConnection.exec` plus the parsers that already live in
 * @pocketshell/core. Nothing here may reach Electron or Node.
 */
import type { ConnectionState } from '@pocketshell/core';
import type { PocketShellApi, Unsubscribe } from '@ui/app/api';
import { SshConnection, type PtyChannel } from '../terminal/connection';
import { useHostsStore } from '../stores/hosts';

export class UnsupportedCapability extends Error {
  constructor(method: string) {
    super(`web transport does not implement ${method} yet`);
    this.name = 'UnsupportedCapability';
  }
}

/** Connection registry: the desktop main process owns this; the browser
 * keeps the same concept in module scope. Keys are opaque ids. */
const connections = new Map<string, SshConnection>();
let nextConnectionId = 1;

function connectionOf(connectionId: string): SshConnection {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error(`unknown connection: ${connectionId}`);
  return conn;
}

/** Shell channel registry — the browser twin of the desktop's shell ids. */
const channels = new Map<string, PtyChannel>();
let nextShellId = 1;
void channels;
void nextShellId;

type StateListener = Parameters<PocketShellApi['ssh']['onState']>[0];
const stateListeners = new Set<StateListener>();

function emitState(connectionId: string, state: ConnectionState): void {
  for (const listener of stateListeners) listener({ connectionId, state });
}

export const webApi: PocketShellApi = {
  ssh: {
    // REAL — the web's own dial path: relay WebSocket + ssh2 handshake.
    // The connect payload rides the same signed relay URL the workspace
    // controller has always dialed; the auth/id field spelling follows the
    // api contract, and the connection object adapts it.
    async connect(payload) {
      const conn = new SshConnection();
      try {
        await conn.connect(payload as never);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const id = `conn-${nextConnectionId++}`;
      connections.set(id, conn);
      emitState(id, 'connected');
      return { ok: true, connectionId: id };
    },
    async close(connectionId) {
      const conn = connections.get(connectionId);
      if (!conn) return false;
      connections.delete(connectionId);
      conn.close();
      emitState(connectionId, 'lost');
      return true;
    },
    async exec(connectionId, command) {
      const outcome = await connectionOf(connectionId).exec(command);
      if (outcome.error) throw new Error(outcome.error);
      return { exitCode: outcome.exitCode ?? 0, stdout: outcome.stdout, stderr: outcome.stderr };
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    // REAL — the synced host list stands in for ~/.ssh/config on the web.
    async listConfigHosts() {
      return useHostsStore().hosts;
    },
  },

  diag: {
    // REAL — no desktop log file on the web; the console is the sink.
    log(line) {
      console.info(`[pocketshell] ${line}`);
    },
  },

  win: {
    // REAL — the browser equivalent of the OS window title.
    setTitle(title) {
      document.title = title;
    },
    openAccount() {
      throw new UnsupportedCapability('win.openAccount');
    },
    setZoom() {
      /* browser zoom belongs to the browser */
    },
    onZoomCommand() {
      return () => {};
    },
  },

  app: {
    onResumed() {
      // Browsers do not announce OS resume; the connection store's own
      // liveness probe covers the wake-from-sleep case.
      return () => {};
    },
  },

  // Unbacked groups: declared for type completeness, filled with loud
  // per-method stubs by the loop below before any consumer can run.
  shell: undefined as never,
  helper: undefined as never,
  projects: undefined as never,
  sftp: undefined as never,
  preview: undefined as never,
  forwards: undefined as never,
  attachments: undefined as never,
  agent: undefined as never,
  update: undefined as never,
  editors: undefined as never,
  sync: undefined as never,
};

// Every group not spelled out above resolves to a loud per-method stub until
// its adoption round lands — never a silent no-op.
const UNBACKED_GROUPS = [
  'shell',
  'helper',
  'projects',
  'sftp',
  'preview',
  'forwards',
  'attachments',
  'agent',
  'update',
  'editors',
  'sync',
] as const;

// The seam object is typed for consumers; filling the unbacked groups here is
// deliberately a runtime operation — the stub's type is "the same group, but
// every missing method throws".
const mutableGroups = webApi as unknown as Record<(typeof UNBACKED_GROUPS)[number], unknown>;

// The seam object is typed for consumers; filling the unbacked groups here is
// deliberately a runtime operation — the stub's type is "the same group, but
// every missing method throws".
for (const group of UNBACKED_GROUPS) {
  mutableGroups[group] = new Proxy(webApi[group], {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      return (): never => {
        throw new UnsupportedCapability(`${group}.${String(prop)}`);
      };
    },
  });
}

export type { Unsubscribe };
