<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { createSession, type TerminalSession } from '../terminal/session';
import { decodeOsc52SetClipboard } from '../shared/osc52';
import {
  ackAllWarnings,
  ackWarning,
  fetchWarnings,
  formatAge,
  type AplexerWarning,
  type HostLink,
} from '../aplexer/warnings';
import { config } from '../config';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const hosts = useHostsStore();

const termEl = ref<HTMLElement | null>(null);
const status = ref('connecting…');
const error = ref('');

// Crash/OOM warnings from the host's aplexer (issue #1). null = nothing to
// show — either the host has no `a` or it could not be reached, and per the
// usage-panel principle a host without the helper is never nagged. The list
// refreshes on connect, on tab refocus, and after every ack; the ack itself
// is confirmed by the refetch, which is the source of truth.
const warnings = ref<AplexerWarning[] | null>(null);
const warnBusy = ref(false);
const warnError = ref('');
let warnLink: HostLink | null = null;

let session: TerminalSession | null = null;
let term: Terminal | null = null;
let fit: FitAddon | null = null;

onMounted(async () => {
  if (!auth.signedIn) {
    router.replace({ name: 'login' });
    return;
  }
  const host = hosts.hosts.find((h) => h.name === route.params.name);
  if (host === undefined) {
    error.value = `No synced host named "${String(route.params.name)}"`;
    status.value = 'failed';
    return;
  }

  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: { background: '#0d1117', foreground: '#e6edf3' },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termEl.value!);
  await nextTick();
  fit.fit();

  // http(s) links become clickable (new tab, no opener access). The desktop
  // pane detects paths as well, but its path links land in its Files tab,
  // which the web does not have — URLs are the shareable half.
  term.loadAddon(new WebLinksAddon((_event, url) => window.open(url, '_blank', 'noopener')));

  // OSC 52 → clipboard: the receiving half of a yank inside the shell (a tmux
  // `prefix+[` … `y`, or any remote program that sets the clipboard). The
  // desktop answers the same sequence with the decoder vendored from
  // shared/osc52.ts — what it refuses never touches the clipboard. A write
  // can still be denied by the browser when the yank carries no recent user
  // activation; that failure is silent, like a yank into a pane with no
  // clipboard of its own.
  term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52SetClipboard(data);
    if (text !== null) void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  });

  const secret = await hosts.getHostSecret(host.name);
  if ((secret?.privateKeyPem ?? '') === '' && (secret?.password ?? '') === '') {
    status.value = 'failed';
    error.value = 'No key attached for this host yet — go back to Hosts → Key…';
    return;
  }
  const bridgeAuth = (secret?.privateKeyPem ?? '') !== ''
    ? {
        kind: 'key' as const,
        privateKey: secret!.privateKeyPem!,
        // An encrypted OpenSSH key needs its passphrase before sshd will
        // have us; the bridge takes it in the same connect frame and uses
        // it in memory only.
        ...(secret!.keyPassphrase ? { passphrase: secret!.keyPassphrase } : {}),
      }
    : { kind: 'password' as const, password: secret!.password! };

  // The bridge deliberately returns one generic message for every SSH
  // failure (bad key, refused connection, timeout) so it never leaks which
  // part failed; expand it into something actionable here.
  const friendly = (message: string) => {
    if (message === 'ssh connect failed') {
      return `Could not open an SSH session on ${host.hostname} — check the address, the stored key, and that the machine accepts SSH.`;
    }
    if (message === 'WebSocket connection failed') {
      return 'Could not reach the PocketShell bridge — check your network and try again.';
    }
    return message;
  };

  // A configured relay means browser-direct: the SSH client runs here and
  // the relay is a dumb ciphertext pipe; otherwise the Lambda bridge runs
  // the SSH client and the key rides the connect frame.
  const directUrl = config.directWsUrl;
  session = await createSession(directUrl !== '' ? 'direct' : 'bridge', directUrl !== '' ? directUrl : config.wsUrl, auth.idToken, {
    onData: (bytes) => term?.write(bytes),
    onExit: () => {
      status.value = 'disconnected';
      term?.write('\r\n[session closed]');
    },
    onError: (message) => {
      error.value = friendly(message);
    },
    onStatus: (s) => {
      status.value = s;
    },
  });

  term.onData((data) => session?.sendInput(data));
  window.addEventListener('resize', refit);
  try {
    await session.open({
      host: host.hostname,
      port: host.port,
      user: host.user,
      cols: term.cols,
      rows: term.rows,
      auth: bridgeAuth,
    });
  } catch (e) {
    status.value = 'failed';
    error.value = friendly(e instanceof Error ? e.message : String(e));
    return;
  }
  status.value = 'connected';
  term.focus();
  warnLink = {
    wsUrl: config.wsUrl,
    idToken: auth.idToken,
    host: host.hostname,
    port: host.port,
    user: host.user,
    auth: bridgeAuth,
  };
  document.addEventListener('visibilitychange', onVisibility);
  void refreshWarnings();
});

function onVisibility() {
  if (!document.hidden) void refreshWarnings();
}

async function refreshWarnings() {
  if (warnLink === null || warnBusy.value) return;
  warnBusy.value = true;
  try {
    const next = await fetchWarnings(warnLink);
    if (next === null) {
      // Reachable before, silent now: keep the last known list rather than
      // letting a transport blip erase a crash the user has not acked.
      if (warnings.value !== null) warnError.value = 'Could not refresh warnings — the list may be stale.';
    } else {
      warnings.value = next;
      warnError.value = '';
    }
  } finally {
    warnBusy.value = false;
  }
}

async function ack(sessionId: string) {
  if (warnLink === null) return;
  warnBusy.value = true;
  try {
    await ackWarning(warnLink, sessionId);
  } finally {
    warnBusy.value = false;
  }
  await refreshWarnings();
}

async function ackAll() {
  if (warnLink === null) return;
  warnBusy.value = true;
  try {
    await ackAllWarnings(warnLink);
  } finally {
    warnBusy.value = false;
  }
  await refreshWarnings();
}

function refit() {
  fit?.fit();
  if (term !== null && session !== null) session.resize(term.cols, term.rows);
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', refit);
  document.removeEventListener('visibilitychange', onVisibility);
  session?.close();
  term?.dispose();
});

function back() {
  router.push({ name: 'hosts' });
}

// View-only mapping from the status word to the chrome's visual state: green
// pill while live, muted pill with a spinner while the bridge is being
// reached, error-red pill once the session is down or failed. It reads the
// same string the bridge reports and changes nothing about the session.
const BUSY_STATUSES = new Set(['connecting…', 'reconnecting…']);
const busy = computed(
  () => BUSY_STATUSES.has(status.value) || status.value.startsWith('host key'),
);
const statusState = computed(() => {
  if (status.value === 'connected') return 'is-connected';
  if (BUSY_STATUSES.has(status.value)) return 'is-busy';
  return 'is-down';
});
</script>

<template>
  <div class="term-screen">
    <section class="term-card">
      <header class="topbar term-topbar">
        <button @click="back">← Hosts</button>
        <span class="term-mark" aria-hidden="true">&gt;_</span>
        <h1 class="term-title">{{ route.params.name }}</h1>
        <span class="spacer" />
        <span class="term-status muted" :class="statusState" role="status">
          <span v-if="busy" class="auth-spinner" aria-hidden="true" />
          {{ status }}
        </span>
      </header>
      <div class="terminal-wrap">
        <section v-if="warnings !== null && warnings.length > 0" class="warn-banner" role="alert">
          <div class="warn-head">
            <p class="warn-title">
              {{ warnings.length }} crash warning{{ warnings.length === 1 ? '' : 's' }} on this host
            </p>
            <button :disabled="warnBusy" @click="ackAll">Clear all</button>
          </div>
          <p v-if="warnError" class="warn-stale">{{ warnError }}</p>
          <ul class="warn-list">
            <li v-for="w in warnings" :key="w.session" class="warn-row">
              <span class="warn-kind" :class="w.kind === 'oom' ? 'is-oom' : 'is-crash'">
                {{ w.kind === 'oom' ? 'OOM' : 'crash' }}
              </span>
              <span class="warn-sel">{{ w.workspace }}:{{ w.tag }}</span>
              <span class="warn-detail">{{ w.detail }}</span>
              <span class="warn-age">{{ formatAge(Date.now(), w.created_at_ms) }}</span>
              <button :disabled="warnBusy" @click="ack(w.session)">Acknowledge</button>
            </li>
          </ul>
        </section>
        <div v-if="error" class="term-notice" role="alert">
          <p class="error">{{ error }}</p>
          <button @click="back">← Hosts</button>
        </div>
        <div ref="termEl" class="term" />
      </div>
    </section>
  </div>
</template>
