import type { ForwardSpec, HostEntry } from './shared/types';

/**
 * Browser twin of the desktop's src/main/ssh-config/SshConfigParser.ts,
 * web-only like hostForm.ts: it parses the text of an uploaded ~/.ssh/config
 * IN THIS TAB, and that text never leaves the browser — only entries the
 * user then ticks join the synced list, encrypted like any other host.
 *
 * Same directive subset as the desktop (Host, HostName, Port, User,
 * IdentityFile, ProxyJump, ForwardAgent, LocalForward, RemoteForward), with
 * the divergences the browser forces, each deliberate:
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

const DEFAULT_PORT = 22;
const MAX_PORT = 65535;

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
  let skippedPatterns = 0;
  const hosts: ParsedSshHost[] = [];
  let current: Partial<HostEntry> & { names: string[] } | null = null;

  const pushCurrent = () => {
    if (!current) return;
    for (const name of current.names) {
      if (isHostPattern(name)) {
        skippedPatterns++;
      } else {
        hosts.push({ entry: finalizeHost(current, name) });
      }
    }
    current = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    // Comments and blank lines carry no directives; `Include` cannot work
    // in a browser and is skipped like a missing file on the desktop.
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^(\S+)\s*(.*)$/.exec(trimmed);
    if (!match || match[1] === undefined) continue;
    const key = match[1].toLowerCase();
    const value = (match[2] ?? '').trim();
    if (key === 'include') continue;

    if (key === 'host') {
      pushCurrent();
      current = {
        names: value.split(/\s+/).filter(Boolean),
        localForwards: [],
        remoteForwards: [],
        forwardAgent: false,
      };
      continue;
    }
    if (!current) continue; // global option before any Host; ignored, like the desktop

    switch (key) {
      case 'hostname':
        current.hostname = value;
        break;
      case 'port':
        current.port = parsePort(value);
        break;
      case 'user':
        current.user = value;
        break;
      case 'identityfile':
        current.identityFile = value;
        break;
      case 'proxyjump':
        current.proxyJump = value;
        break;
      case 'forwardagent':
        current.forwardAgent = value.toLowerCase() === 'yes';
        break;
      case 'localforward':
        current.localForwards?.push(parseForward(value, 'local'));
        break;
      case 'remoteforward':
        current.remoteForwards?.push(parseForward(value, 'remote'));
        break;
      default:
        break; // Ciphers, MACs, ... — not modelled, same as the desktop
    }
  }
  pushCurrent();
  return { hosts, skippedPatterns, noHosts: hosts.length === 0 && skippedPatterns === 0 && text.trim() !== '' };
}

/** True for names the bridge could never dial: globs and negations. */
function isHostPattern(name: string): boolean {
  return name.startsWith('!') || name.includes('*') || name.includes('?');
}

function finalizeHost(partial: Partial<HostEntry> & { names: string[] }, name: string): HostEntry {
  return {
    name,
    hostname: partial.hostname ?? name,
    port: partial.port ?? DEFAULT_PORT,
    user: partial.user ?? '', // ssh defaults to the local user; left blank for the form
    identityFile: partial.identityFile ?? null,
    proxyJump: partial.proxyJump ?? null,
    forwardAgent: partial.forwardAgent ?? false,
    localForwards: partial.localForwards ?? [],
    remoteForwards: partial.remoteForwards ?? [],
    fromConfig: true,
  };
}

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n <= MAX_PORT ? n : DEFAULT_PORT;
}

function parseForward(value: string, kind: ForwardSpec['kind']): ForwardSpec {
  // Forms: "listenPort" | "listenHost:listenPort" | "listen destHost:destPort"
  const tokens = value.split(/\s+/).filter(Boolean);
  const [listenPart, destPart] = tokens;
  const listen = splitHostPort(listenPart ?? value);
  if (destPart) {
    const dest = splitHostPort(destPart);
    return { kind, listenHost: listen.host, listenPort: listen.port, destHost: dest.host, destPort: dest.port };
  }
  return { kind, listenHost: listen.host, listenPort: listen.port, destHost: '', destPort: 0 };
}

function splitHostPort(part: string): { host: string; port: number } {
  // "[::1]:8080" | "127.0.0.1:8080" | "8080"
  if (part.startsWith('[')) {
    const close = part.indexOf(']');
    const host = part.slice(1, close);
    const portPart = part.slice(close + 2); // skip "]:"
    return { host, port: Number.parseInt(portPart, 10) || 0 };
  }
  const colon = part.lastIndexOf(':');
  if (colon < 0) return { host: '127.0.0.1', port: Number.parseInt(part, 10) || 0 };
  const host = part.slice(0, colon);
  const port = Number.parseInt(part.slice(colon + 1), 10) || 0;
  return { host: host || '127.0.0.1', port };
}
