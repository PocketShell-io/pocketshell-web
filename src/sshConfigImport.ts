import { buildHosts, parseDirectiveLine } from '@pocketshell/core';
import type { Directive } from '@pocketshell/core';
import type { HostEntry } from '@pocketshell/core';

/**
 * Browser twin of the desktop's src/main/ssh-config/SshConfigParser: the
 * directive folding is the SAME code the desktop runs — sshConfigCore in
 * @pocketshell/core, one implementation for both clients — and this module
 * is the browser half of the split.
 * It parses the text of an uploaded ~/.ssh/config IN THIS TAB, and that text
 * never leaves the browser; only entries the user then ticks join the synced
 * list, encrypted like any other host.
 *
 * Web-only divergences from the desktop wrapper, each deliberate:
 *   - `Include` is skipped silently (a tab cannot read other files; openssh
 *     also skips a missing include);
 *   - `~` in IdentityFile is kept verbatim instead of expanded: on the web
 *     it is a display hint for WHICH key file to upload, and if a desktop
 *     later pulls the entry it writes a valid directive back to its own
 *     config — an absolute path from the importing machine would not be;
 *   - host PATTERNS (`*`, `?`, negated `!`) are skipped and counted, not
 *     imported: the bridge dials hosts directly, so a pattern is a row that
 *     could never connect.
 *
 * Pure + synchronous so tests drive it against a string.
 */

/** One parsed row: the entry plus whether that name is already synced. */
export interface ParsedSshHost {
  entry: HostEntry;
}

/** The result of parsing one config text: rows to offer, patterns skipped. */
export interface SshConfigParse {
  hosts: ParsedSshHost[];
  /** Host patterns (`*`, `?`, `!negated`) that were not offered. */
  skippedPatterns: number;
  /** True when the text had directives but not one usable Host block. */
  noHosts: boolean;
}

/** Parse config text into the host list the import panel offers. */
export function parseSshConfigText(text: string): SshConfigParse {
  const directives: Directive[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const directive = parseDirectiveLine(lines[i] ?? '', i + 1);
    // `Include` needs a filesystem a tab does not have; skip like openssh.
    if (directive && directive.key !== 'include') directives.push(directive);
  }

  const hosts: ParsedSshHost[] = [];
  let skippedPatterns = 0;
  for (const entry of buildHosts(directives)) {
    if (isHostPattern(entry.name)) skippedPatterns++;
    else hosts.push({ entry });
  }
  return {
    hosts,
    skippedPatterns,
    noHosts: hosts.length === 0 && skippedPatterns === 0 && text.trim() !== '',
  };
}

/** True for names the bridge could never dial: globs and negations. */
function isHostPattern(name: string): boolean {
  return name.startsWith('!') || name.includes('*') || name.includes('?');
}
