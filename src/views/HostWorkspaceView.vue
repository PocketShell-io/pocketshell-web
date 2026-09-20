<script setup lang="ts">
/**
 * The host workspace: the desktop's session panel carried to the browser.
 * Sidebar = the host's live sessions grouped by workspace (the snapshot's
 * order IS the sidebar's order); tab strip = one open terminal per joined
 * session; status bar = the active tab's selector, engine, and phase.
 *
 * Hosts without `a` get one raw shell tab — the pre-workspace behaviour
 * with a tab bar around it. Everything here runs through the workspace
 * controller; this file is chrome and xterm wiring only.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { decodeOsc52SetClipboard } from '../shared/osc52';
import {
  HostWorkspaceController,
  type ControllerState,
  type SessionRow,
  type WorkspaceLink,
} from '../workspace/controller';
import { formatAge } from '../aplexer/warningsParse';
import { config } from '../config';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const hosts = useHostsStore();

const state = shallowRef<ControllerState | null>(null);
let controller: HostWorkspaceController | null = null;

const termEls = new Map<string, HTMLElement>();
const terms = new Map<string, { term: Terminal; fit: FitAddon }>();
/** Bytes that landed before a tab's xterm finished mounting. */
const pending = new Map<string, Uint8Array[]>();

const stageEl = ref<HTMLElement | null>(null);
let stageObserver: ResizeObserver | null = null;
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

const error = ref('');
const failed = ref(false);

// --- dialog state ---------------------------------------------------------
const showNew = ref(false);
const newWorkspace = ref('');
const newTag = ref('');
const newError = ref('');
const renameRow = ref<SessionRow | null>(null);
const renameTag = ref('');
const killRow = ref<SessionRow | null>(null);
const sidebarOpen = ref(false);

const hostName = computed(() => String(route.params.name));
const activeTab = computed(() => state.value?.tabs.find((t) => t.key === state.value?.activeKey) ?? null);
const rowForActive = computed(() => {
  const key = state.value?.activeKey;
  if (key === undefined || key === null || !key.startsWith('apx:')) return null;
  return state.value?.rows.find((r) => `apx:${r.id}` === key) ?? null;
});

onMounted(async () => {
  if (!auth.signedIn) {
    router.replace({ name: 'login' });
    return;
  }
  const host = hosts.hosts.find((h) => h.name === hostName.value);
  if (host === undefined) {
    error.value = `No synced host named "${hostName.value}"`;
    failed.value = true;
    return;
  }
  const secret = await hosts.getHostSecret(host.name);
  if ((secret?.privateKeyPem ?? '') === '' && (secret?.password ?? '') === '') {
    error.value = 'No key attached for this host yet — go back to Hosts → Key…';
    failed.value = true;
    return;
  }
  const bridgeAuth = (secret?.privateKeyPem ?? '') !== ''
    ? {
        kind: 'key' as const,
        privateKey: secret!.privateKeyPem!,
        ...(secret!.keyPassphrase ? { passphrase: secret!.keyPassphrase } : {}),
      }
    : { kind: 'password' as const, password: secret!.password! };
  const link: WorkspaceLink = {
    url: config.directWsUrl,
    idToken: auth.idToken,
    host: host.hostname,
    port: host.port,
    user: host.user,
    auth: bridgeAuth,
  };

  controller = new HostWorkspaceController({ link });
  controller.onChange((s) => {
    state.value = s;
  });
  controller.onChannelData((key, bytes) => {
    const entry = terms.get(key);
    if (entry) entry.term.write(bytes);
    else {
      const queue = pending.get(key) ?? [];
      queue.push(bytes);
      pending.set(key, queue);
    }
  });
  controller.onChannelExit(() => {
    // A dead tab keeps its scrollback until the user closes it; the tab
    // chrome flips to `closed` in the controller's state.
  });
  state.value = controller.state;
  await controller.start();

  document.addEventListener('visibilitychange', onVisibility);
  nowTimer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});

function onVisibility() {
  controller?.setPaused(document.hidden);
}

// --- xterm wiring ---------------------------------------------------------

/** One pane terminal, the same setup the bridge terminal view runs. */
function mountTerm(key: string, el: HTMLElement) {
  if (terms.has(key)) return;
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: { background: '#0d1117', foreground: '#e6edf3' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, url) => window.open(url, '_blank', 'noopener')));
  term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52SetClipboard(data);
    if (text !== null) void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  });
  term.open(el);
  fit.fit();
  term.onData((data) => controller?.writeToTab(key, data));
  terms.set(key, { term, fit });
  termEls.set(key, el);
  const queue = pending.get(key);
  if (queue) {
    for (const bytes of queue) term.write(bytes);
    pending.delete(key);
  }
  controller?.resizeTab(key, term.cols, term.rows);
  if (state.value?.activeKey === key) term.focus();
}

watch(
  () => state.value?.tabs.map((t) => t.key).join('|'),
  async () => {
    await nextTick();
    for (const [key, el] of termEls) {
      if (!state.value?.tabs.some((t) => t.key === key)) {
        terms.get(key)?.term.dispose();
        terms.delete(key);
        termEls.delete(key);
        pending.delete(key);
      } else {
        mountTerm(key, el);
      }
    }
    // New tabs: their containers exist after this tick's render.
    await nextTick();
    for (const tab of state.value?.tabs ?? []) {
      const el = document.querySelector<HTMLElement>(`[data-term-key="${cssEscape(tab.key)}"]`);
      if (el !== null) mountTerm(tab.key, el);
    }
  },
);

watch(
  () => state.value?.activeKey,
  async (key) => {
    await nextTick();
    if (key === null || key === undefined) return;
    const entry = terms.get(key);
    if (entry) {
      entry.fit.fit();
      entry.term.focus();
      controller?.resizeTab(key, entry.term.cols, entry.term.rows);
    }
    sidebarOpen.value = false;
  },
);

function observeStage(el: Element | ComponentPublicInstance | null) {
  stageObserver?.disconnect();
  const htmlEl = el instanceof HTMLElement ? el : null;
  stageEl.value = htmlEl;
  if (htmlEl === null) return;
  stageObserver = new ResizeObserver(() => refit());
  stageObserver.observe(htmlEl);
}

function refit() {
  const key = state.value?.activeKey;
  if (key === null || key === undefined) return;
  const entry = terms.get(key);
  if (!entry) return;
  entry.fit.fit();
  controller?.resizeTab(key, entry.term.cols, entry.term.rows);
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

// --- sidebar actions ------------------------------------------------------

function openRow(row: SessionRow) {
  void controller?.openSession(row);
}

function askNew() {
  newError.value = '';
  newTag.value = '';
  showNew.value = true;
}

const workspaceOptions = computed(() => state.value?.groups.map((g) => g.workspace) ?? []);

function suggestTag() {
  const ws = newWorkspace.value.trim().replace(/\/+$/, '');
  if (ws === '') return;
  const leaf = ws.split('/').filter(Boolean).at(-1) ?? ws;
  const taken = new Set(
    (state.value?.rows ?? []).filter((r) => r.workspace === ws).map((r) => r.tag),
  );
  let candidate = leaf;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${leaf}-${n}`;
  newTag.value = candidate;
}

async function commitNew() {
  const ws = newWorkspace.value.trim();
  const tag = newTag.value.trim();
  if (ws === '' || tag === '' || controller === null) return;
  newError.value = '';
  const outcome = await controller.createSession(ws, tag);
  if (!outcome.ok && !outcome.liveRefusal) {
    newError.value = outcome.error ?? 'could not create the session';
    return;
  }
  showNew.value = false;
}

function askRename(row: SessionRow) {
  renameRow.value = row;
  renameTag.value = row.tag;
}

async function commitRename() {
  if (renameRow.value === null || controller === null) return;
  const tag = renameTag.value.trim();
  if (tag === '' || tag === renameRow.value.tag) {
    renameRow.value = null;
    return;
  }
  await controller.renameSession(renameRow.value, tag);
  renameRow.value = null;
}

function askKill(row: SessionRow) {
  killRow.value = row;
}

async function commitKill() {
  if (killRow.value === null || controller === null) return;
  await controller.killSession(killRow.value);
  killRow.value = null;
}

async function ack(sessionId: string) {
  await controller?.ackWarning(sessionId);
}

async function ackAll() {
  await controller?.ackAllWarnings();
}

async function refreshNow() {
  await controller?.refresh();
}

// --- display helpers ------------------------------------------------------

/** Compact sidebar age: `12m`, `3h`, `2d`, then a date (desktop §6). */
function compactAge(ms: number): string {
  const seconds = Math.max(0, Math.floor((now.value - ms) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return new Date(ms).toISOString().slice(0, 10);
}

const BUSY_STATUSES = new Set(['connecting…', 'reconnecting…']);
const busy = computed(
  () =>
    state.value === null ||
    BUSY_STATUSES.has(state.value.status) ||
    state.value.status.startsWith('host key'),
);
const statusState = computed(() => {
  const s = state.value;
  if (s === null) return 'is-busy';
  if (s.status === 'connected' && s.phase === 'ready') return 'is-connected';
  if (s.phase === 'failed' || s.status === 'disconnected') return 'is-down';
  if (BUSY_STATUSES.has(s.status) || s.status.startsWith('host key')) return 'is-busy';
  return s.phase === 'ready' ? 'is-connected' : 'is-busy';
});

/** Running tab rows get the live dot; gone/dead ones the muted word. */
function phaseWord(tab: { phase: string; live: boolean }): string {
  if (!tab.live) return 'closed';
  if (tab.phase === 'gone') return 'gone';
  return tab.phase;
}

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  if (nowTimer !== null) clearInterval(nowTimer);
  stageObserver?.disconnect();
  for (const { term } of terms.values()) term.dispose();
  terms.clear();
  controller?.dispose();
  controller = null;
});

function back() {
  router.push({ name: 'hosts' });
}
</script>

<template>
  <div class="term-screen ws-screen">
    <section class="term-card ws-card">
      <header class="topbar term-topbar">
        <button @click="back">← Hosts</button>
        <span class="term-mark" aria-hidden="true">&gt;_</span>
        <h1 class="term-title">{{ hostName }}</h1>
        <span class="spacer" />
        <span class="term-status muted" :class="statusState" role="status">
          <span v-if="busy" class="auth-spinner" aria-hidden="true" />
          {{ state?.status ?? 'connecting…' }}
        </span>
        <button
          class="ws-sidebar-toggle"
          :aria-expanded="sidebarOpen"
          @click="sidebarOpen = !sidebarOpen"
        >
          Sessions
        </button>
      </header>

      <div v-if="failed" class="terminal-wrap">
        <div class="term-notice" role="alert">
          <p class="error">{{ error }}</p>
          <button @click="back">← Hosts</button>
        </div>
      </div>

      <div v-else class="ws-body" :class="{ 'is-sidebar-open': sidebarOpen }">
        <aside class="ws-sidebar" aria-label="Sessions on this host">
          <section
            v-if="state?.warnings !== null && (state?.warnings?.length ?? 0) > 0"
            class="warn-banner"
            role="alert"
          >
            <div class="warn-head">
              <p class="warn-title">
                {{ state!.warnings!.length }} crash warning{{
                  state!.warnings!.length === 1 ? '' : 's'
                }}
              </p>
              <button :disabled="state?.actionBusy" @click="ackAll">Clear all</button>
            </div>
            <ul class="warn-list">
              <li v-for="w in state!.warnings" :key="w.session" class="warn-row">
                <span class="warn-kind" :class="w.kind === 'oom' ? 'is-oom' : 'is-crash'">
                  {{ w.kind === 'oom' ? 'OOM' : 'crash' }}
                </span>
                <!-- The zero-width space gives narrow drawers a clean wrap
                     point after the colon instead of orphaning the tag's
                     last character mid-token. -->
                <span class="warn-sel">{{ w.workspace }}:&#8203;{{ w.tag }}</span>
                <span class="warn-age">{{ formatAge(Date.now(), w.created_at_ms) }}</span>
                <button :disabled="state?.actionBusy" @click="ack(w.session)">Acknowledge</button>
              </li>
            </ul>
          </section>

          <div class="ws-side-head">
            <span class="ws-side-title">Sessions</span>
            <button class="ws-new" :disabled="state?.aplexer === false" @click="askNew">+ New</button>
          </div>

          <p v-if="state?.aplexer === false" class="ws-side-empty muted">
            This host has no aplexer (`a`), so PocketShell web cannot list sessions —
            you have a plain shell.
          </p>
          <p v-else-if="state?.phase !== 'ready'" class="ws-side-empty muted">loading…</p>
          <p v-else-if="state?.groups.length === 0" class="ws-side-empty muted">
            no sessions — start one with + New
          </p>

          <ul v-else class="ws-tree">
            <li v-for="g in state?.groups" :key="g.workspace" class="ws-group">
              <p class="ws-group-row" :title="g.workspace">
                <span class="ws-group-label">{{ g.workspace }}</span>
                <span class="ws-group-count">{{ g.rows.length }}</span>
              </p>
              <ul class="ws-rows">
                <li v-for="row in g.rows" :key="row.id">
                  <button
                    class="ws-row"
                    :class="{ 'is-active': activeTab?.key === `apx:${row.id}` }"
                    :title="`${g.workspace}:${row.tag} · ${row.engine} · ${row.phase}`"
                    @click="openRow(row)"
                  >
                    <span class="ws-row-dot" :class="row.phase === 'running' ? 'is-live' : 'is-idle'" aria-hidden="true" />
                    <span class="ws-row-name">{{ row.tag }}</span>
                    <span v-if="row.engine !== '' && row.engine !== 'shell'" class="ws-row-engine">{{ row.engine }}</span>
                    <span class="ws-row-age">{{ compactAge(row.activityMs) }}</span>
                    <span class="ws-row-actions">
                      <button class="ws-row-act" :aria-label="`Rename ${row.tag}`" @click.stop="askRename(row)">✎</button>
                      <button class="ws-row-act is-danger" :aria-label="`Stop ${row.tag}`" @click.stop="askKill(row)">✕</button>
                    </span>
                  </button>
                </li>
              </ul>
            </li>
          </ul>
        </aside>

        <div class="ws-main">
          <div class="ws-tabbar" role="tablist" aria-label="Open sessions">
            <button
              v-for="tab in state?.tabs"
              :key="tab.key"
              class="ws-tab"
              :class="{ 'is-active': tab.key === state?.activeKey, 'is-dead': !tab.live }"
              role="tab"
              :aria-selected="tab.key === state?.activeKey"
              :title="tab.subtitle === '' ? tab.label : `${tab.subtitle}:${tab.label}`"
              @click="controller?.setActive(tab.key)"
            >
              <span class="ws-tab-dot" :class="{ 'is-live': tab.live && tab.phase === 'running' }" aria-hidden="true" />
              <span class="ws-tab-label">{{ tab.label }}</span>
              <span class="ws-tab-phase">{{ phaseWord(tab) }}</span>
              <span class="ws-tab-close" aria-hidden="true" @click.stop="controller?.closeTab(tab.key)">✕</span>
            </button>
            <span class="ws-tabbar-spacer" />
            <button
              v-if="state?.phase === 'ready'"
              class="ws-tab-refresh"
              aria-label="Refresh sessions"
              :disabled="state?.actionBusy"
              @click="refreshNow"
            >
              ⟳
            </button>
          </div>

          <p v-if="state?.actionError" class="ws-action-error" role="alert">
            {{ state.actionError }}
            <button aria-label="Dismiss" @click="controller?.dismissActionError()">✕</button>
          </p>

          <div :ref="observeStage" class="ws-stage">
            <div
              v-for="tab in state?.tabs"
              v-show="tab.key === state?.activeKey"
              :key="tab.key"
              class="ws-pane"
              :data-term-key="tab.key"
            />
            <div v-if="state?.phase === 'ready' && state?.tabs.length === 0" class="ws-placeholder">
              <p class="ws-placeholder-title">No open terminals</p>
              <p class="muted">Pick a session from the sidebar, or start a new one.</p>
              <button class="button primary" @click="askNew">+ New session</button>
            </div>
            <div v-if="state?.phase !== 'ready' && !failed" class="ws-placeholder">
              <p class="muted">{{ state?.phase === 'probing' ? 'reading sessions…' : 'connecting…' }}</p>
            </div>
          </div>

          <footer class="ws-statusbar">
            <template v-if="activeTab">
              <span class="ws-status-sel">
                {{ rowForActive ? `${rowForActive.workspace}:${rowForActive.tag}` : activeTab.label }}
              </span>
              <span v-if="activeTab.engine && activeTab.engine !== 'shell'" class="ws-status-engine">{{ activeTab.engine }}</span>
              <span class="ws-status-phase" :class="{ 'is-live': activeTab.live && activeTab.phase === 'running' }">
                {{ activeTab.live ? phaseWord(activeTab).toUpperCase() : 'CLOSED' }}
              </span>
            </template>
            <template v-else-if="state?.phase === 'ready'">
              <span class="muted">{{ state?.aplexer === false ? 'plain shell' : 'no session open' }}</span>
            </template>
            <span class="ws-status-count muted" v-if="state?.phase === 'ready'">
              {{ state?.rows.length }} session{{ state?.rows.length === 1 ? '' : 's' }} · {{ state?.tabs.length }} open
            </span>
          </footer>
        </div>
      </div>

      <!-- New session -->
      <div v-if="showNew" class="ws-overlay" @click.self="showNew = false">
        <form class="ws-dialog" @submit.prevent="commitNew">
          <h2>New session</h2>
          <label class="flabel" for="ws-new-ws">Workspace folder (on the host)</label>
          <input
            id="ws-new-ws"
            v-model="newWorkspace"
            list="ws-workspaces"
            placeholder="~/git/my-project"
            autocomplete="off"
            spellcheck="false"
            @change="suggestTag"
          />
          <datalist id="ws-workspaces">
            <option v-for="ws in workspaceOptions" :key="ws" :value="ws" />
          </datalist>
          <label class="flabel" for="ws-new-tag">Session name</label>
          <input id="ws-new-tag" v-model="newTag" placeholder="main" autocomplete="off" spellcheck="false" />
          <p v-if="newError" class="error">{{ newError }}</p>
          <div class="ws-dialog-actions">
            <button type="button" @click="showNew = false">Cancel</button>
            <button type="submit" class="button primary" :disabled="state?.actionBusy || newWorkspace.trim() === '' || newTag.trim() === ''">
              {{ state?.actionBusy ? 'Starting…' : 'Start session' }}
            </button>
          </div>
        </form>
      </div>

      <!-- Rename -->
      <div v-if="renameRow !== null" class="ws-overlay" @click.self="renameRow = null">
        <form class="ws-dialog" @submit.prevent="commitRename">
          <h2>Rename session</h2>
          <p class="muted">{{ renameRow.workspace }}</p>
          <label class="flabel" for="ws-rename-tag">Session name</label>
          <input id="ws-rename-tag" v-model="renameTag" autocomplete="off" spellcheck="false" />
          <div class="ws-dialog-actions">
            <button type="button" @click="renameRow = null">Cancel</button>
            <button type="submit" class="button primary" :disabled="state?.actionBusy">Rename</button>
          </div>
        </form>
      </div>

      <!-- Stop confirm -->
      <div v-if="killRow !== null" class="ws-overlay" @click.self="killRow = null">
        <form class="ws-dialog" @submit.prevent="commitKill">
          <h2>Stop session</h2>
          <p>
            Stop <strong>{{ killRow.tag }}</strong> in
            <strong>{{ killRow.workspace }}</strong
            >? The workload is signalled and the session is removed on the host.
          </p>
          <div class="ws-dialog-actions">
            <button type="button" @click="killRow = null">Cancel</button>
            <button type="submit" class="button primary" :disabled="state?.actionBusy">Stop session</button>
          </div>
        </form>
      </div>
    </section>
  </div>
</template>
