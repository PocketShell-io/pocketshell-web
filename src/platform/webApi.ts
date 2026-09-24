/**
 * The web half of the transport seam: one PocketShellApi implementation over
 * the browser transport, provided to the shared app tree through provideApi().
 *
 * Everything above the seam is the DESKTOP'S renderer UI; this file is the
 * browser's answer to the desktop's main process. The groups delegate to
 * platform twins that mirror the desktop services' contracts call for call:
 *
 *   ssh      — SshConnection (relay WebSocket + browser ssh2), key material
 *              resolved from the synced hosts store (the web's ~/.ssh/config),
 *              TOFU pinning from the pins store;
 *   shell    — ShellService, the TmuxClientPool twin (one PTY per session
 *              tab, attach/switch semantics, honest input fence);
 *   helper   — HostHelper (bootstrap probe, session lists, usage, warnings);
 *   projects — ProjectsService (folder-first flow, aplexer-first);
 *   sftp     — SftpService, the SftpService twin;
 *   agent    — AgentService (kinds/profiles probe, env verbs);
 *   sync     — WebSync over the SyncService + web syncCrypto;
 *   preview  — blob-URL documents for the Files tab (relative references
 *              degrade; see webPreview.ts);
 *   forwards — the one loud hole: port forwarding is not implemented in the
 *              browser transport yet, and every method fails with its own
 *              name instead of silently doing nothing.
 *
 * Nothing here may reach Electron or Node.
 */
import type { PocketShellApi, Unsubscribe } from '@ui/app/api';
import type { ConnectionState } from '@pocketshell/core';
import type { CloneProgress, HostEntry, UpdateCheckResult } from '@pocketshell/core';
import { vscodeRemoteFolderUrl } from '@pocketshell/core/shared/vscodeDeepLink';
import { SshConnection } from '../terminal/connection';
import { useAuthStore } from '../stores/auth';
import { useHostPinsStore } from '../stores/hostPins';
import { useHostsStore } from '../stores/hosts';
import { ShellService } from './shellService';
import { HostHelper } from './hostHelper';
import { ProjectsService } from './projectsService';
import { SftpService } from './sftpService';
import { AgentService } from './agentEnv';
import { WebSync } from './webSync';
import { PreviewService } from './webPreview';
import { WebAttachments } from './webAttachments';
import { config } from '../config';

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

/** One bundle of per-connection services, created at connect, evicted at
 * disconnect — the same lifetime the desktop main gives its services. */
interface ConnectionServices {
  shell: ShellService;
  helper: HostHelper;
  projects: ProjectsService;
  sftp: SftpService;
  agent: AgentService;
  preview: PreviewService;
  attachments: WebAttachments;
}
const services = new Map<string, ConnectionServices>();

function servicesOf(connectionId: string): ConnectionServices {
  const bundle = services.get(connectionId);
  if (!bundle) throw new Error(`unknown connection: ${connectionId}`);
  return bundle;
}

function connectionOf(connectionId: string): SshConnection {
  const conn = connections.get(connectionId);
  if (!conn) throw new Error(`unknown connection: ${connectionId}`);
  return conn;
}

type StateListener = Parameters<PocketShellApi['ssh']['onState']>[0];
const stateListeners = new Set<StateListener>();

function emitState(connectionId: string, state: ConnectionState): void {
  for (const listener of stateListeners) listener({ connectionId, state });
}

/** Tear a connection's everything down — the web twin of main disposing a
 * connection record. */
function evictConnection(connectionId: string): void {
  const bundle = services.get(connectionId);
  services.delete(connectionId);
  if (bundle) {
    bundle.shell.evict(connectionId);
    bundle.helper.evict();
    bundle.projects.evict();
    bundle.sftp.evict();
  }
  const conn = connections.get(connectionId);
  connections.delete(connectionId);
  conn?.close();
}

type CloneListener = (progress: CloneProgress) => void;
const cloneListeners = new Set<CloneListener>();

/** The web's host-key pinning, built per connect from the pins store. The
 * shared connection store always dials with `accept-always` — the desktop's
 * behaviour, pin without prompting — while `reject`/`accept-once` keep
 * their meanings for programmatic callers. */
function knownHostsHooks(payload: { tofuDecision?: 'accept-always' | 'accept-once' | 'reject' }) {
  const pins = useHostPinsStore();
  const decision =
    payload.tofuDecision === 'accept-once' ? ('once' as const) : payload.tofuDecision === 'reject' ? ('reject' as const) : ('always' as const);
  return {
    lookup: (host: string, port: number) => pins.lookup(host, port),
    pin: (host: string, port: number, pin: Parameters<typeof pins.pin>[2]) => pins.pin(host, port, pin),
    ...(payload.tofuDecision !== 'accept-always' ? { decide: () => Promise.resolve(decision) } : {}),
  };
}

async function connectHost(payload: {
  host: string;
  port?: number;
  user: string;
  privateKeyPath?: string;
  tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
}): Promise<{ ok: true; connectionId: string } | { ok: false; error: string }> {
  // The synced host list is the web's ~/.ssh/config: a dial is authorised by
  // a synced entry, and its attached secret (never a key FILE path — the
  // key lives in this browser) is the credential.
  const store = useHostsStore();
  const wantedPort = payload.port ?? 22;
  const entry: HostEntry | undefined =
    store.hosts.find((h) => h.hostname === payload.host && h.port === wantedPort) ??
    store.hosts.find((h) => h.name === payload.privateKeyPath) ??
    store.hosts.find((h) => h.hostname === payload.host);
  if (!entry) {
    return { ok: false, error: `No synced host for ${payload.user ? `${payload.user}@` : ''}${payload.host}:${wantedPort}` };
  }
  const secret = await store.getHostSecret(entry.name);
  if (!secret || ((secret.privateKeyPem ?? '') === '' && (secret.password ?? '') === '')) {
    return {
      ok: false,
      error: 'No key attached for this host yet — attach one on the hosts screen and unlock again.',
    };
  }

  const conn = new SshConnection();
  const auth = useAuthStore();
  // The connection id only exists once the dial resolves, but the transport's
  // onClosed callback needs it — the desktop pool's mutable-box pattern.
  let connectionIdRef: string | null = null;
  try {
    await conn.connect({
      url: config.directWsUrl,
      idToken: auth.idToken,
      host: entry.hostname,
      port: entry.port,
      user: entry.user || payload.user,
      auth:
        (secret.privateKeyPem ?? '') !== ''
          ? {
              kind: 'key' as const,
              privateKey: secret.privateKeyPem!,
              ...(secret.keyPassphrase ? { passphrase: secret.keyPassphrase } : {}),
            }
          : { kind: 'password' as const, password: secret.password! },
      knownHosts: knownHostsHooks(payload),
      onClosed: () => {
        const id = connectionIdRef;
        if (id === null) return;
        evictConnection(id);
        emitState(id, 'lost');
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const id = `conn-${nextConnectionId++}`;
  connectionIdRef = id;
  connections.set(id, conn);
  const sftp = new SftpService(conn);
  const bundle: ConnectionServices = {
    shell: new ShellService(),
    helper: new HostHelper(conn),
    projects: new ProjectsService(conn, id),
    sftp,
    agent: new AgentService(conn),
    preview: new PreviewService((path) => sftp.readFile(id, path)),
    attachments: new WebAttachments(sftp),
  };
  services.set(id, bundle);
  // The per-connection shell events fan out to the module-level listeners
  // the shared pane subscribes through.
  bundle.shell.onData(({ shellId, data }) => {
    for (const handler of shellDataListeners) handler({ shellId, data });
  });
  bundle.shell.onExited(({ shellId, exitCode }) => {
    for (const handler of shellExitListeners) handler({ shellId, exitCode });
  });
  emitState(id, 'connected');
  return { ok: true, connectionId: id };
}

export const webApi: PocketShellApi = {
  ssh: {
    async connect(payload) {
      return connectHost(payload);
    },
    async close(connectionId) {
      if (!connections.has(connectionId)) return false;
      evictConnection(connectionId);
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

  shell: {
    async open(payload) {
      return servicesOf(payload.connectionId).shell.open(
        connectionOf(payload.connectionId),
        payload.connectionId,
        payload,
      );
    },
    async attachSession(payload) {
      return servicesOf(payload.connectionId).shell.attachSession(
        connectionOf(payload.connectionId),
        payload.connectionId,
        payload,
      );
    },
    input: (shellId, data, sessionName, workspace) =>
      shellCall(shellId, false, (b) => b.shell.input(shellId, data, sessionName, workspace)),
    resize: (shellId, cols, rows) =>
      shellCall(shellId, false, (b) => b.shell.resize(shellId, cols, rows)),
    redraw: (shellId) => shellCall(shellId, false, (b) => b.shell.redraw(shellId)),
    windowSize: (shellId) => shellCall(shellId, { kind: 'bare' } as never, (b) => b.shell.windowSize(shellId)),
    close: (shellId) => shellCall(shellId, false, (b) => b.shell.close(shellId)),
    onData(handler) {
      shellDataListeners.add(handler);
      return () => shellDataListeners.delete(handler);
    },
    onExited(handler) {
      shellExitListeners.add(handler);
      return () => shellExitListeners.delete(handler);
    },
  },

  helper: {
    bootstrap: (connectionId) => servicesOf(connectionId).helper.bootstrap(),
    sessionsList: (connectionId, sortBy) => servicesOf(connectionId).helper.listSessions(sortBy),
    sessionsCreate: (connectionId, name, cwd) =>
      servicesOf(connectionId).helper.createSession(name, cwd),
    usage: (connectionId) => servicesOf(connectionId).helper.usage(),
    warnings: (connectionId) => servicesOf(connectionId).helper.warnings(),
    ackWarnings: (connectionId, target) => servicesOf(connectionId).helper.ackWarnings(target),
  },

  projects: {
    home: (connectionId) => servicesOf(connectionId).projects.home(),
    deriveName: (connectionId, folder, customName) =>
      servicesOf(connectionId).projects.deriveName(folder, customName),
    createFolder: (connectionId, request) => servicesOf(connectionId).projects.createFolder(request),
    reposList: (connectionId, request) => servicesOf(connectionId).projects.reposList(request),
    reposClone: (connectionId, request) =>
      servicesOf(connectionId).projects.reposClone(request, (progress) => {
        for (const listener of cloneListeners) listener(progress);
      }),
    startSession: (connectionId, request) => servicesOf(connectionId).projects.startSession(request),
    renameSession: (connectionId, from, to, ref) =>
      servicesOf(connectionId).projects.renameSession(from, to, ref),
    killSession: (connectionId, name, ref) =>
      servicesOf(connectionId).projects.killSession(name, ref),
    onCloneProgress(handler) {
      cloneListeners.add(handler);
      return () => cloneListeners.delete(handler);
    },
  },

  sftp: {
    list: (connectionId, path) => servicesOf(connectionId).sftp.list(connectionId, path),
    stat: (connectionId, path) => servicesOf(connectionId).sftp.stat(connectionId, path),
    readFile: (connectionId, path) => servicesOf(connectionId).sftp.readFile(connectionId, path),
    readBinary: (connectionId, path, maxBytes) =>
      servicesOf(connectionId).sftp.readBinary(connectionId, path, maxBytes),
    writeFile: (connectionId, path, content) =>
      servicesOf(connectionId).sftp.writeFile(connectionId, path, content),
    createFile: (connectionId, path, content) =>
      servicesOf(connectionId).sftp.createFile(connectionId, path, content),
    mkdir: (connectionId, path) => servicesOf(connectionId).sftp.mkdir(connectionId, path),
    rename: (connectionId, fromPath, toPath) =>
      servicesOf(connectionId).sftp.rename(connectionId, fromPath, toPath),
    deleteFile: (connectionId, path) => servicesOf(connectionId).sftp.deleteFile(connectionId, path),
    rmdir: (connectionId, path) => servicesOf(connectionId).sftp.rmdir(connectionId, path),
    realPath: (connectionId, path) => servicesOf(connectionId).sftp.realPath(connectionId, path),
    upload: (payload) => servicesOf(payload.connectionId).sftp.upload(),
    download: (payload) => servicesOf(payload.connectionId).sftp.download(),
    saveAs: (payload) => servicesOf(payload.connectionId).sftp.saveAs(payload),
    onProgress: () => () => {},
  },

  preview: {
    openHtml: (connectionId, path) => servicesOf(connectionId).preview.openHtml(path),
    openMarkdown: (connectionId, path, style) =>
      servicesOf(connectionId).preview.openMarkdown(path, style),
    openSvg: (connectionId, path) => servicesOf(connectionId).preview.openSvg(path),
    release: (token) => {
      for (const bundle of services.values()) bundle.preview.release(token);
    },
    onStats: () => () => {},
  },

  attachments: {
    stage: (payload) => servicesOf(payload.connectionId).attachments.stage(payload),
    pickFiles: (payload) => servicesForAttachments().pickFiles(payload),
    readLocal: (path) => servicesForAttachments().readLocal(path),
  },

  agent: {
    kinds: (connectionId) =>
      servicesOf(connectionId).agent.kinds().then((kinds) =>
        kinds === null ? null : [...kinds],
      ),
    profiles: (connectionId) => servicesOf(connectionId).agent.profiles(),
    envList: (connectionId, dir) => servicesOf(connectionId).agent.envList(dir),
    envGet: (connectionId, dir, keys) => servicesOf(connectionId).agent.envGet(dir, keys),
    envSet: (connectionId, dir, values, file) =>
      servicesOf(connectionId).agent.envSet(dir, values, file),
  },

  sync: webSyncApi(),

  // Port forwarding is not implemented in the browser transport yet. The
  // READ side answers EMPTY rather than throwing: the workspace view polls
  // `list`/`isAutoEnabled` on every mount, and a poll that fails paints the
  // diag banner red forever for a feature the web has never had. Empty is
  // the honest answer — there are no forwards. The WRITE side (start, add,
  // toggle…) still fails with its own name, so nothing can pretend to
  // forward anything.
  forwards: {
    scan: () => Promise.reject(new UnsupportedCapability('forwards.scan')),
    startAuto: () => Promise.reject(new UnsupportedCapability('forwards.startAuto')),
    stopAuto: () => Promise.reject(new UnsupportedCapability('forwards.stopAuto')),
    addManual: () => Promise.reject(new UnsupportedCapability('forwards.addManual')),
    remove: () => Promise.reject(new UnsupportedCapability('forwards.remove')),
    list: () => Promise.resolve([]),
    refresh: () => Promise.resolve(false),
    discovered: () => Promise.resolve([]),
    status: () => Promise.resolve(null),
    setName: () => Promise.reject(new UnsupportedCapability('forwards.setName')),
    setRemap: () => Promise.reject(new UnsupportedCapability('forwards.setRemap')),
    clearRemap: () => Promise.reject(new UnsupportedCapability('forwards.clearRemap')),
    setIntent: () => Promise.reject(new UnsupportedCapability('forwards.setIntent')),
    togglePort: () => Promise.reject(new UnsupportedCapability('forwards.togglePort')),
    isAutoEnabled: () => Promise.resolve(false),
    onStates: () => () => {},
  },

  diag: {
    // REAL — no desktop log file on the web; the console is the sink.
    log(entry) {
      console.info(`[pocketshell] ${entry.kind}: ${entry.message}`, entry.detail ?? '');
    },
  },

  update: {
    // The web app is its own deployment: a reload IS the update path, so the
    // honest answer is "you are running the current build".
    async check(): Promise<UpdateCheckResult> {
      return { status: 'up-to-date', currentVersion: 'web' };
    },
    async open(url) {
      window.open(url, '_blank', 'noopener');
    },
  },

  editors: {
    // The OS-dispatched vscode:// URL, built by the shared builder — the
    // browser hands the scheme to the user's machine the same way
    // shell.openExternal does on the desktop.
    async openVsCode(req) {
      const url = vscodeRemoteFolderUrl(
        typeof req.hostToken === 'string' ? req.hostToken : '',
        typeof req.path === 'string' ? req.path : '',
      );
      if (!url) return false;
      window.location.href = url;
      return true;
    },
  },

  win: {
    // REAL — the browser equivalent of the OS window title.
    setTitle(title) {
      document.title = title;
    },
    // The account surface is a route here, not a second window.
    openAccount(): Promise<void> {
      window.location.assign('/account');
      return new Promise(() => {});
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
};

// --- shell event fan-out ----------------------------------------------------
// Data/exit events are module-level (the shared pane subscribes once per
// mount); connectHost forwards each new connection's ShellService into these.

type ShellDataHandler = Parameters<PocketShellApi['shell']['onData']>[0];
type ShellExitHandler = Parameters<PocketShellApi['shell']['onExited']>[0];
const shellDataListeners = new Set<ShellDataHandler>();
const shellExitListeners = new Set<ShellExitHandler>();

/** Route a shell-addressed call to the bundle whose service holds the id.
 * An unknown id answers with [fallback] rather than rejecting — the desktop's
 * handlers never reject on a stale id, and the shared pane calls several of
 * these without a catch. */
function shellCall<T>(shellId: string, fallback: T, run: (bundle: ConnectionServices) => Promise<T>): Promise<T> {
  for (const bundle of services.values()) {
    if (bundle.shell.holds(shellId)) return run(bundle);
  }
  return Promise.resolve(fallback);
}

/** Attachments pick/readLocal are session-scoped, not connection-scoped —
 * the active connection's bundle owns the picked Files. */
function servicesForAttachments(): WebAttachments {
  const bundle = [...services.values()].at(-1);
  if (!bundle) throw new Error('no open connection');
  return bundle.attachments;
}

function webSyncApi(): PocketShellApi['sync'] {
  const sync = new WebSync();
  return {
    status: () => sync.status(),
    login: () => sync.login(),
    logout: () => sync.logout(),
    pull: (slot, passphrase) => sync.pull(slot, passphrase),
    push: (slot, plaintext, passphrase, baseVersion) =>
      sync.push(slot, plaintext, passphrase, baseVersion),
    accountHosts: () => sync.accountHostsList(),
    applyHosts: (hosts) => sync.applyHosts(hosts),
  };
}

export type { Unsubscribe };
