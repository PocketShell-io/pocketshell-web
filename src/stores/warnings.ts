import { defineStore } from 'pinia';
import type { HostEntry } from '@pocketshell/core';
import {
  ackAllWarnings,
  ackWarning,
  bridgeAuthOf,
  fetchWarnings,
  type AplexerWarning,
  type HostLink,
} from '../aplexer/warnings';
import { config } from '../config';
import { useAuthStore } from './auth';
import { useHostsStore } from './hosts';

/**
 * Unacknowledged crash/OOM warnings per host, per issue #1: the hosts list
 * must show them without drilling into a session, so this store sweeps the
 * credentialed hosts with the same ephemeral `a warnings --json` runner the
 * terminal view uses, two hosts at a time. Everything degrades quietly — a
 * host with no stored credential, no `a`, or an unreachable one simply stays
 * out of the map; nothing here ever blocks or breaks the list itself. The
 * host's `a` is the source of truth: an ack re-runs the command, and the
 * refetched list (not the ack's exit status) decides what remains visible.
 *
 * ## The credential-custody guard
 *
 * The only transport this store has is the LEGACY Lambda bridge
 * (`config.wsUrl` — the one endpoint that receives a host's SSH key in its
 * `connect` frame). A host whose dial does not go through that bridge must
 * never have its key handed to it, no matter which URLs happen to be
 * configured, whether the sweep is automatic (unlock, auto-recall,
 * navigation) or a manual ack. Two exclusions, both checked BEFORE the
 * secret is so much as decrypted (`linkFor` is the one gate every bridge
 * run passes; the sweep queue filters too):
 *
 *  - GATEWAY hosts (`entry.gateway`): the key exists to authenticate
 *    end-to-end THROUGH the gateway; it never travels to any other
 *    infrastructure. There is no fallback — a gateway host simply has no
 *    bridge sweep (docs/gateway-client.md, maturity limits).
 *  - ORDINARY browser-direct hosts: when a direct relay is configured
 *    (`config.directWsUrl`), every plain host dials end-to-end from the
 *    browser and its key must stay out of the Lambda. Only a deployment
 *    with NO direct relay (`directWsUrl === ''`) has — by that same
 *    configuration — chosen the Lambda bridge as its host transport, and
 *    keeps the historical sweep for its non-gateway hosts. Link hosts are
 *    unchanged: their bridge-frame secret is the shared link token, not a
 *    private key.
 *
 * Nothing here ever falls back to another transport on failure: a sweep
 * miss stays a miss, and no code path in this store dials the gateway.
 */
export const useWarningsStore = defineStore('host-warnings', {
  state: () => ({
    /** Host name → its unacknowledged warnings. A host absent from the map
     * has nothing to show; entries for hosts that left the list are pruned. */
    byHost: {} as Record<string, AplexerWarning[]>,
    /** A sweep is in flight; concurrent sweeps are no-ops. */
    sweeping: false,
    /** Per-host ack in flight (one row or clear-all) — buttons disable. */
    busy: {} as Record<string, boolean>,
  }),
  getters: {
    /** Host names carrying at least one unacknowledged warning. */
    warnedHosts: (s) => Object.keys(s.byHost).filter((name) => s.byHost[name]!.length > 0),
    /** Warnings across all hosts — the list-wide badge count. */
    total: (s) => Object.values(s.byHost).reduce((n, list) => n + list.length, 0),
  },
  actions: {
    /**
     * The runner link for one host from this browser's stored credential,
     * or null when there is nothing to connect with (no sign-in, no bridge
     * URL, no eligible transport, no secret — each a quiet skip, never an
     * error surface). The custody exclusions run before `getHostSecret`
     * touches the vault.
     */
    async linkFor(name: string): Promise<HostLink | null> {
      const auth = useAuthStore();
      const hosts = useHostsStore();
      if (auth.idToken === '' || config.wsUrl === '') return null;
      const host = hosts.hosts.find((h) => h.name === name);
      if (host === undefined) return null;
      // Credential custody — BEFORE the secret is loaded (see class doc):
      // gateway hosts never; plain hosts only when this deployment has no
      // direct relay and the bridge is their actual transport.
      if (host.gateway !== undefined) return null;
      if (host.link === undefined && config.directWsUrl !== '') return null;
      const bridgeAuth = bridgeAuthOf(await hosts.getHostSecret(name));
      if (bridgeAuth === null) return null;
      return {
        wsUrl: config.wsUrl,
        idToken: auth.idToken,
        host: host.hostname,
        port: host.port,
        user: host.user,
        auth: bridgeAuth,
      };
    },

    /**
     * Refresh every host that has a credential in this browser (only those
     * can answer `a`), two connections at a time so a dozen hosts don't
     * stampede the bridge. Custody-excluded hosts are out of the queue
     * entirely — the bridge sweep never considers them, automatically or
     * otherwise. Hosts dropped from the synced list lose their entry even
     * though nothing queries them anymore.
     */
    async sweep(): Promise<void> {
      if (this.sweeping) return;
      this.sweeping = true;
      try {
        const hosts = useHostsStore();
        const known = new Set(hosts.hosts.map((h) => h.name));
        for (const name of Object.keys(this.byHost)) {
          const host = hosts.hosts.find((h) => h.name === name);
          // Left the list, or became custody-excluded (gateway host, or a
          // plain host while a direct relay is configured): a bridge-sourced
          // row could then never refresh or ack again — drop it rather than
          // show a half-truth.
          if (!known.has(name) || !this.eligibleForBridge(host)) delete this.byHost[name];
        }
        const queue = hosts.hosts
          .filter((h) => this.eligibleForBridge(h) && hosts.secretHosts.includes(h.name))
          .map((h) => h.name);
        const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
          for (;;) {
            const name = queue.shift();
            if (name === undefined) return;
            await this.refreshHost(name);
          }
        });
        await Promise.all(workers);
      } finally {
        this.sweeping = false;
      }
    },

    /** The custody rule in one place, shared by the queue, the prune, and
     * (via linkFor) every ack. Static per host + config — no secret access. */
    eligibleForBridge(host: HostEntry | undefined): boolean {
      if (host === undefined) return false;
      if (host.gateway !== undefined) return false;
      return host.link !== undefined || config.directWsUrl === '';
    },

    /** One host's list, quiet on any failure: null (no `a`, timeout, bridge
     * down) removes the entry rather than showing a half-truth. */
    async refreshHost(name: string): Promise<void> {
      const link = await this.linkFor(name);
      if (link === null) {
        delete this.byHost[name];
        return;
      }
      const next = await fetchWarnings(link);
      if (next !== null && next.length > 0) this.byHost[name] = next;
      else delete this.byHost[name];
    },

    /** Acknowledge one warning by session id (`a ack <uuid>`), then let the
     * refetch decide what the UI shows. */
    async ack(name: string, sessionId: string): Promise<void> {
      await this.ackWith(name, (link) => ackWarning(link, sessionId));
    },

    /** Acknowledge every warning on the host (bare `a ack`). */
    async ackAll(name: string): Promise<void> {
      await this.ackWith(name, ackAllWarnings);
    },

    async ackWith(
      name: string,
      run: (link: HostLink) => Promise<boolean>,
    ): Promise<void> {
      if (this.busy[name]) return;
      const link = await this.linkFor(name);
      if (link === null) return;
      this.busy[name] = true;
      try {
        await run(link);
      } finally {
        this.busy[name] = false;
      }
      await this.refreshHost(name);
    },
  },
});
