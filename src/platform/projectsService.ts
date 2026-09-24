/**
 * The web's projects group: the folder-first session flow, mirroring the
 * desktop's ProjectsService (src/main/projects/ProjectsService.ts) call for
 * call — the same command builders from core (`projectCommands`), the same
 * name derivations (`sessionNameParts`, `projectFolderName`), the same
 * result shapes and failure codes, and aplexer as the main session manager
 * wherever `a` is installed.
 *
 * The one narrowing, the same one HostHelper carries: the desktop's socket
 * LOCATOR (which aims tmux probes at the per-session server) is not ported,
 * so the tmux arms probe with the sweep-based builders
 * (`sessionTakenAnywhereCommand`) and aim at the default socket. On the
 * aplexer hosts this app targets the tmux arms are not reached at all: start
 * /rename/kill all resolve through the aplexer snapshot.
 */
import type {
  AplexerSessionRecord,
  AplexerSessionRef,
  CloneResult,
  CreateFolderRequest,
  CreateFolderResult,
  CreateSessionVia,
  HomeResult,
  KillSessionResult,
  RenameSessionResult,
  ReposListRequest,
  ReposListResult,
  ReposScopeResult,
  SessionNamePolicy,
  StartSessionFailure,
  StartSessionRequest,
  StartSessionResult,
} from '@pocketshell/core';
import {
  FREE_SESSION_NAME_MAX_SUFFIX,
  annotateHelperRejection,
  childPath,
  classifyReposFailure,
  createSessionCommand,
  fallbackCreateSessionCommand,
  firstNonEmptyLine,
  freeSessionNameCommand,
  HOME_COMMAND,
  isHelperMissing,
  killSessionCommand,
  lastNonEmptyLine,
  mergeRepos,
  mkdirCommand,
  normaliseProjectFolderName,
  parseReposJson,
  pathAwareCommand,
  renameSessionCommand,
  resolveAplexerTag,
  resolveDirectoryCommand,
  resolveSessionName,
  reposCloneCommand,
  reposListCommand,
  sanitiseName,
  sessionExistsCommand,
  sessionTakenAnywhereCommand,
  type ReposCloneOptions,
  type ReposListOptions,
} from '@pocketshell/core';
import { AplexerClient } from '../aplexer/client';
import type { ExecOutcome, SshConnection } from '../terminal/connection';

function toExecResult(outcome: ExecOutcome) {
  return { exitCode: outcome.exitCode ?? -1, stdout: outcome.stdout, stderr: outcome.stderr };
}

/** A scope that was not requested cannot make the call fail. */
function scopeOk(scope: ReposScopeResult | null): boolean {
  if (scope === null) return true;
  return scope.state === 'ok' || scope.state === 'gh-missing' || scope.state === 'gh-unauthenticated';
}

export class ProjectsService {
  private readonly aplexer: AplexerClient;
  /** Remote `$HOME` per connection — read on every name derivation, cached. */
  private readonly homes = new Map<string, string>();

  constructor(
    private readonly conn: SshConnection,
    private readonly connectionId: string,
  ) {
    this.aplexer = new AplexerClient(conn);
  }

  private exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecOutcome> {
    return this.conn.exec(command, opts);
  }

  private async execResult(command: string, opts?: { timeoutMs?: number }) {
    return toExecResult(await this.exec(command, opts));
  }

  evict(): void {
    this.homes.delete(this.connectionId);
    this.aplexer.evict();
  }

  /** Resolve (and cache) the remote `$HOME`. */
  async home(): Promise<HomeResult> {
    const cached = this.homes.get(this.connectionId);
    if (cached != null) return { ok: true, home: cached, error: null };
    const res = await this.execResult(pathAwareCommand(HOME_COMMAND));
    const home = res.stdout.trim();
    if (res.exitCode !== 0 || home.length === 0) {
      return { ok: false, home: null, error: res.stderr.trim() || 'could not resolve $HOME on the host' };
    }
    this.homes.set(this.connectionId, home);
    return { ok: true, home, error: null };
  }

  /**
   * The session name a folder WOULD get, for previewing in the picker.
   * Backend-dependent, as on the desktop: with aplexer the create tags the
   * session (default `main`), without it the name is derived from the folder.
   */
  async deriveName(folder: string, customName?: string): Promise<string> {
    if (await this.aplexer.isAvailable()) {
      return resolveAplexerTag(customName);
    }
    const { home } = await this.home();
    return resolveSessionName(customName ?? null, folder, home);
  }

  /** Create a new empty project folder under [request.parent]. */
  async createFolder(request: CreateFolderRequest): Promise<CreateFolderResult> {
    const safeName = normaliseProjectFolderName(request.name);
    if (safeName === null) {
      return { ok: false, path: null, error: 'Enter a single folder name (no "/" or "..").' };
    }
    const target = childPath(request.parent, safeName);
    const made = await this.execResult(pathAwareCommand(mkdirCommand(target)));
    if (made.exitCode !== 0) {
      return {
        ok: false,
        path: null,
        error: made.stderr.trim() || made.stdout.trim() || `mkdir exited ${made.exitCode}`,
      };
    }
    return { ok: true, path: (await this.canonicalise(target)) ?? target, error: null };
  }

  /** `repos list` for the requested scopes, merged — the desktop's two-exec race. */
  async reposList(request: ReposListRequest = {}): Promise<ReposListResult> {
    const scope = request.scope ?? 'both';
    const wantLocal = scope === 'local' || scope === 'both';
    const wantRemote = scope === 'remote' || scope === 'both';

    const localOptions: ReposListOptions = { scope: 'local', roots: request.roots, maxDepth: request.maxDepth };
    const remoteOptions: ReposListOptions = { scope: 'remote', limit: request.limit };

    const [local, remote] = await Promise.all([
      wantLocal ? this.reposScope(localOptions) : Promise.resolve(null),
      wantRemote ? this.reposScope(remoteOptions) : Promise.resolve(null),
    ]);

    return {
      ok: scopeOk(local) && scopeOk(remote),
      repos: mergeRepos(local?.repos ?? [], remote?.repos ?? []),
      local,
      remote,
    };
  }

  /** `pocketshell repos list` for ONE scope — never throws, never fails on a
   * missing/unauthenticated `gh` (typed state, empty rows). */
  private async reposScope(options: ReposListOptions): Promise<ReposScopeResult> {
    const res = await this.execResult(pathAwareCommand(reposListCommand(options)));
    if (res.exitCode === 0) {
      return { state: 'ok', repos: parseReposJson(res.stdout), error: null };
    }
    const { state, error } = classifyReposFailure(res.exitCode, res.stdout, res.stderr);
    return { state, repos: [], error };
  }

  /**
   * Clone a GitHub repo. The lifecycle events (started/finished) ride the
   * api's onCloneProgress fan-out, keyed by the renderer's requestId — the
   * same lifecycle-not-bytes contract as the desktop.
   */
  async reposClone(
    request: ReposCloneOptions & { requestId?: string },
    onProgress?: (progress: import('@pocketshell/core').CloneProgress) => void,
  ): Promise<CloneResult> {
    const requestId = request.requestId ?? '';
    const repository = request.repository;
    onProgress?.({ requestId, phase: 'started', repository });
    // `timeoutMs: 0` — a real clone is the one legitimately unbounded exec.
    const res = await this.execResult(pathAwareCommand(reposCloneCommand(request)), { timeoutMs: 0 });
    let result: CloneResult;
    if (res.exitCode === 0) {
      const path = firstNonEmptyLine(res.stdout);
      result = path
        ? { ok: true, path, alreadyExists: false, error: null }
        : { ok: false, path: null, alreadyExists: false, error: 'clone printed no path' };
    } else {
      const stderr = res.stderr.trim();
      const existing = /clone target already exists:\s*(.+)$/m.exec(stderr);
      if (existing) {
        result = { ok: true, path: existing[1]!.trim(), alreadyExists: true, error: null };
      } else {
        const { state, error } = classifyReposFailure(res.exitCode, res.stdout, res.stderr);
        result = { ok: false, path: null, alreadyExists: false, error, state };
      }
    }
    onProgress?.({
      requestId,
      phase: 'finished',
      repository,
      ...(result.path ? { path: result.path } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  /**
   * Start a session in [request.folder] — the single entry point all three
   * routes converge on, in the desktop's sequence: resolve $HOME,
   * canonicalise (whose failure IS the missing-folder answer), derive the
   * name, honour the name policy, create idempotently. `unique` fails
   * CLOSED: a create that cannot be shown to have made a NEW session is
   * refused with `name-unavailable`.
   */
  async startSession(request: StartSessionRequest): Promise<StartSessionResult> {
    const { home } = await this.home();
    const folder = request.folder.trim();

    const failed = (
      code: StartSessionFailure,
      error: string | null,
      opts: { folder?: string | null; via?: CreateSessionVia | null } = {},
    ): StartSessionResult => ({
      ok: false,
      sessionName: null,
      folder: opts.folder ?? null,
      reused: false,
      via: opts.via ?? null,
      aplexerId: null,
      error,
      code,
    });

    // The snapshot the aplexer branch reads, fetched CONCURRENTLY with the
    // canonicalisation — the create behind them is the latency-critical path.
    const snapshot: Promise<AplexerSessionRecord[]> | null = this.aplexer.snapshotRecords();

    const canonical = await this.canonicalise(folder);
    if (canonical === null) {
      return failed('folder-missing', `Start folder does not exist on the host: ${folder}`);
    }
    const base = resolveSessionName(request.customName ?? null, canonical, home);
    const policy = request.namePolicy ?? 'reuse';

    if (await this.aplexer.isAvailable()) {
      return this.startAplexerSession(
        canonical,
        resolveAplexerTag(request.customName),
        policy,
        failed,
        await snapshot,
      );
    }

    // The tmux path, for hosts without `a`. The reuse check runs the
    // sweep-based taken predicate (the locator's role, degraded to the sweep
    // the desktop's own fallback uses).
    let name = base;
    let reused = false;
    if (policy === 'unique') {
      const probe = await this.execResult(pathAwareCommand(freeSessionNameCommand(base)));
      if (probe.exitCode !== 0) {
        return failed(
          'name-unavailable',
          `Could not ask the host for a free session name, so nothing was created. ` +
            `Starting another session here would have re-opened "${base}" instead of ` +
            `making a new one.`,
          { folder: canonical },
        );
      }
      name = lastNonEmptyLine(probe.stdout) ?? base;
    } else {
      const has = await this.execResult(pathAwareCommand(sessionExistsCommand(base)));
      reused = has.exitCode === 0;
    }

    const created = await this.createTmuxSession(name, canonical);
    if (!created.ok) {
      return failed('create-failed', created.error, { folder: canonical, via: created.via });
    }
    if (policy === 'unique' && created.name !== name) {
      return failed(
        'name-unavailable',
        `Asked the host for a new session called "${name}" and it answered with ` +
          `"${created.name ?? ''}", so it is not clear a new session was made. Nothing ` +
          `here has been selected; check the host before trying again.`,
        { folder: canonical, via: created.via },
      );
    }
    return {
      ok: true,
      sessionName: created.name,
      folder: canonical,
      reused,
      via: created.via,
      aplexerId: null,
      error: null,
      code: null,
    };
  }

  /** The aplexer arm — reuse/unique read from one snapshot, client-side walk. */
  private async startAplexerSession(
    folder: string,
    base: string,
    policy: SessionNamePolicy,
    failed: (
      code: StartSessionFailure,
      error: string | null,
      opts?: { folder?: string | null; via?: CreateSessionVia | null },
    ) => StartSessionResult,
    records?: AplexerSessionRecord[],
  ): Promise<StartSessionResult> {
    if (policy === 'unique') {
      const tags = records
        ? new Set(records.filter((r) => r.workspace === folder).map((r) => r.tag))
        : await this.aplexer.liveTags(folder);
      if (tags === null) {
        return failed(
          'name-unavailable',
          `Could not ask the host for a free session name, so nothing was created. ` +
            `Starting another session here would have re-opened "${base}" instead of ` +
            `making a new one.`,
          { folder },
        );
      }
      let free = tags.has(base) ? null : base;
      if (free === null) {
        for (let i = 2; i <= FREE_SESSION_NAME_MAX_SUFFIX; i += 1) {
          const candidate = `${base}-${i}`;
          if (!tags.has(candidate)) {
            free = candidate;
            break;
          }
        }
      }
      if (free === null) {
        return failed(
          'name-unavailable',
          `Every name in the "${base}-N" walk is taken in this workspace, which is not ` +
            `a real state — nothing was created.`,
          { folder },
        );
      }
      return this.createAplexerSession(folder, free, policy, failed);
    }
    const live = records
      ? (records.find((r) => r.workspace === folder && r.tag === base) ?? null)
      : await this.aplexer.findSession(folder, base);
    if (live) {
      return {
        ok: true,
        sessionName: base,
        folder,
        reused: true,
        via: 'aplexer',
        aplexerId: live.id,
        error: null,
        code: null,
      };
    }
    return this.createAplexerSession(folder, base, policy, failed);
  }

  /** Run `a start` and translate its three answers. */
  private async createAplexerSession(
    folder: string,
    tag: string,
    policy: SessionNamePolicy,
    failed: (
      code: StartSessionFailure,
      error: string | null,
      opts?: { folder?: string | null; via?: CreateSessionVia | null },
    ) => StartSessionResult,
  ): Promise<StartSessionResult> {
    const created = await this.aplexer.startSession({ workspace: folder, tag });
    if (created.ok) {
      if (policy === 'unique' && created.tag !== tag) {
        return failed(
          'name-unavailable',
          `Asked the host for a new session called "${tag}" and it answered with ` +
            `"${created.tag ?? ''}", so it is not clear a new session was made. Nothing ` +
            `here has been selected; check the host before trying again.`,
          { folder, via: 'aplexer' },
        );
      }
      return {
        ok: true,
        sessionName: created.tag,
        folder,
        reused: false,
        via: 'aplexer',
        aplexerId: created.id,
        error: null,
        code: null,
      };
    }
    if (created.liveRefusal) {
      // Lost the race: the pair went live between the snapshot check and the
      // exec — reuse, if a live holder is really there.
      const live = await this.aplexer.findSession(folder, tag);
      if (live) {
        return {
          ok: true,
          sessionName: tag,
          folder,
          reused: true,
          via: 'aplexer',
          aplexerId: live.id,
          error: null,
          code: null,
        };
      }
    }
    return failed('create-failed', created.error, { folder, via: 'aplexer' });
  }

  /** Helper-first, raw-tmux-fallback create — the desktop createSession. */
  private async createTmuxSession(
    name: string,
    cwd: string,
  ): Promise<{ ok: boolean; name: string | null; via: CreateSessionVia; error: string | null }> {
    const res = await this.execResult(pathAwareCommand(createSessionCommand(name, cwd)));
    if (res.exitCode === 0) {
      const printed = firstNonEmptyLine(res.stdout);
      return { ok: true, name: printed ?? name, via: 'helper', error: null };
    }
    const output = `${res.stdout}\n${res.stderr}`;
    if (!isHelperMissing(res.exitCode, output)) {
      const hostMessage =
        res.stderr.trim() || res.stdout.trim() || `sessions create exited ${res.exitCode}`;
      return { ok: false, name: null, via: 'helper', error: annotateHelperRejection(hostMessage, output) };
    }
    const fallback = await this.execResult(pathAwareCommand(fallbackCreateSessionCommand(name, cwd)));
    if (fallback.exitCode === 0) {
      return { ok: true, name, via: 'tmux-fallback', error: null };
    }
    return {
      ok: false,
      name: null,
      via: 'tmux-fallback',
      error:
        fallback.stderr.trim() ||
        fallback.stdout.trim() ||
        `tmux new-session exited ${fallback.exitCode}`,
    };
  }

  /** Rename — the aplexer tag alphabet first, then the tmux sweep + rename. */
  async renameSession(
    from: string,
    to: string,
    ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
  ): Promise<RenameSessionResult> {
    const target = sanitiseName(to);
    if (!/[A-Za-z0-9]/.test(target)) {
      return {
        ok: false,
        sessionName: null,
        error: `"${to.trim()}" cannot be a session name: only letters, digits, "_" and "-" survive.`,
        code: 'illegal-name',
      };
    }
    if (target === from) return { ok: true, sessionName: from, error: null, code: null };

    const aplexerId = await this.resolveAplexerId(from, ref);
    if (aplexerId !== null) {
      const records = await this.aplexer.snapshotRecords();
      const self = records.find((r) => r.id === aplexerId);
      if (!self) {
        return { ok: false, sessionName: null, error: 'That session is not running any more.', code: 'rename-failed' };
      }
      if (records.some((r) => r.id !== aplexerId && r.workspace === self.workspace && r.tag === target)) {
        return {
          ok: false,
          sessionName: null,
          error: `A session called "${target}" is already running on this host.`,
          code: 'name-taken',
        };
      }
      const renamed = await this.aplexer.renameSession(aplexerId, target);
      if (renamed.ok) return { ok: true, sessionName: target, error: null, code: null };
      if (renamed.notFound) {
        return { ok: false, sessionName: null, error: 'That session is not running any more.', code: 'rename-failed' };
      }
      return { ok: false, sessionName: null, error: renamed.error, code: 'rename-failed' };
    }

    const taken = await this.execResult(pathAwareCommand(sessionTakenAnywhereCommand(target)));
    if (taken.exitCode === 0) {
      return {
        ok: false,
        sessionName: null,
        error: `A session called "${target}" is already running on this host.`,
        code: 'name-taken',
      };
    }
    const renamed = await this.execResult(pathAwareCommand(renameSessionCommand(from, target)));
    if (renamed.exitCode !== 0) {
      const detail = renamed.stderr.trim() || renamed.stdout.trim();
      return { ok: false, sessionName: null, error: detail || `Could not rename "${from}".`, code: 'rename-failed' };
    }
    return { ok: true, sessionName: target, error: null, code: null };
  }

  /** Stop — aplexer by id, else the probe-then-kill tmux arm. */
  async killSession(
    name: string,
    ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
  ): Promise<KillSessionResult> {
    const aplexerId = await this.resolveAplexerId(name, ref);
    if (aplexerId !== null) {
      const killed = await this.aplexer.killSession(aplexerId);
      if (killed.ok) return { ok: true, error: null, code: null };
      if (killed.notFound) {
        return { ok: false, error: `"${name}" is not running on this host any more.`, code: 'not-found' };
      }
      return { ok: false, error: killed.error, code: 'kill-failed' };
    }
    const alive = await this.execResult(pathAwareCommand(sessionExistsCommand(name)));
    if (alive.exitCode !== 0) {
      return { ok: false, error: `"${name}" is not running on this host any more.`, code: 'not-found' };
    }
    const killed = await this.execResult(pathAwareCommand(killSessionCommand(name)));
    if (killed.exitCode !== 0) {
      const detail = killed.stderr.trim() || killed.stdout.trim();
      return { ok: false, error: detail || `Could not stop "${name}".`, code: 'kill-failed' };
    }
    return { ok: true, error: null, code: null };
  }

  /**
   * The aplexer UUID for [name], or null — explicit id, else workspace+tag,
   * else a bare-tag snapshot scan that resolves only when unambiguous.
   * Null deliberately routes to the tmux path in every failure direction.
   */
  private async resolveAplexerId(
    name: string,
    ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' },
  ): Promise<string | null> {
    if (!(await this.aplexer.isAvailable())) return null;
    if (ref?.aplexerId) return ref.aplexerId;
    const records = await this.aplexer.snapshotRecords();
    if (ref?.workspace) {
      return records.find((r) => r.workspace === ref.workspace && r.tag === name)?.id ?? null;
    }
    const holders = records.filter((r) => r.tag === name);
    return holders.length === 1 ? holders[0]!.id : null;
  }

  /** `cd … && pwd -P` — null when the directory could not be entered. */
  private async canonicalise(path: string): Promise<string | null> {
    const res = await this.execResult(pathAwareCommand(resolveDirectoryCommand(path)));
    if (res.exitCode !== 0) return null;
    return firstNonEmptyLine(res.stdout);
  }
}
