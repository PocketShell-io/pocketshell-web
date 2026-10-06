/**
 * The browser link transport, end to end without a browser: LinkSshConnection
 * dials a canned in-process link host (the same protocol the real daemon
 * speaks — the CLI's loopback suite and the desktop's docker suite own the
 * daemon's side). Exec, stderr separation, exec stdin, the PTY echo loop,
 * and the typed rejections are each driven through the exact surface the
 * workspace services use.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { LinkSshConnection } from '../src/terminal/linkConnection';

const TOKEN = 'web-test-token';

/** One canned link host: exec by command shape, echo PTYs, ghost-host
 * rejection. Channel ids are accepted verbatim (single client). */
async function startFakeLinkHost(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ port: 0 });
  const sockets = new Set<WebSocket>();
  let relayUrl = '';
  wss.on('listening', () => {
    const addr = wss.address();
    if (typeof addr === 'object' && addr !== null) {
      relayUrl = `ws://127.0.0.1:${addr.port}`;
    }
  });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    let ready = false;
    const execChannels = new Map<number, { stdin: Buffer[] }>();
    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        const channel = typeof frame.ch === 'number' ? frame.ch : null;
        if (frame.t === 'hello') {
          if (frame.host_id === 'ghost') {
            ws.send(JSON.stringify({ v: 1, t: 'error', code: 'HOST_OFFLINE', message: 'not paired' }));
            return;
          }
          ready = true;
          ws.send(JSON.stringify({ v: 1, t: 'ready', host_name: 'Fake Laptop' }));
          return;
        }
        if (!ready) return;
        if (frame.t === 'open' && channel !== null) {
          const mode = frame.mode;
          if (mode === 'exec') {
            const cmd = String(frame.cmd ?? '');
            if (cmd === 'spawn-fail') {
              ws.send(JSON.stringify({ v: 1, t: 'opened', ch: channel, ok: false, code: 'EXEC_SPAWN_FAILED', message: 'no such binary' }));
              return;
            }
            const entry = { stdin: [] as Buffer[] };
            execChannels.set(channel, entry);
            ws.send(JSON.stringify({ v: 1, t: 'opened', ch: channel, ok: true, err_ch: channel + 0x40000000 }));
            if (cmd.startsWith('echo ')) {
              const text = cmd.slice(5) + '\n';
              const data = Buffer.alloc(4 + Buffer.byteLength(text));
              data.writeUInt32BE(channel, 0);
              data.write(text, 4);
              ws.send(data);
              ws.send(JSON.stringify({ v: 1, t: 'exit', ch: channel, exit_code: 0 }));
            } else if (cmd === 'out-err') {
              const out = Buffer.alloc(4 + 4);
              out.writeUInt32BE(channel, 0);
              out.write('out\n', 4);
              const err = Buffer.alloc(4 + 4);
              err.writeUInt32BE(channel + 0x40000000, 0);
              err.write('err\n', 4);
              ws.send(out);
              ws.send(err);
              ws.send(JSON.stringify({ v: 1, t: 'exit', ch: channel, exit_code: 7 }));
            }
            // `cat` waits for client stdin (data frames + eof).
          } else if (mode === 'pty') {
            ws.send(JSON.stringify({ v: 1, t: 'opened', ch: channel, ok: true }));
          }
          return;
        }
        if (frame.t === 'eof' && channel !== null) {
          // exec stdin EOF: echo what arrived, exit 0.
          const entry = execChannels.get(channel);
          if (entry !== undefined) {
            const bytes = Buffer.concat(entry.stdin);
            const data = Buffer.alloc(4 + bytes.length);
            data.writeUInt32BE(channel, 0);
            bytes.copy(data, 4);
            ws.send(data);
            ws.send(JSON.stringify({ v: 1, t: 'exit', ch: channel, exit_code: 0 }));
            execChannels.delete(channel);
          }
          return;
        }
        return;
      }
      // Binary: u32BE channel | payload. PTY channels echo; exec feeds stdin.
      const channel = raw.readUInt32BE(0);
      const payload = raw.subarray(4);
      const exec = execChannels.get(channel);
      if (exec !== undefined) {
        exec.stdin.push(payload);
        return;
      }
      const data = Buffer.alloc(4 + payload.length);
      data.writeUInt32BE(channel, 0);
      payload.copy(data, 4);
      ws.send(data);
    });
    ws.on('close', () => sockets.delete(ws));
  });
  await vi.waitFor(() => expect(relayUrl).not.toBe(''), { timeout: 5_000 });
  return {
    url: relayUrl,
    close: async () => {
      for (const ws of sockets) ws.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

import { vi } from 'vitest';

describe('LinkSshConnection', () => {
  let host: Awaited<ReturnType<typeof startFakeLinkHost>>;

  beforeAll(async () => {
    host = await startFakeLinkHost();
  });

  afterAll(async () => {
    await host?.close();
  });

  it('connects, execs, and collects stdout with the exit code', async () => {
    const conn = new LinkSshConnection();
    await conn.connect({ link: { relayUrl: host.url, hostId: 'fake-laptop' }, linkToken: TOKEN });
    const res = await conn.exec('echo LINK-WEB-OK');
    expect(res.error).toBeNull();
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('LINK-WEB-OK\n');
    conn.close();
  });

  it('separates stderr and reports non-zero exits without throwing', async () => {
    const conn = new LinkSshConnection();
    await conn.connect({ link: { relayUrl: host.url, hostId: 'fake-laptop' }, linkToken: TOKEN });
    const res = await conn.exec('out-err');
    expect(res.exitCode).toBe(7);
    expect(res.stdout).toBe('out\n');
    expect(res.stderr).toBe('err\n');
    conn.close();
  });

  it('pipes exec stdin to the command (the env-set contract)', async () => {
    const conn = new LinkSshConnection();
    await conn.connect({ link: { relayUrl: host.url, hostId: 'fake-laptop' }, linkToken: TOKEN });
    const res = await conn.exec('cat', { stdin: 'env-set-web-secret' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('env-set-web-secret');
    conn.close();
  });

  it('streams a PTY both ways and reports exit on eof', async () => {
    const conn = new LinkSshConnection();
    await conn.connect({ link: { relayUrl: host.url, hostId: 'fake-laptop' }, linkToken: TOKEN });
    const seen: Uint8Array[] = [];
    let exited = false;
    const channel = await conn.openPty({
      onData: (bytes) => seen.push(bytes),
      onExit: () => {
        exited = true;
      },
      onError: () => undefined,
    });
    channel.write('ping-through-link');
    await vi.waitFor(() => {
      expect(Buffer.concat(seen).toString('utf8')).toContain('ping-through-link');
    }, { timeout: 10_000 });
    channel.resize(120, 40);
    channel.close();
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 10_000 });
    conn.close();
  });

  it('surfaces HOST_OFFLINE as a connect failure', async () => {
    const conn = new LinkSshConnection();
    await expect(
      conn.connect({ link: { relayUrl: host.url, hostId: 'ghost' }, linkToken: TOKEN }),
    ).rejects.toThrow(/not paired|HOST_OFFLINE/i);
  });

  it('rejects SFTP with the typed link message', async () => {
    const conn = new LinkSshConnection();
    await conn.connect({ link: { relayUrl: host.url, hostId: 'fake-laptop' }, linkToken: TOKEN });
    await expect(conn.sftp()).rejects.toThrow('SFTP is not available over the link transport.');
    conn.close();
  });

  it('returns a connection error for exec after close', async () => {
    const conn = new LinkSshConnection();
    await conn.connect({ link: { relayUrl: host.url, hostId: 'fake-laptop' }, linkToken: TOKEN });
    conn.close();
    const res = await conn.exec('echo nope');
    expect(res.exitCode).toBeNull();
    expect(res.error).toBe('connection is not open');
  });
});
