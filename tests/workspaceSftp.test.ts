import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { WorkspaceSftp, MAX_TEXT_READ_BYTES } from '../src/workspace/sftp';
import { HostWorkspaceController, type WorkspaceLink } from '../src/workspace/controller';

// The Files pane's transport, against a fake SFTPWrapper speaking ssh2's
// callback + stream shapes. The contract under test: every host "no" comes
// back as a SENTENCE (never a throw), the read cap bites BEFORE the read,
// binaries are refused instead of mojibake'd, and a failed channel is
// re-acquired on the next call (the desktop SftpService's caching rule).

interface FakeFile {
  kind: 'dir' | 'file';
  content?: string;
  longnamePrefix?: string;
}

class FakeSftp {
  files = new Map<string, FakeFile>();
  /** Errors thrown by the NEXT sftp() acquisition, in order. */
  acquireFailures: Error[] = [];
  private acquired = 0;

  entriesOf(dir: string) {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return [...this.files.entries()]
      .filter(([p, f]) => p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, f]) => ({
        filename: p.slice(prefix.length),
        longname: `${f.longnamePrefix ?? (f.kind === 'dir' ? 'd' : '-')}rw-r--r--`,
        attrs: {
          isDirectory: f.longnamePrefix === 'F'
            ? () => {
                // The browser's ssh2 Stats helpers read fs constants the
                // bundle lacks — calling them THROWS (seen in pixels, rig
                // shot 20). The module must survive that.
                throw new TypeError("Cannot read properties of undefined (reading 'S_IFMT')");
              }
            : () => f.kind === 'dir',
          size: (f.content ?? '').length,
          mtime: 1_728_000_000,
        },
      }));
  }

  wrapper() {
    const self = this;
    if (this.acquireFailures.length > 0) {
      const failure = this.acquireFailures.shift()!;
      this.acquired += 1;
      throw failure;
    }
    this.acquired += 1;
    return {
      realpath: (p: string, cb: (e: Error | null, r?: string) => void) =>
        cb(null, p === '.' ? '/home/testuser' : p),
      readdir: (p: string, cb: (e: Error | null, list?: ReturnType<FakeSftp['entriesOf']>) => void) => {
        const dir = self.files.get(p);
        if (dir?.kind !== 'dir') cb(new Error('No such file'));
        else cb(null, self.entriesOf(p));
      },
      stat: (p: string, cb: (e: Error | null, stats?: { size: number }) => void) => {
        const f = self.files.get(p);
        if (f?.kind !== 'file') cb(new Error('No such file'));
        else cb(null, { size: (f.content ?? '').length });
      },
      createReadStream(p: string) {
        const f = self.files.get(p);
        if (f?.kind !== 'file') {
          return streamOf(new Error('No such file'));
        }
        return streamOf(Buffer.from(f.content ?? '', 'utf8'));
      },
      createWriteStream(p: string) {
        return {
          on(evt: string, cb: () => void) {
            if (evt === 'close') queueMicrotask(cb);
          },
          end(b: Buffer) {
            const f = self.files.get(p);
            if (f) f.content = b.toString('utf8');
          },
        };
      },
    };
  }
}

function streamOf(payload: Buffer | Error) {
  return {
    on(evt: string, cb: (x?: unknown) => void) {
      if (payload instanceof Error) {
        if (evt === 'error') queueMicrotask(() => cb(payload));
        return;
      }
      if (evt === 'data') queueMicrotask(() => cb(payload));
      if (evt === 'end') queueMicrotask(() => cb());
    },
  };
}

function fakeConnection(sftp: FakeSftp): { sftp(): Promise<unknown> } {
  return {
    sftp() {
      try {
        return Promise.resolve(sftp.wrapper());
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}

const HOME_FILES = () => {
  const sftp = new FakeSftp();
  sftp.files.set('/home/testuser', { kind: 'dir' });
  sftp.files.set('/home/testuser/demo', { kind: 'dir' });
  sftp.files.set('/home/testuser/notes.md', { kind: 'file', content: '# hello\n' });
  sftp.files.set('/home/testuser/tool', { kind: 'file', content: '\u0000ELF', longnamePrefix: '-' });
  sftp.files.set('/home/testuser/link', { kind: 'file', longnamePrefix: 'l' });
  sftp.files.set('/home/testuser/.bashrc', { kind: 'file', content: 'export PS1=1\n' });
  return sftp;
};

describe('WorkspaceSftp', () => {
  it('home() resolves the login directory', async () => {
    const s = new WorkspaceSftp(fakeConnection(new FakeSftp()) as never);
    const out = await s.home();
    expect(out).toEqual({ ok: true, value: '/home/testuser' });
  });

  it('list() normalizes entries: dots dropped, type from longname', async () => {
    const fake = HOME_FILES();
    fake.files.set('/home/testuser/sock', { kind: 'file', longnamePrefix: 'F' });
    const s = new WorkspaceSftp(fakeConnection(fake) as never);
    const out = await s.list('/home/testuser');
    if (!out.ok) throw new Error(out.error);
    const names = out.value.map((e) => e.name).sort();
    expect(names).toEqual(['.bashrc', 'demo', 'link', 'notes.md', 'sock', 'tool']);
    const byName = Object.fromEntries(out.value.map((e) => [e.name, e]));
    expect(byName['demo']?.type).toBe('dir');
    expect(byName['notes.md']?.type).toBe('file');
    expect(byName['link']?.type).toBe('symlink');
    // An unknown longname whose Stats helper throws (no fs constants in the
    // browser) degrades to 'other' instead of killing the listing.
    expect(byName['sock']?.type).toBe('other');
  });

  it('list() of a missing directory is a sentence naming the path', async () => {
    const s = new WorkspaceSftp(fakeConnection(new FakeSftp()) as never);
    const out = await s.list('/home/testuser/nope');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('/home/testuser/nope');
  });

  it('readText() returns file contents', async () => {
    const fake = HOME_FILES();
    const s = new WorkspaceSftp(fakeConnection(fake) as never);
    const out = await s.readText('/home/testuser/notes.md');
    expect(out).toEqual({ ok: true, value: '# hello\n' });
  });

  it('readText() refuses an oversize file BEFORE reading it', async () => {
    const fake = new FakeSftp();
    fake.files.set('/home/testuser', { kind: 'dir' });
    fake.files.set('/home/testuser/big.log', { kind: 'file', content: 'x'.repeat(MAX_TEXT_READ_BYTES + 1) });
    const s = new WorkspaceSftp(fakeConnection(fake) as never);
    const out = await s.readText('/home/testuser/big.log');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Too large to edit/);
  });

  it('readText() refuses a binary instead of mojibaking it', async () => {
    const fake = HOME_FILES();
    const s = new WorkspaceSftp(fakeConnection(fake) as never);
    const out = await s.readText('/home/testuser/tool');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Not a text file/);
  });

  it('writeFile() overwrites by contract', async () => {
    const fake = HOME_FILES();
    const s = new WorkspaceSftp(fakeConnection(fake) as never);
    const out = await s.writeFile('/home/testuser/notes.md', '# rewritten\n');
    expect(out).toEqual({ ok: true, value: true });
    expect(fake.files.get('/home/testuser/notes.md')?.content).toBe('# rewritten\n');
  });

  it('a failed channel acquisition is retried on the next call', async () => {
    const fake = HOME_FILES();
    fake.acquireFailures.push(new Error('channel open refused'));
    const s = new WorkspaceSftp(fakeConnection(fake) as never);
    const first = await s.list('/home/testuser');
    expect(first.ok).toBe(false);
    const second = await s.list('/home/testuser');
    expect(second.ok).toBe(true);
  });

  it('a down connection speaks in reconnect sentences, not ssh2 error codes', async () => {
    const conn = {
      sftp() {
        return Promise.reject(new Error('connection is not open'));
      },
    };
    const s = new WorkspaceSftp(conn as never);
    const out = await s.list('/home/testuser');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/reconnect/);
  });
});

describe('controller Files tab', () => {
  const LINK: WorkspaceLink = {
    url: 'ws://relay.test',
    idToken: 'tok',
    host: 'hetzner.test',
    port: 22,
    user: 'alexey',
    auth: { kind: 'password', password: 'pw' },
  };

  function controller(): HostWorkspaceController {
    return new HostWorkspaceController({
      link: LINK,
      makeConnection: () => ({}) as never,
      pollMs: 3_600_000,
    });
  }

  it('openFilesTab adds one Files tab and focuses it, without a PTY', () => {
    const c = controller();
    c.openFilesTab();
    c.openFilesTab();
    expect(c.state.tabs.filter((t) => t.key === 'files')).toHaveLength(1);
    expect(c.state.activeKey).toBe('files');
    const tab = c.state.tabs[0];
    expect(tab?.label).toBe('Files');
    expect(tab?.live).toBe(false);
  });

  it('the Files tab closes like any other', () => {
    const c = controller();
    c.openFilesTab();
    c.closeTab('files');
    expect(c.state.tabs).toHaveLength(0);
    expect(c.state.activeKey).toBeNull();
  });
});
