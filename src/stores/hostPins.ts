import { defineStore } from 'pinia';
import { decryptEnvelope, encryptToEnvelope } from '../shared/syncCrypto';
import { knownHostsToken, normalizeSha256Fingerprint, type HostKeyPin } from '@pocketshell/core';
import { useHostsStore } from './hosts';

const PINS_STORAGE = 'ps.hostPins';

/** One gateway host's independently provisioned key fingerprint — the pin a
 * gateway dial verifies against, and the ONLY thing that can vouch for a
 * gateway host's key (the gateway's own records never do). */
export interface GatewayHostKeyPin {
  /** `SHA256:<base64>`, normalized. */
  fingerprintSha256: string;
}

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
 * Gateway hosts (`hostPins.gatewayPins`) live in the same envelope under the
 * same rules, keyed by the enrolled device id instead of host:port — that is
 * what a gateway dial is about. They are created only by PAIRING (the owner
 * pastes the fingerprint from the host itself or the trusted local
 * enrollment), never by connecting, and rotation is a deliberate re-pair.
 *
 * The classification itself is the shared core, so both clients call a key
 * trusted, mismatched, or unknown with the same rules and the same host
 * token (`[host]:port` keying for non-default ports).
 */
export const useHostPinsStore = defineStore('hostPins', {
  state: () => ({
    /** token (`host` or `[host]:port`) → the pinned key. */
    pins: {} as Record<string, HostKeyPin>,
    /** gateway device id → the paired fingerprint. */
    gatewayPins: {} as Record<string, GatewayHostKeyPin>,
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
          const parsed = parsePinsPayload(await decryptEnvelope(raw, passphrase));
          this.pins = parsed.pins;
          this.gatewayPins = parsed.gatewayPins;
        } catch {
          this.pins = {}; // wrong passphrase or garbage — same degraded parse as the keys cache
          this.gatewayPins = {};
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
    /** Pairing: store the fingerprint the owner provisioned from the host
     * itself. Accepts any spelling normalizeSha256Fingerprint accepts; a
     * fingerprint that is not SHA-256 is a refused pairing, never a stored
     * pin. Re-pairing (rotation) replaces the pin — deliberately, explicitly,
     * from a value that came from the host, not from any gateway answer. */
    async setGatewayPin(deviceId: string, fingerprint: string): Promise<GatewayHostKeyPin | null> {
      const normalized = normalizeSha256Fingerprint(fingerprint);
      if (normalized === null) return null;
      await this.ensure();
      this.gatewayPins[deviceId] = { fingerprintSha256: normalized };
      await this.writeLocalCache();
      return this.gatewayPins[deviceId]!;
    },
    async gatewayLookup(deviceId: string): Promise<GatewayHostKeyPin | undefined> {
      await this.ensure();
      return this.gatewayPins[deviceId];
    },
    /** Drop a device's pairing — the remedy for a rotated host key the owner
     * has verified out of band, or a device leaving the account. */
    async forgetGatewayPin(deviceId: string): Promise<void> {
      await this.ensure();
      delete this.gatewayPins[deviceId];
      await this.writeLocalCache();
    },
    async writeLocalCache(): Promise<void> {
      const passphrase = useHostsStore().passphrase;
      if (passphrase === '') return;
      localStorage.setItem(PINS_STORAGE, await encryptToEnvelope(serializePinsPayload(this.pins, this.gatewayPins), passphrase));
    },
  },
});

function serializePinsPayload(pins: Record<string, HostKeyPin>, gatewayPins: Record<string, GatewayHostKeyPin>): string {
  return JSON.stringify({ v: 1, pins, gatewayPins });
}

/** Degraded parse, same philosophy as parseSecretsPayload: anything that is
 * not a plausible pins map parses to an EMPTY map, not an error. */
function parsePinsPayload(plaintext: string): { pins: Record<string, HostKeyPin>; gatewayPins: Record<string, GatewayHostKeyPin> } {
  const empty = { pins: {} as Record<string, HostKeyPin>, gatewayPins: {} as Record<string, GatewayHostKeyPin> };
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const root = parsed as Record<string, unknown>;
    const raw = root['pins'];
    if (typeof raw === 'object' && raw !== null) {
      for (const [token, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const v = value as Record<string, unknown>;
        if (typeof v['keyType'] === 'string' && typeof v['keyB64'] === 'string') {
          empty.pins[token] = { keyType: v['keyType'], keyB64: v['keyB64'] };
        }
      }
    }
    const rawGateway = root['gatewayPins'];
    if (typeof rawGateway === 'object' && rawGateway !== null) {
      for (const [deviceId, value] of Object.entries(rawGateway as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const v = value as Record<string, unknown>;
        if (typeof v['fingerprintSha256'] === 'string' && normalizeSha256Fingerprint(v['fingerprintSha256']) !== null) {
          empty.gatewayPins[deviceId] = { fingerprintSha256: v['fingerprintSha256'] };
        }
      }
    }
    return empty;
  } catch {
    return empty;
  }
}
