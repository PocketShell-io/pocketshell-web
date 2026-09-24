/**
 * The web's attachments group: the browser twin of the desktop's
 * AttachmentStager upload pipeline (sanitise -> upload), landing files in
 * the SAME remote layout — `~/.pocketshell/attachments/<scope>/<ts>-<NN>-<name>`
 * — so a prompt attachment reads identically on every client. The desktop's
 * retention pruner is a best-effort extra the web does not run yet.
 *
 * `pickFiles` uses a real file input (the browser's picker); the picked
 * Files are held in memory so `readLocal` can hand their bytes back without
 * a local path ever existing — the desktop's `kind: 'file'` variant becomes
 * `kind: 'bytes'` the moment the user picks.
 */
import type { AttachmentSource, StageAttachmentsResult } from '@pocketshell/core';
import { extensionForMimeType, extensionOfPath } from '@pocketshell/core/attachments/mimeTypes';
import type { SftpService } from './sftpService';

/** Remote directory, relative to the user's home — the desktop's constant. */
const REMOTE_DIRECTORY = '.pocketshell/attachments';

/** The desktop's scope-path rule: each `/`-segment folds to `[a-z0-9_-]`,
 * `..` folds away, blank segments disappear, `session` when nothing survives. */
export function safeScopePath(scopeKey: string): string {
  const segments = scopeKey
    .split('/')
    .map(foldScopeSegment)
    .filter((s) => s !== '');
  return segments.length > 0 ? segments.join('/') : 'session';
}

function foldScopeSegment(scopeKey: string): string {
  let cleaned = '';
  for (const ch of scopeKey) {
    if (ch >= 'A' && ch <= 'Z') cleaned += ch.toLowerCase();
    else if (ch >= 'a' && ch <= 'z') cleaned += ch;
    else if (ch >= '0' && ch <= '9') cleaned += ch;
    else if (ch === '-' || ch === '_') cleaned += ch;
    else cleaned += '-';
  }
  cleaned = cleaned.replace(/-+/g, '-');
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned[start] === '-') start++;
  while (end > start && cleaned[end - 1] === '-') end--;
  return cleaned.slice(start, end).slice(0, 80);
}

/** `yyyyMMdd-HHmmss` local-time, matching the desktop's display scheme. */
function formatAttachmentTimestamp(epochMillis: number): string {
  const d = new Date(epochMillis);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/** The display name a source uploads under: its own, else the mime-defaulted
 * extension fallback for the one case that arrives nameless (a paste). */
function displayNameOf(source: AttachmentSource): string {
  const raw = source.name ?? '';
  if (raw !== '') return raw;
  const ext =
    source.mimeType != null
      ? (extensionForMimeType(source.mimeType) ?? extensionOfPath(`x.${source.mimeType.split('/')[1] ?? ''}`))
      : null;
  return ext ? `attachment.${ext}` : 'attachment';
}

export class WebAttachments {
  /** The picked Files, by the handle string pickFiles returned. */
  private readonly picked = new Map<string, File>();
  private nextHandle = 1;

  constructor(private readonly sftp: SftpService) {}

  /** The browser's file picker. The input is created on demand so the
   * user gesture stays the one that opens it. */
  pickFiles(payload?: { title?: string; multiple?: boolean }): Promise<string[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (payload?.multiple !== false) input.multiple = true;
      input.onchange = () => {
        const handles: string[] = [];
        for (const file of Array.from(input.files ?? [])) {
          const handle = `pick-${this.nextHandle++}`;
          this.picked.set(handle, file);
          handles.push(handle);
        }
        resolve(handles);
      };
      input.oncancel = () => resolve([]);
      input.click();
    });
  }

  /** The bytes behind a pick handle — the web's `kind: 'bytes'` bridge. */
  async readLocal(handle: string): Promise<Uint8Array> {
    const file = this.picked.get(handle);
    if (!file) throw new Error(`No picked file "${handle}" in this session.`);
    return new Uint8Array(await file.arrayBuffer());
  }

  /**
   * Upload sources into `~/.pocketshell/attachments/<safeScope>/` and return
   * the tilde-form display paths, in source order, with the desktop's
   * partial-failure contract: survivors come back even when `ok` is false.
   * Never rejects.
   */
  async stage(payload: {
    connectionId: string;
    scopeKey: string;
    sources: AttachmentSource[];
  }): Promise<StageAttachmentsResult> {
    const sources = payload.sources;
    if (sources.length === 0) return { ok: true, paths: [], failedCount: 0 };
    void payload.connectionId;

    const safeScope = safeScopePath(payload.scopeKey);
    const remoteDir = `${REMOTE_DIRECTORY}/${safeScope}`;
    const displayDir = `~/${remoteDir}`;

    try {
      // SFTP has no tilde expansion: resolve home once, address absolutely.
      const home = await this.sftp.realPath(payload.connectionId, '.');
      const absoluteDir = `${home.replace(/\/+$/, '')}/${remoteDir}`;
      // mkdir -p over the shell is the recursion the desktop spreads over
      // SFTP; one exec is the same end state.
      await this.mkdirp(absoluteDir);

      const timestamp = formatAttachmentTimestamp(Date.now());
      const uploadedPaths: string[] = [];
      let failedCount = 0;
      let firstError: string | null = null;
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index]!;
        try {
          const name = displayNameOf(source);
          const remoteName = `${timestamp}-${String(index + 1).padStart(2, '0')}-${name}`;
          const bytes =
            source.kind === 'bytes' ? source.data : await this.readLocal(source.path);
          const target = `${absoluteDir}/${remoteName}`;
          // Text-vs-binary: write bytes as bytes — a latin1 round trip would
          // corrupt every non-text payload.
          await this.sftp.writeBinary(payload.connectionId, target, bytes);
          uploadedPaths.push(`${displayDir}/${remoteName}`);
        } catch (err) {
          failedCount++;
          if (firstError === null) {
            firstError = err instanceof Error ? err.message : String(err);
          }
        }
      }
      if (failedCount === 0) return { ok: true, paths: uploadedPaths, failedCount: 0 };
      if (uploadedPaths.length === 0) {
        return {
          ok: false,
          paths: [],
          failedCount,
          error: `Attachment upload failed: ${firstError ?? 'every file failed'}`,
        };
      }
      return {
        ok: false,
        paths: uploadedPaths,
        failedCount,
        error: `Attached ${uploadedPaths.length} of ${sources.length} files; ${failedCount} failed.`,
      };
    } catch (err) {
      return {
        ok: false,
        paths: [],
        failedCount: sources.length,
        error: `Attachment upload failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async mkdirp(absoluteDir: string): Promise<void> {
    // The directories are app-managed (scope-folded names), so building the
    // mkdir chain from the resolved absolute path is safe. EEXIST is the
    // ordinary answer mid-chain.
    const parts = absoluteDir.split('/').filter((p) => p !== '');
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      await this.sftp.mkdirFresh('__web__', cur);
    }
  }
}
