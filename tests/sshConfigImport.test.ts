import { describe, expect, it } from 'vitest';
import { parseSshConfigText } from '../src/sshConfigImport';

// The web twin of the desktop's SshConfigParser: same directive subset and
// folding rules, minus what a browser tab cannot do (Include, ~ expansion)
// and minus host patterns, which the bridge could never dial.

describe('parseSshConfigText', () => {
  it('parses the directives the desktop supports into full entries', () => {
    const { hosts, skippedPatterns, noHosts } = parseSshConfigText(`
      # a comment
      Host prod-box
        HostName prod.example.com
        Port 2222
        User deploy
        IdentityFile ~/.ssh/id_ed25519
        ProxyJump bastion
        ForwardAgent yes
        LocalForward 5432 db.internal:5432
        RemoteForward 8080 localhost:80

      Host staging
        HostName staging.example.com
    `);
    expect(skippedPatterns).toBe(0);
    expect(noHosts).toBe(false);
    expect(hosts.map((h) => h.entry.name)).toEqual(['prod-box', 'staging']);
    const prod = hosts[0]!.entry;
    expect(prod.hostname).toBe('prod.example.com');
    expect(prod.port).toBe(2222);
    expect(prod.user).toBe('deploy');
    expect(prod.identityFile).toBe('~/.ssh/id_ed25519');
    expect(prod.proxyJump).toBe('bastion');
    expect(prod.forwardAgent).toBe(true);
    expect(prod.fromConfig).toBe(true);
    expect(prod.localForwards).toEqual([
      { kind: 'local', listenHost: '127.0.0.1', listenPort: 5432, destHost: 'db.internal', destPort: 5432 },
    ]);
    expect(prod.remoteForwards).toEqual([
      { kind: 'remote', listenHost: '127.0.0.1', listenPort: 8080, destHost: 'localhost', destPort: 80 },
    ]);
  });

  it('defaults what the config leaves out and applies directives case-insensitively', () => {
    const { hosts } = parseSshConfigText('HOST bare\n  HOSTNAME bare.internal\n  port not-a-number');
    const [entry] = hosts.map((h) => h.entry);
    expect(entry).toMatchObject({ name: 'bare', hostname: 'bare.internal', port: 22, user: '', identityFile: null });
  });

  it('creates one entry per name on a Host line, defaulting HostName to the name', () => {
    const { hosts } = parseSshConfigText('Host a b\n  User root');
    expect(hosts.map((h) => h.entry.name)).toEqual(['a', 'b']);
    for (const { entry } of hosts) {
      expect(entry.hostname).toBe(entry.name);
      expect(entry.user).toBe('root');
    }
  });

  it('skips host patterns and counts them instead of importing unconnectable rows', () => {
    const { hosts, skippedPatterns } = parseSshConfigText(`
      Host *.example.com !safe.example.com
        User joker
      Host real
        HostName real.example.com
    `);
    expect(hosts.map((h) => h.entry.name)).toEqual(['real']);
    expect(skippedPatterns).toBe(2);
  });

  it('ignores Include (no filesystem in a browser) and global options before any Host', () => {
    const { hosts } = parseSshConfigText(`
      Include ~/.ssh/conf.d/*
      Compression yes
      Host yes
        HostName yes.example.com
    `);
    expect(hosts.map((h) => h.entry.name)).toEqual(['yes']);
  });

  it('reports an unparseable text instead of offering an empty selection', () => {
    expect(parseSshConfigText('')).toEqual({ hosts: [], skippedPatterns: 0, noHosts: false });
    const garbage = parseSshConfigText('this is not a config\njust words');
    expect(garbage.hosts).toEqual([]);
    expect(garbage.noHosts).toBe(true);
  });
});
