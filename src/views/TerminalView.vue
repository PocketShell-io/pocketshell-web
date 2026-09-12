<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { BridgeSession } from '../terminal/bridge';
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

let session: BridgeSession | null = null;
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

  const secret = await hosts.getHostSecret(host.name);
  if ((secret?.privateKeyPem ?? '') === '' && (secret?.password ?? '') === '') {
    status.value = 'failed';
    error.value = 'No key attached for this host yet — go back to Hosts → Key…';
    return;
  }
  const bridgeAuth = (secret?.privateKeyPem ?? '') !== ''
    ? { kind: 'key' as const, privateKey: secret!.privateKeyPem! }
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

  session = new BridgeSession(config.wsUrl, auth.idToken, {
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
});

function refit() {
  fit?.fit();
  if (term !== null && session !== null) session.resize(term.cols, term.rows);
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', refit);
  session?.close();
  term?.dispose();
});

function back() {
  router.push({ name: 'hosts' });
}
</script>

<template>
  <div>
    <div class="topbar">
      <button @click="back">← Hosts</button>
      <strong>{{ route.params.name }}</strong>
      <span class="muted">{{ status }}</span>
      <span class="spacer" />
    </div>
    <p v-if="error" class="error" style="padding: 0 20px">{{ error }}</p>
    <div class="terminal-wrap">
      <div ref="termEl" class="term" />
    </div>
  </div>
</template>
