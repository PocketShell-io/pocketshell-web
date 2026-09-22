import { defineStore } from 'pinia';
import { decryptEnvelope, encryptToEnvelope } from '../shared/syncCrypto';
import { knownHostsToken, type HostKeyPin } from '@pocketshell/core';
import { useHostsStore } from './hosts';

const PINS_STORAGE = 'ps.hostPins';

/**
 * Per-host SSH host-key pins — the browser's known_hosts.
 *
 * The desktop pins keys as lines in `~/.ssh/known_hosts`; a browser cannot
 * keep that file, so the pin a TOFU "connect and pin" creates lives in this
 * browser's localStorage, envelope-encrypted with the sync passphrase (the
 * same at-rest treatment the key secrets get — a host pin says "this user
 * connects to this host", which is not something site data should say in the
 * clear). Pins are NOT synced to the account: the desktop's known_hosts is
 * per-machine too, and a pin that roams would let one device's first-use
 * trust answer another device's changed-key question.
 *
 * The classification itself is the vendored shared core
 * (`shared/knownHostsCore.ts`), so both clients call a key trusted, mismatched,
 * or unknown with the same rules and the same host token (`[host]:port`
 * keying for non-default ports).
 */
export const useHostPinsStore = defineStore('hostPins', {
  state: () => ({
    /** token (`host` or `[host]:port`) → the pinned key. */
    pins: {} as Record<string, HostKeyPin>,
    /** True once the encrypted cache was read with the session passphrase. */
    loaded: false,
  }),
  actions: {
    /** Read the cache once the sync passphrase is available. Without it the
     * map stays empty — lookups report `unknown` and the TOFU prompt runs;
     * nothing fails open into TRUST, only into ask-again. */
    async ensure(): Promise<void> {
      if (this.loaded) return;
      const passphrase = useHostsStore().passphrase;
      if (passphrase === '') return;
      const raw = localStorage.getItem(PINS_STORAGE);
      if (raw !== null) {
        try {
          this.pins = parsePinsPayload(await decryptEnvelope(raw, passphrase));
        } catch {
          this.pins = {}; // wrong passphrase or garbage — same degraded parse as the keys cache
        }
      }
      this.loaded = true;
    },
    async lookup(host: string, port: number): Promise<HostKeyPin | undefined> {
      await this.ensure();
      return this.pins[knownHostsToken(host, port)];
    },
    /** TOFU accept-always. Memory first (the connect must proceed even if the
     * envelope cannot be written), then the encrypted cache. */
    async pin(host: string, port: number, pin: HostKeyPin): Promise<void> {
      await this.ensure();
      this.pins[knownHostsToken(host, port)] = pin;
      await this.writeLocalCache();
    },
    /** The explicit remedy for a key CHANGE the user accepts (server rebuilt,
     * key rotated): drop the pin so the next connect prompts as a first use. */
    async forget(host: string, port: number): Promise<void> {
      await this.ensure();
      delete this.pins[knownHostsToken(host, port)];
      await this.writeLocalCache();
    },
    async writeLocalCache(): Promise<void> {
      const passphrase = useHostsStore().passphrase;
      if (passphrase === '') return;
      localStorage.setItem(PINS_STORAGE, await encryptToEnvelope(serializePinsPayload(this.pins), passphrase));
    },
  },
});

function serializePinsPayload(pins: Record<string, HostKeyPin>): string {
  return JSON.stringify({ v: 1, pins });
}

/** Degraded parse, same philosophy as parseSecretsPayload: anything that is
 * not a plausible pins map parses to an EMPTY map, not an error. */
function parsePinsPayload(plaintext: string): Record<string, HostKeyPin> {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const raw = (parsed as Record<string, unknown>)['pins'];
    if (typeof raw !== 'object' || raw === null) return {};
    const out: Record<string, HostKeyPin> = {};
    for (const [token, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      if (typeof v['keyType'] === 'string' && typeof v['keyB64'] === 'string') {
        out[token] = { keyType: v['keyType'], keyB64: v['keyB64'] };
      }
    }
    return out;
  } catch {
    return {};
  }
}
