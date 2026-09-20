/**
 * SFTP over the workspace's live connection — the browser twin of the
 * desktop's SftpService: one SFTPWrapper cached per connection, promise
 * operations, and the desktop's contract that a host "no" comes back as a
 * value, never a throw. Missing on purpose: the desktop's binary and
 * create-with-`wx` verbs — the web pane edits text files it opened on
 * purpose, and anything bigger is refused before the read.
 *
 * The transport only exists on the direct path (the browser speaks SSH
 * itself); a bridge-mode host has no SFTP and the pane says so.
 */
import type { SFTPWrapper } from 'ssh2';
import { Buffer } from 'node:buffer';
import type { SshConnection } from '../terminal/connection';

export interface SftpDirEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'other';
  size: number;
  /** Epoch ms, from the entry's attrs. */
  modifyTime: number;
}

export type SftpResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The editor's read ceiling, in the same spirit as the desktop's required
 * `maxBytes`: an unbounded read into the tab's memory is the hazard, and the
 * ceiling sits with the module that knows what the bytes are for. 500 KB of
 * text is already an outlier for an edit-in-place.
 */
export const MAX_TEXT_READ_BYTES = 500_000;

export class WorkspaceSftp {
  /** Cached per connection, exactly the desktop SftpService's rule; a failed
   * acquisition un-caches so the next call retries a fresh channel. */
  private wrapper: Promise<SFTPWrapper> | null = null;

  constructor(private readonly conn: SshConnection) {}

  /** The user's home directory on the host — the pane's start path. */
  async home(): Promise<SftpResult<string>> {
    try {
      const sftp = await this.acquire();
      return { ok: true, value: await new Promise<string>((resolve, reject) => {
        sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p)));
      }) };
    } catch (e) {
      return { ok: false, error: sentence(e) };
    }
  }

  async list(path: string): Promise<SftpResult<SftpDirEntry[]>> {
    try {
      const sftp = await this.acquire();
      const raw = await new Promise<Array<{ filename: string; longname: string; attrs: { isDirectory(): boolean; size: number; mtime: number } }>>((resolve, reject) => {
        sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
      });
      const entries = raw
        .filter((item) => item.filename !== '.' && item.filename !== '..')
        .map((item) => ({
          name: item.filename,
          type: entryType(item.longname, item.attrs),
          size: item.attrs.size,
          modifyTime: item.attrs.mtime * 1000,
        }));
      return { ok: true, value: entries };
    } catch (e) {
      return { ok: false, error: sentence(e, path) };
    }
  }

  /** Read a TEXT file for the editor: capped, and NUL-sniffed so a binary
   * comes back as a sentence instead of mojibake in a textarea. */
  async readText(path: string): Promise<SftpResult<string>> {
    try {
      const sftp = await this.acquire();
      const size = await new Promise<number>((resolve, reject) => {
        sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats.size)));
      });
      if (size > MAX_TEXT_READ_BYTES) {
        return { ok: false, error: `Too large to edit: ${path} is ${Math.ceil(size / 1000)} KB — the editor caps at ${Math.floor(MAX_TEXT_READ_BYTES / 1000)} KB.` };
      }
      const buf = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(path);
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
      if (buf.subarray(0, 8192).includes(0)) {
        return { ok: false, error: `Not a text file: ${path} — the editor opens text only.` };
      }
      return { ok: true, value: buf.toString('utf8') };
    } catch (e) {
      return { ok: false, error: sentence(e, path) };
    }
  }

  /** Overwrite by contract — the pane only saves buffers the user opened on
   * purpose, the same sentence the desktop's writeFile wears. */
  async writeFile(path: string, content: string): Promise<SftpResult<true>> {
    try {
      const sftp = await this.acquire();
      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(path);
        stream.on('error', reject);
        stream.on('close', () => resolve());
        stream.end(Buffer.from(content, 'utf8'));
      });
      return { ok: true, value: true };
    } catch (e) {
      return { ok: false, error: sentence(e, path) };
    }
  }

  private acquire(): Promise<SFTPWrapper> {
    if (this.wrapper === null) {
      this.wrapper = this.conn.sftp().catch((err: unknown) => {
        this.wrapper = null;
        throw err;
      });
    }
    return this.wrapper;
  }
}

/** Type from the longname's ls-style first character (OpenSSH always sends
 * it). The attrs fallback is guarded: ssh2's Stats helpers read fs constants
 * the browser bundle does not have, and calling one throws. */
function entryType(longname: string, attrs: { isDirectory?: () => boolean }): SftpDirEntry['type'] {
  if (longname.startsWith('d')) return 'dir';
  if (longname.startsWith('l')) return 'symlink';
  if (longname.startsWith('-')) return 'file';
  try {
    if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) return 'dir';
  } catch {
    // no fs constants in the browser — the longname already told us enough
  }
  return 'other';
}

/** ssh2's transport errors are terse ("No such file") — name the path that
 * produced them, and the connection state when there is no channel at all. */
function sentence(err: unknown, path?: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'connection is not open') return 'The connection to the host is down — reconnect to browse files.';
  return path !== undefined ? `${path}: ${message}` : message;
}
