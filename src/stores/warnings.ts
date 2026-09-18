import { defineStore } from 'pinia';
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
 */
export const useWarningsStore = defineStore('warnings', {
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
    /** The runner link for one host from this browser's stored credential,
     * or null when there is nothing to connect with (no sign-in, no bridge
     * URL, no secret — each a quiet skip, never an error surface). */
    async linkFor(name: string): Promise<HostLink | null> {
      const auth = useAuthStore();
      const hosts = useHostsStore();
      if (auth.idToken === '' || config.wsUrl === '') return null;
      const host = hosts.hosts.find((h) => h.name === name);
      if (host === undefined) return null;
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
     * stampede the bridge. Hosts dropped from the synced list lose their
     * entry even though nothing queries them anymore.
     */
    async sweep(): Promise<void> {
      if (this.sweeping) return;
      this.sweeping = true;
      try {
        const hosts = useHostsStore();
        const known = new Set(hosts.hosts.map((h) => h.name));
        for (const name of Object.keys(this.byHost)) {
          if (!known.has(name)) delete this.byHost[name];
        }
        const queue = hosts.hosts.filter((h) => hosts.secretHosts.includes(h.name)).map((h) => h.name);
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
