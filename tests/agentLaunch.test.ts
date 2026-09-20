/**
 * The vendored `agentLaunch.ts` against the same captured `--help` fixtures
 * the desktop asserts. The desktop repo's tests/unit/agentLaunch.test.ts is
 * the canonical, deeper suite; this one pins the contract the web composer
 * inherits: every flag the launch-line builder emits must be spelled the way
 * the helper the user actually runs spells it, and the quoting must survive
 * hostile input — the bare `pocketshell agent claude` exit-2 failure (session
 * created, agent never started) is what this module exists to stop.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HELPER_BASELINE_KINDS,
  HELPER_VERSION_WITHOUT_GROK,
  LAUNCHABLE_KINDS,
  buildLaunchCommand,
  isLaunchableKind,
  kindNeedsNewerHelper,
  kindUnavailableReason,
  launchBlocker,
  supportsProfiles,
  supportsSkipPermissions,
} from '../src/shared/agentLaunch';

const readFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('the 0.4.44 `pocketshell agent` contract, as captured', () => {
  const groupHelp = readFixture('v0.4.44-agent-help.txt');
  const claudeHelp = readFixture('v0.4.44-agent-claude-help.txt');
  const opencodeHelp = readFixture('v0.4.44-agent-opencode-help.txt');

  it('lists exactly the three subcommands the helper baseline accepts', () => {
    const listed = [...groupHelp.matchAll(/^ {2}(\w+) {2,}Launch/gm)].map((m) => m[1]);
    expect(listed).toEqual(['claude', 'codex', 'opencode']);
    expect([...HELPER_BASELINE_KINDS]).toEqual(listed);
    // LAUNCHABLE_KINDS is what the app can spell; the gap is probed for.
    expect([...LAUNCHABLE_KINDS]).toEqual([...listed, 'grok']);
    for (const kind of HELPER_BASELINE_KINDS) expect(kindNeedsNewerHelper(kind)).toBe(false);
    expect(kindNeedsNewerHelper('grok')).toBe(true);
  });

  it('refuses grok on a host whose captured help has no such subcommand', () => {
    expect(groupHelp).not.toMatch(/^ {2}grok\b/m);
    expect(readFixture('v0.4.44-agent-no-such-command.stderr.txt')).toContain(
      "Error: No such command 'grok'.",
    );
    expect(isLaunchableKind('grok')).toBe(true);
    const onPinnedHost = { subcommands: [...HELPER_BASELINE_KINDS] };
    expect(kindUnavailableReason('grok', onPinnedHost)).toMatch(/too old to start Grok/);
    expect(kindUnavailableReason('grok', onPinnedHost)).toContain(
      `newer than ${HELPER_VERSION_WITHOUT_GROK}`,
    );
    expect(launchBlocker({ kind: 'grok', dir: '/srv/app' }, onPinnedHost)).toBe(
      kindUnavailableReason('grok', onPinnedHost),
    );
  });

  it('marks --dir required, which is the bug this module fixes', () => {
    expect(claudeHelp).toMatch(/--dir TEXT[\s\S]*?\[required\]/);
    expect(readFixture('v0.4.44-agent-missing-dir.stderr.txt')).toContain(
      "Error: Missing option '--dir'.",
    );
  });

  it('spells the permission flag as a --x/--no-x pair defaulting to ON', () => {
    expect(claudeHelp).toContain('--skip-permissions / --no-skip-permissions');
    expect(claudeHelp).toContain('[default: skip-permissions]');
  });

  it('says the permission flag is a no-op and --profile ignored for opencode', () => {
    expect(opencodeHelp).toContain('No-op\n                                  for opencode');
    expect(supportsSkipPermissions('opencode')).toBe(false);
    expect(claudeHelp).toMatch(/--profile TEXT[\s\S]*?Mutually\s+exclusive with --config-dir/);
    expect(supportsProfiles('opencode')).toBe(false);
  });
});

describe('buildLaunchCommand', () => {
  const base = { kind: 'claude', dir: '/srv/app', skipPermissions: true, profile: null } as const;

  it('always passes --dir, quoted', () => {
    expect(buildLaunchCommand(base)).toBe("pocketshell agent claude --dir '/srv/app'");
  });

  it('emits --no-skip-permissions only when the user turned it off', () => {
    expect(buildLaunchCommand({ ...base, skipPermissions: false })).toBe(
      "pocketshell agent claude --dir '/srv/app' --no-skip-permissions",
    );
  });

  it('never emits a permission flag for opencode, either way', () => {
    const on = buildLaunchCommand({ ...base, kind: 'opencode', skipPermissions: true });
    const off = buildLaunchCommand({ ...base, kind: 'opencode', skipPermissions: false });
    expect(on).toBe("pocketshell agent opencode --dir '/srv/app'");
    expect(off).toBe(on);
  });

  it('emits --profile, quoted, for a named profile; drops a blank one', () => {
    expect(buildLaunchCommand({ ...base, profile: 'Claude (Z.AI)' })).toBe(
      "pocketshell agent claude --dir '/srv/app' --profile 'Claude (Z.AI)'",
    );
    expect(buildLaunchCommand({ ...base, profile: '   ' })).toBe(
      "pocketshell agent claude --dir '/srv/app'",
    );
  });

  it('ignores a profile for opencode, which has no config dir', () => {
    expect(buildLaunchCommand({ ...base, kind: 'opencode', profile: 'Claude (Z.AI)' })).toBe(
      "pocketshell agent opencode --dir '/srv/app'",
    );
  });

  it('builds grok as --dir and nothing else, whatever else was chosen', () => {
    expect(buildLaunchCommand({ ...base, kind: 'grok' })).toBe(
      "pocketshell agent grok --dir '/srv/app'",
    );
    expect(
      buildLaunchCommand({
        kind: 'grok',
        dir: '/srv/app',
        skipPermissions: false,
        profile: 'Claude (Z.AI)',
      }),
    ).toBe("pocketshell agent grok --dir '/srv/app'");
  });

  it('combines both flags in the helper documented order', () => {
    expect(
      buildLaunchCommand({ kind: 'codex', dir: '/srv/app', skipPermissions: false, profile: 'work' }),
    ).toBe("pocketshell agent codex --dir '/srv/app' --no-skip-permissions --profile 'work'");
  });

  it('quotes hostile input as data and expands a literal ~/ cwd', () => {
    expect(buildLaunchCommand({ ...base, dir: '/srv/my app' })).toBe(
      "pocketshell agent claude --dir '/srv/my app'",
    );
    expect(buildLaunchCommand({ ...base, dir: '~/git/my app' })).toBe(
      "pocketshell agent claude --dir $HOME/'git/my app'",
    );
    expect(buildLaunchCommand({ ...base, dir: "/srv/wei'rd $(touch /tmp/PWNED)" })).toBe(
      "pocketshell agent claude --dir '/srv/wei'\\''rd $(touch /tmp/PWNED)'",
    );
    expect(buildLaunchCommand({ ...base, profile: "o'brien" })).toBe(
      "pocketshell agent claude --dir '/srv/app' --profile 'o'\\''brien'",
    );
  });
});

describe('launchBlocker', () => {
  it('passes a complete choice and does not second-guess the host unprompted', () => {
    expect(launchBlocker({ kind: 'claude', dir: '/srv/app', skipPermissions: true, profile: null })).toBeNull();
    // Callers downstream of the picker omit host support when it was already
    // vetted; omitting must mean "skip that question", not "answer it no".
    expect(launchBlocker({ kind: 'grok', dir: '/srv/app' })).toBeNull();
  });

  it('blocks a kind that is not an agent at all', () => {
    expect(launchBlocker({ kind: 'shell' as never, dir: '/srv/app' })).toBe(
      'Pick an agent to launch.',
    );
  });
});
