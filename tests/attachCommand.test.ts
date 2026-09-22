import { describe, expect, it } from 'vitest';
import { aplexerAttachCommand } from '@pocketshell/core';

describe('aplexerAttachCommand', () => {
  it('joins by id when the uuid is known', () => {
    const command = aplexerAttachCommand({ id: 'u-123', workspace: '/w', tag: 'main' });
    expect(command).toContain('a attach ');
    expect(command).toContain(`'u-123'`);
    expect(command).not.toContain('--workspace');
    // Self-terminating: the channel closes when the session detaches.
    expect(command.trim().endsWith('exit')).toBe(true);
  });

  it('joins by workspace+tag when the id is absent, quoting both', () => {
    const command = aplexerAttachCommand({ workspace: '/home/a/my repo', tag: 'wei"rd' });
    expect(command).toContain(`--workspace '/home/a/my repo'`);
    expect(command).toContain(`--tag 'wei"rd'`);
  });

  it('PATH-widens inside a subshell so `a` is found under a bare sshd PATH', () => {
    const command = aplexerAttachCommand({ id: 'u' });
    expect(command.startsWith('( PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$PATH"; a attach')).toBe(true);
  });

  it('prints a diagnostic and exits when the join fails', () => {
    const command = aplexerAttachCommand({ id: 'u', tag: 'main' });
    expect(command).toContain('|| printf');
    expect(command).toContain('could not join session');
    expect(command).toContain(`'main'`);
  });

  it('never degrades a blank workspace to $HOME', () => {
    const command = aplexerAttachCommand({ workspace: '', tag: 'x' });
    expect(command).toContain(`--workspace ''`);
  });
});
