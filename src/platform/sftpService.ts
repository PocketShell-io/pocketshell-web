/**
 * The web's sftp group: the browser twin of the desktop's SftpService, over
 * the live connection's SFTP channel. The entry/type-classification rules
 * are the shared core (`sftpCore.ts` — toDirEntry), the caching rule is the
 * desktop's (one wrapper per connection; a failed acquisition un-caches so
 * the next call retries a fresh channel), and the never-throw-to-the-host
 * contract is the desktop's too: transport failures come back as thrown
 * Errors with sentences, exactly what the shared files store catches.
 *
 * The transfer pair (`upload`/`download` with localPath) is a desktop-filesystem
 * shape the shared UI never calls — the browser has no local paths — so the
 * group implements the surfaces the shared stores actually drive: list,
 * stat, editor reads/writes, the tree's file/folder operations, realPath,
 * binary reads for the viewer, and saveAs, which on the web means a real
 * browser download of a remote file.
 */
import { Buffer } from 'node:buffer';
import type { SFTPWrapper } from 'ssh2';
import type { DirEntry, FileStat } from '@pocketshell/core';
import { toDirEntry, formatBytes } from '@pocketshell/core';
import type { SshConnection } from '../terminal/connection';

/** The editor read ceiling — the desktop's own spirit: an unbounded read
 * into the tab's memory is the hazard, and the ceiling sits with the module
 * that knows what the bytes are for. */
export const MAX_TEXT_READ_BYTES = 500_000;

function sentence(err: unknown, path?: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'connection is not open') {
    return new Error('The connection to the host is down — reconnect to browse files.');
  }
  return new Error(path !== undefined ? `${path}: ${message}` : message);
}

export class SftpService {
  /** Cached per connection, exactly the desktop SftpService's rule. */
  private wrapper: Promise<SFTPWrapper> | null = null;

  constructor(private readonly conn: SshConnection) {}

  private acquire(): Promise<SFTPWrapper> {
    if (this.wrapper === null) {
      this.wrapper = this.conn.sftp().catch((err: unknown) => {
        this.wrapper = null;
        throw sentence(err);
      });
    }
    return this.wrapper;
  }

  /** Forget the cached channel — the connection store drops browsing state
   * on disconnect, and a stale wrapper must not survive a new dial. */
  evict(): void {
    this.wrapper = null;
  }

  async list(connectionId: string, path: string): Promise<DirEntry[]> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      const raw = await new Promise<Array<{ filename: string; longname: string; attrs: object }>>(
        (resolve, reject) => {
          sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
        },
      );
      return raw
        .filter((item) => item.filename !== '.' && item.filename !== '..')
        .map((item) => toDirEntry({ ...item.attrs, longname: item.longname }, item.filename));
    } catch (e) {
      throw sentence(e, path);
    }
  }

  async stat(connectionId: string, path: string): Promise<FileStat> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
        sftp.stat(path, (err, value) => (err ? reject(err) : resolve(value)));
      });
      const longname = '';
      return {
        type: toDirEntry({ ...stats, longname }, path).type,
        size: stats.size,
        modifyTime: stats.mtime * 1000,
        accessTime: stats.atime * 1000,
      };
    } catch (e) {
      throw sentence(e, path);
    }
  }

  /** Read a TEXT file for the editor: capped, NUL-sniffed so a binary comes
   * back as a sentence instead of mojibake in a textarea. */
  async readFile(connectionId: string, path: string): Promise<string> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
        sftp.stat(path, (err, value) => (err ? reject(err) : resolve(value)));
      });
      if (stats.size > MAX_TEXT_READ_BYTES) {
        throw new Error(
          `Too large to edit: ${path} is ${formatBytes(stats.size)} — the editor caps at ${formatBytes(MAX_TEXT_READ_BYTES)}.`,
        );
      }
      const buf = await this.readStream(sftp, path);
      if (buf.subarray(0, 8192).includes(0)) {
        throw new Error(`Not a text file: ${path} — the editor opens text only.`);
      }
      return buf.toString('utf8');
    } catch (e) {
      throw sentence(e, path);
    }
  }

  /** Binary read for the viewer, capped by the caller's budget. */
  async readBinary(connectionId: string, path: string, maxBytes?: number): Promise<Uint8Array> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      const cap = maxBytes ?? 20_000_000;
      const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
        sftp.stat(path, (err, value) => (err ? reject(err) : resolve(value)));
      });
      if (stats.size > cap) {
        throw new Error(`${path} is ${formatBytes(stats.size)} — larger than the ${formatBytes(cap)} preview cap.`);
      }
      return new Uint8Array(await this.readStream(sftp, path));
    } catch (e) {
      throw sentence(e, path);
    }
  }

  /** Overwrite by contract — the pane only saves buffers the user opened on
   * purpose, the same sentence the desktop's writeFile wears. */
  async writeFile(connectionId: string, path: string, content: string): Promise<boolean> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(path);
        stream.on('error', reject);
        stream.on('close', () => resolve());
        stream.end(Buffer.from(content, 'utf8'));
      });
      return true;
    } catch (e) {
      throw sentence(e, path);
    }
  }

  async createFile(connectionId: string, path: string, content?: string): Promise<boolean> {
    await this.writeFile(connectionId, path, content ?? '');
    return true;
  }

  /** Byte-exact write for staged attachments — no text encoding round trip. */
  async writeBinary(connectionId: string, path: string, bytes: Uint8Array): Promise<void> {
    void connectionId;
    const sftp = await this.acquire();
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path);
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(Buffer.from(bytes));
    });
  }

  /** mkdir that tolerates an existing directory — the recursion primitive
   * the attachment stager builds its remote layout with. */
  async mkdirFresh(connectionId: string, path: string): Promise<boolean> {
    void connectionId;
    const sftp = await this.acquire();
    return new Promise((resolve) => {
      sftp.mkdir(path, (err) => resolve(!err));
    });
  }

  async mkdir(connectionId: string, path: string): Promise<boolean> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
      });
      return true;
    } catch (e) {
      throw sentence(e, path);
    }
  }

  async rename(connectionId: string, fromPath: string, toPath: string): Promise<boolean> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      await new Promise<void>((resolve, reject) => {
        sftp.rename(fromPath, toPath, (err) => (err ? reject(err) : resolve()));
      });
      return true;
    } catch (e) {
      throw sentence(e, fromPath);
    }
  }

  async deleteFile(connectionId: string, path: string): Promise<boolean> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(path, (err) => (err ? reject(err) : resolve()));
      });
      return true;
    } catch (e) {
      throw sentence(e, path);
    }
  }

  async rmdir(connectionId: string, path: string): Promise<boolean> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      await new Promise<void>((resolve, reject) => {
        sftp.rmdir(path, (err) => (err ? reject(err) : resolve()));
      });
      return true;
    } catch (e) {
      throw sentence(e, path);
    }
  }

  async realPath(connectionId: string, path: string): Promise<string> {
    void connectionId;
    try {
      const sftp = await this.acquire();
      return await new Promise<string>((resolve, reject) => {
        sftp.realpath(path, (err, value) => (err ? reject(err) : resolve(value)));
      });
    } catch (e) {
      throw sentence(e, path);
    }
  }

  /**
   * Download a remote file to the user's machine — the browser's shape of
   * "save as": the bytes come down the connection, the browser's picker
   * decides where they land. Returns the file name handed to the browser,
   * or null when the user cancelled the dialog.
   */
  async saveAs(payload: { connectionId: string; remotePath: string }): Promise<string | null> {
    const bytes = await this.readBinary(payload.connectionId, payload.remotePath);
    const name = payload.remotePath.slice(payload.remotePath.lastIndexOf('/') + 1) || 'download';
    // An <a download> click is the one way to hand the browser a body it did
    // not fetch itself; the revoke is delayed so the write has landed.
    const blob = new Blob([bytes as BlobPart]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }

  // --- the desktop-local transfer surfaces the web does not have -----------
  // `upload`/`download` take LOCAL paths (the desktop main reads the user's
  // disk); the browser has no such paths and the shared stores never call
  // them, so they refuse loudly rather than pretend.
  async upload(): Promise<boolean> {
    throw new Error('sftp.upload needs a local file path — not available in the browser');
  }

  async download(): Promise<boolean> {
    throw new Error('sftp.download needs a local file path — not available in the browser');
  }

  onProgress(): () => void {
    // Transfers are synchronous-with-the-call here; no progress events exist.
    return () => {};
  }

  // --- internals -----------------------------------------------------------

  private readStream(sftp: SFTPWrapper, path: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(path);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
}
