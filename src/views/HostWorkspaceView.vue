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
import { decodeOsc52SetClipboard } from '@pocketshell/core';
import {
  HostWorkspaceController,
  leafOf,
  type ControllerState,
  type SessionRow,
  type WorkspaceLink,
} from '../workspace/controller';
import type { HostKeyInfo, KnownHostsHooks, TofuDecision } from '../terminal/connection';
import { useHostPinsStore } from '../stores/hostPins';
import FilesPane from './FilesPane.vue';
import { WorkspaceSftp } from '../workspace/sftp';
import { formatAge } from '../aplexer/warningsParse';
import { acceptedInput, liveAgentKind, paletteFor, sendComposerLine } from '../workspace/composer';
import type { AgentCommand } from '@pocketshell/core';
import {
  agentBadges,
  buildLaunchCommand,
  dirTooltip,
  fmtRelative,
  kindUnavailableReason,
  KIND_LABELS,
  LAUNCHABLE_KINDS,
  profileFlagName,
  profilesFor,
  rootHeaderParts,
  rootHostPath,
  rootTooltip,
  supportsProfiles,
  supportsSkipPermissions,
  type HostAgentSupport,
  type LaunchableKind,
  type SessionDirectory,
  type SessionRootFolder,
} from '@pocketshell/core';
import { config } from '../config';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const hosts = useHostsStore();
const pins = useHostPinsStore();
/** The Files tab's SFTP transport — one per workspace dial. */
const filesSftp = shallowRef<WorkspaceSftp | null>(null);

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

// --- host-key (TOFU) state -------------------------------------------------
/** An unknown key awaiting the first-connect decision. */
const hostKeyPrompt = ref<HostKeyInfo | null>(null);
/** A key that CHANGED against its pin — the connect was refused. */
const hostKeyMismatch = ref<HostKeyInfo | null>(null);
let decideHostKeyResolve: ((d: TofuDecision) => void) | null = null;
let currentLink: WorkspaceLink | null = null;

function decideHostKey(d: TofuDecision) {
  const resolve = decideHostKeyResolve;
  decideHostKeyResolve = null;
  hostKeyPrompt.value = null;
  resolve?.(d);
}

function askHostKey(info: HostKeyInfo): Promise<TofuDecision> {
  hostKeyPrompt.value = info;
  return new Promise((resolve) => {
    decideHostKeyResolve = resolve;
  });
}

async function forgetPinAndReconnect() {
  hostKeyMismatch.value = null;
  if (currentLink !== null) await pins.forget(currentLink.host, currentLink.port);
  await controller?.start();
}

/** The pins store behind the connection's TOFU hooks — the browser's
 * known_hosts, with the prompt and mismatch surfaces as Vue state. */
const knownHosts: KnownHostsHooks = {
  lookup: (host, port) => pins.lookup(host, port),
  pin: (host, port, pin) => pins.pin(host, port, pin),
  decide: askHostKey,
  onMismatch: (info) => {
    hostKeyMismatch.value = info;
  },
};

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

  controller = new HostWorkspaceController({ link, knownHosts });
  currentLink = link;
  filesSftp.value = new WorkspaceSftp(controller.connection);
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
      if (tab.key === 'files') continue; // no PTY — the FilesPane renders there
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

// Choosing a folder is navigation too: the drawer gets out of the way (narrow
// screens), the same contract the active-tab watcher already honours.
watch(
  () => state.value?.activeFolder,
  () => {
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

/**
 * The folder whose workspace the tab bar shows, out of the same tree the
 * sidebar renders — one derivation, two readers, so the marked row and the
 * open workspace can never disagree.
 */
const activeFolderDir = computed<SessionDirectory | null>(() => {
  const key = state.value?.activeFolder;
  if (key === null || key === undefined) return null;
  return state.value?.roots.flatMap((r) => r.directories).find((d) => d.key === key) ?? null;
});

/** One tab in the bar: a folder session (maybe not attached yet), or a
 * chrome tab (Files, raw shell) straight from the controller. */
interface BarTab {
  key: string;
  label: string;
  subtitle: string;
  phase: string;
  live: boolean;
  /** The tab's PTY/channel exists — it can be activated without a join. */
  open: boolean;
  /** A session tab (rename/stop apply) rather than Files/shell chrome. */
  session: boolean;
}

/**
 * The tab bar. With a folder open it is the desktop's model: one tab per
 * session IN the folder, attached or not, then any stray open tabs (another
 * folder's attach, a session the snapshot dropped — kept so it can be
 * closed), then the chrome tabs. Without a folder it is yesterday's bar:
 * exactly the open tabs.
 */
const barTabs = computed<BarTab[]>(() => {
  const s = state.value;
  if (!s) return [];
  const asBar = (t: {
    key: string;
    label: string;
    subtitle: string;
    phase: string;
    live: boolean;
  }): BarTab => ({
    ...t,
    open: true,
    session: t.key.startsWith('apx:'),
  });
  const dir = activeFolderDir.value;
  if (!dir) return s.tabs.map(asBar);
  const openByKey = new Map(s.tabs.map((t) => [t.key, t]));
  const folder: BarTab[] = dir.rows.map((r) => {
    const key = `apx:${r.session.aplexerId ?? ''}`;
    const open = openByKey.get(key);
    return {
      key,
      label: r.session.tag ?? r.session.name,
      subtitle: leafOf(r.session.workspace ?? r.session.path ?? ''),
      phase: open?.phase ?? r.session.aplexerPhase ?? 'running',
      live: open?.live ?? false,
      open: open !== undefined,
      session: true,
    };
  });
  const folderKeys = new Set(folder.map((t) => t.key));
  const strays = s.tabs
    .filter((t) => t.key.startsWith('apx:') && !folderKeys.has(t.key))
    .map(asBar);
  const chrome = s.tabs.filter((t) => !t.key.startsWith('apx:')).map(asBar);
  return [...folder, ...strays, ...chrome];
});

function onTabClick(tab: BarTab) {
  if (!tab.open && tab.session) {
    const row = state.value?.rows.find((r) => `apx:${r.id}` === tab.key);
    if (row) void controller?.openSession(row);
    return;
  }
  controller?.setActive(tab.key);
}

// --- tab context menu (rename / stop — where the sidebar rows' ✎ ✕ went) ---

const tabMenu = ref<{ tab: BarTab; x: number; y: number } | null>(null);

function openTabMenu(tab: BarTab, event: MouseEvent) {
  if (!tab.session) return;
  tabMenu.value = { tab, x: event.clientX, y: event.clientY };
}

const tabMenuRow = computed<SessionRow | null>(() => {
  const key = tabMenu.value?.tab.key;
  if (key === undefined) return null;
  return state.value?.rows.find((r) => `apx:${r.id}` === key) ?? null;
});

function closeTabMenu() {
  tabMenu.value = null;
}

function renameFromTabMenu() {
  const row = tabMenuRow.value;
  closeTabMenu();
  if (row) askRename(row);
}

function stopFromTabMenu() {
  const row = tabMenuRow.value;
  closeTabMenu();
  if (row) askKill(row);
}

function askNew() {
  newError.value = '';
  newTag.value = '';
  launchAgent.value = false;
  showNew.value = true;
  // The picker asks the HOST which agents its helper can start — one
  // `--help` exec per open, never cached, so a helper upgraded mid-connection
  // is offered without a reconnect (the desktop's contract).
  void controller?.probeAgent();
}

const workspaceOptions = computed(() => [
  ...new Set((state.value?.rows ?? []).map((r) => r.workspace).filter((w) => w !== '')),
]);

/** Where the root `+` starts the dialog: the root's real directory, or no
 * prefill when its `$HOME` never resolved (the desktop picker's behaviour). */
function newInRoot(root: SessionRootFolder) {
  const path = rootHostPath(root.key, state.value?.home ?? null);
  newError.value = '';
  newTag.value = '';
  newWorkspace.value = path ?? '';
  if (path !== '') suggestTag();
  launchAgent.value = false;
  showNew.value = true;
  void controller?.probeAgent();
}

function rootAddTitle(root: SessionRootFolder): string {
  return rootHostPath(root.key, state.value?.home ?? null) === null
    ? `cannot resolve $HOME on this host, so ${root.label} has no directory to start in`
    : `New session in ${root.key}`;
}

// --- agent launch step ------------------------------------------------------

const launchAgent = ref(false);
const launchKind = ref<LaunchableKind>('claude');
/** Host default is skip-permissions ON; the only informative answer is no. */
const launchSkipPerms = ref(true);
const launchProfile = ref<string | null>(null);

/**
 * The four launchable engines, each with the host's own reason when it
 * cannot start here. Until the probe answers, baseline kinds stay offered
 * and grok says "checking…" — kindUnavailableReason owns every sentence.
 */
const agentKindRows = computed(() => {
  const support: HostAgentSupport =
    state.value?.agentSupport ?? { subcommands: null, probing: state.value?.agentProbing ?? false };
  return LAUNCHABLE_KINDS.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    reason: kindUnavailableReason(kind, support),
  }));
});

const profileOptions = computed(() => profilesFor(launchKind.value, state.value?.agentProfiles ?? []));

watch(launchKind, () => {
  // The engine's default profile is pre-selected and sent as ABSENT: naming
  // it adds a flag that can fail in exchange for no change in behaviour.
  launchProfile.value = profileOptions.value.find((p) => p.default)?.name ?? null;
});

/** The exact line the host will receive, shown before it is typed. */
const launchLinePreview = computed(() => {
  const ws = newWorkspace.value.trim();
  if (ws === '') return null;
  return buildLaunchCommand({
    kind: launchKind.value,
    dir: ws,
    skipPermissions: launchSkipPerms.value,
    profile: profileFlagName(launchProfile.value, profileOptions.value),
  });
});

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
  let outcome;
  if (launchAgent.value) {
    outcome = await controller.launchAgentSession(
      {
        kind: launchKind.value,
        dir: ws,
        skipPermissions: launchSkipPerms.value,
        profile: profileFlagName(launchProfile.value, profileOptions.value),
      },
      ws,
      tag,
    );
  } else {
    outcome = await controller.createSession(ws, tag);
  }
  if (!outcome.ok && !outcome.liveRefusal) {
    newError.value = outcome.error ?? 'could not create the session';
    // The controller also strips this into the workspace-level notice; the
    // dialog is showing the same sentence inline, so the strip stays quiet.
    controller.dismissActionError();
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

// --- session composer ------------------------------------------------------

const composerInput = ref('');
const composerBusy = ref(false);
const composerIndex = ref(0);
/** Esc or an acceptance closes the palette until the text changes again. */
const paletteDismissed = ref(false);

const activeAgent = computed(() => liveAgentKind(activeTab.value?.engine));
const paletteRows = computed(() => {
  if (paletteDismissed.value) return [];
  return paletteFor(composerInput.value, activeAgent.value);
});

watch(
  () => state.value?.activeKey,
  () => {
    composerInput.value = '';
    composerIndex.value = 0;
    paletteDismissed.value = false;
  },
);

function onComposerInput() {
  paletteDismissed.value = false;
  composerIndex.value = 0;
}

function acceptCommand(command: AgentCommand) {
  composerInput.value = acceptedInput(command);
  paletteDismissed.value = true;
}

function onComposerKeydown(event: KeyboardEvent) {
  const rows = paletteRows.value;
  if (rows.length > 0) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      composerIndex.value = (composerIndex.value + step + rows.length) % rows.length;
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      paletteDismissed.value = true;
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      acceptCommand(rows[composerIndex.value]);
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) void sendLine();
}

async function sendLine() {
  const key = state.value?.activeKey;
  const session = controller;
  const text = composerInput.value;
  if (key === null || key === undefined || session === null || composerBusy.value) return;
  composerBusy.value = true;
  try {
    const wrote = await sendComposerLine(text, (data) =>
      Promise.resolve(session.deliverToTab(key, data)),
    );
    // A refused body keeps the text: a dead session never eats a prompt.
    if (wrote) composerInput.value = '';
  } finally {
    composerBusy.value = false;
  }
}

// --- display helpers ------------------------------------------------------

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

          <!-- The desktop panel's header strip, minus the buttons a browser
               has no overlay to open: the workspace owns no ports/usage/
               settings surfaces here, and back lives in the topbar. -->
          <div class="ws-side-head">
            <span class="ws-side-title">Sessions</span>
            <button
              class="ws-icon-btn"
              title="New session in any folder"
              :disabled="state?.aplexer === false"
              @click="askNew"
            >
              +
            </button>
            <button
              class="ws-icon-btn"
              title="Refresh sessions"
              :disabled="state?.actionBusy"
              @click="refreshNow"
            >
              ⟳
            </button>
          </div>

          <p v-if="state?.aplexer === false" class="ws-side-empty muted">
            This host has no aplexer (`a`), so PocketShell web cannot list sessions —
            you have a plain shell.
          </p>
          <p v-else-if="state?.phase !== 'ready'" class="ws-side-empty muted">loading…</p>

          <!-- The desktop's folder view: root sections over folder rows, one
               row per directory — the tree derivation is @pocketshell/core's
               groupSessionsIntoRoots, the SAME function the desktop panel
               renders, so both clients group a host identically. -->
          <div v-else class="ws-folders">
            <section v-for="root in state?.roots" :key="root.key" class="ws-root">
              <!-- A grouping header, not a node: no chevron, no click. The
                   `~/` recedes into its own span; the count hugs the label;
                   the `+` appears on hover/focus. -->
              <div class="ws-root-header" :title="rootTooltip(root)">
                <span class="ws-dot" :class="{ 'is-active': root.active }" />
                <span class="ws-root-label" :class="{ 'is-bucket': root.other }">
                  <span v-if="rootHeaderParts(root).prefix" class="ws-path-prefix">{{
                    rootHeaderParts(root).prefix
                  }}</span>{{ rootHeaderParts(root).text }}
                </span>
                <span class="ws-dir-count">{{ root.sessionCount }}</span>
                <button
                  v-if="!root.other"
                  class="ws-root-add"
                  :title="rootAddTitle(root)"
                  @click.stop="newInRoot(root)"
                >
                  +
                </button>
              </div>

              <ul class="ws-dir-list">
                <li v-if="!root.directories.length" class="ws-empty-root muted">
                  no sessions here yet
                </li>
                <!-- ONE ROW PER FOLDER: the row IS the destination; its
                     sessions are the tabs of the workspace it opens. -->
                <li v-for="dir in root.directories" :key="dir.key">
                  <button
                    class="ws-dir-row"
                    :class="{
                      'is-current': dir.key === state?.activeFolder,
                      'is-attached': dir.active,
                      'is-orphan': dir.untracked,
                    }"
                    :title="dirTooltip(dir)"
                    @click="controller?.openFolder(dir.key)"
                  >
                    <span class="ws-dot" :class="{ 'is-active': dir.active }" />
                    <span class="ws-dir-label" :class="{ 'is-mono': dir.untracked }">{{
                      dir.label
                    }}</span>
                    <!-- Counted only from 2 up, beside the label, ahead of
                         the badges — the desktop row's exact field order. -->
                    <span v-if="dir.rows.length > 1" class="ws-dir-count">
                      {{ dir.rows.length }}
                    </span>
                    <span
                      v-for="badge in agentBadges(dir)"
                      :key="badge"
                      class="ws-badge"
                      :class="{ 'is-dim': badge === 'probing…' || badge === 'exited' }"
                    >
                      {{ badge }}
                    </span>
                    <!-- The folder's age is its NEWEST session's. -->
                    <span class="ws-dir-age">{{ fmtRelative(dir.mostRecentActivity, now) }}</span>
                  </button>
                </li>
              </ul>
            </section>

            <!-- The desktop tree's empty state: what is empty AND the way
                 out of it. -->
            <div v-if="!state?.roots.length" class="ws-empty-panel">
              <p class="muted">no sessions</p>
              <button @click="askNew">New session…</button>
            </div>
          </div>
        </aside>

        <div class="ws-main">
          <!-- The desktop folder-workspace bar: every session IN the open
               folder is a tab, attached or not — clicking an unattached one
               joins it. Then strays, then chrome, then Files. -->
          <div class="ws-tabbar" role="tablist" aria-label="Workspace tabs">
            <button
              v-for="tab in barTabs"
              :key="tab.key"
              class="ws-tab"
              :class="{
                'is-active': tab.key === state?.activeKey,
                'is-dead': tab.open && !tab.live && tab.key !== 'files',
                'is-detached': tab.session && !tab.open,
              }"
              role="tab"
              :aria-selected="tab.key === state?.activeKey"
              :title="tab.subtitle === '' ? tab.label : `${tab.subtitle}:${tab.label}`"
              @click="onTabClick(tab)"
              @contextmenu.prevent="openTabMenu(tab, $event)"
            >
              <span class="ws-tab-dot" :class="{ 'is-live': tab.live && tab.phase === 'running' }" aria-hidden="true" />
              <span class="ws-tab-label">{{ tab.label }}</span>
              <span v-if="tab.key !== 'files' && (tab.open || !tab.session)" class="ws-tab-phase">{{ phaseWord(tab) }}</span>
              <span v-if="tab.open" class="ws-tab-close" aria-hidden="true" @click.stop="controller?.closeTab(tab.key)">✕</span>
            </button>
            <!-- Files: one click away at the bar's end, the desktop bar's
                 Files slot. Opened lazily — the tab exists only once visited. -->
            <button
              v-if="state?.phase === 'ready'"
              class="ws-tab ws-tab-files"
              :class="{ 'is-active': state?.activeKey === 'files' }"
              role="tab"
              :aria-selected="state?.activeKey === 'files'"
              title="Files (SFTP)"
              @click="controller?.openFilesTab()"
            >
              <span class="ws-tab-label">Files</span>
              <span
                v-if="state?.tabs.some((t) => t.key === 'files')"
                class="ws-tab-close"
                aria-hidden="true"
                @click.stop="controller?.closeTab('files')"
              >✕</span>
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
            >
              <FilesPane v-if="tab.key === 'files' && filesSftp !== null" :sftp="filesSftp" />
            </div>
            <div v-if="state?.phase === 'ready' && state?.tabs.length === 0" class="ws-placeholder">
              <p class="ws-placeholder-title">No open terminals</p>
              <p class="muted">Pick a session from the sidebar, or start a new one.</p>
              <button class="button primary" @click="askNew">+ New session</button>
            </div>
            <div v-if="state?.phase !== 'ready' && !failed" class="ws-placeholder">
              <p class="muted">{{ state?.phase === 'probing' ? 'reading sessions…' : 'connecting…' }}</p>
              <template v-if="state?.phase === 'failed'">
                <p class="error" role="alert">{{ state.error }}</p>
                <button class="button" @click="controller?.start()">Try again</button>
              </template>
            </div>
          </div>

          <form v-if="activeTab && activeTab.key !== 'files'" class="ws-composer" @submit.prevent="sendLine">
            <div v-if="paletteRows.length > 0" class="ws-palette" role="listbox" aria-label="Agent commands">
              <button
                v-for="(c, i) in paletteRows"
                :key="c.command"
                type="button"
                role="option"
                :aria-selected="i === composerIndex"
                :class="{ 'is-picked': i === composerIndex }"
                @mousemove="composerIndex = i"
                @click="acceptCommand(c)"
              >
                <span class="ws-palette-cmd">{{ c.command }}</span>
                <span class="ws-palette-label">{{ c.label }}</span>
                <span class="ws-palette-desc">{{ c.description }}</span>
              </button>
            </div>
            <textarea
              id="ws-composer-input"
              v-model="composerInput"
              class="ws-composer-input"
              rows="1"
              :placeholder="activeAgent ? `Message ${activeAgent}…` : 'Type a command…'"
              :aria-label="activeAgent ? `Message the ${activeAgent} session` : 'Send to the session'"
              :disabled="!activeTab.live || composerBusy"
              @keydown="onComposerKeydown"
              @input="onComposerInput"
            />
            <button
              class="button primary ws-composer-send"
              type="submit"
              :disabled="!activeTab.live || composerBusy || composerInput.trim() === ''"
            >
              {{ composerBusy ? 'Sending…' : 'Send' }}
            </button>
          </form>

          <footer class="ws-statusbar">
            <template v-if="activeTab">
              <span class="ws-status-sel">
                {{ rowForActive ? `${rowForActive.workspace}:${rowForActive.tag}` : activeTab.label }}
              </span>
              <span v-if="activeTab.engine && activeTab.engine !== 'shell' && activeTab.key !== 'files'" class="ws-status-engine">{{ activeTab.engine }}</span>
              <span class="ws-status-phase" :class="{ 'is-live': activeTab.live && activeTab.phase === 'running' }">
                {{ activeTab.live ? phaseWord(activeTab).toUpperCase() : activeTab.key === 'files' ? 'SFTP' : 'CLOSED' }}
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

      <!-- The tab menu: rename and stop live HERE now, where the old sidebar
           rows' ✎ ✕ used to — the desktop moved the same operations into its
           tab bar when the rows became folder rows. -->
      <div v-if="tabMenu !== null" class="ws-menu-backdrop" @click="closeTabMenu" @contextmenu.prevent="closeTabMenu">
        <div
          class="ws-tab-menu"
          role="menu"
          :aria-label="`Actions for ${tabMenu.tab.label}`"
          :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
          @click.stop
        >
          <p class="ws-tab-menu-head">{{ tabMenu.tab.label }}</p>
          <button role="menuitem" :disabled="tabMenuRow === null" @click="renameFromTabMenu">Rename…</button>
          <button role="menuitem" class="is-danger" :disabled="tabMenuRow === null" @click="stopFromTabMenu">Stop…</button>
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

          <section class="ws-launch" aria-label="Agent launch">
            <label class="ws-launch-toggle">
              <input v-model="launchAgent" type="checkbox" />
              <span>Launch an agent in this session</span>
            </label>
            <template v-if="launchAgent">
              <div class="ws-launch-kinds" role="radiogroup" aria-label="Agent">
                <label
                  v-for="row in agentKindRows"
                  :key="row.kind"
                  class="ws-launch-kind"
                  :class="{ 'is-off': row.reason !== null }"
                >
                  <input
                    v-model="launchKind"
                    type="radio"
                    name="ws-agent-kind"
                    :value="row.kind"
                    :disabled="row.reason !== null"
                  />
                  <span class="ws-launch-kind-label">{{ row.label }}</span>
                  <span v-if="row.reason !== null" class="ws-launch-kind-reason">{{ row.reason }}</span>
                </label>
              </div>
              <label v-if="supportsSkipPermissions(launchKind)" class="ws-launch-toggle">
                <input v-model="launchSkipPerms" type="checkbox" />
                <span>Skip permission prompts</span>
              </label>
              <template v-if="supportsProfiles(launchKind) && profileOptions.length > 0">
                <label class="flabel" for="ws-launch-profile">Profile</label>
                <select id="ws-launch-profile" v-model="launchProfile">
                  <option :value="null">Engine default</option>
                  <option v-for="p in profileOptions" :key="p.name" :value="p.name">
                    {{ p.name }}{{ p.default ? ' (default)' : '' }}
                  </option>
                </select>
              </template>
              <p v-if="launchLinePreview !== null" class="ws-launch-line">{{ launchLinePreview }}</p>
            </template>
          </section>

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

      <!-- First-connect host key (TOFU). No outside-click dismiss: the
           decision is explicit, the handshake is paused until it is made. -->
      <div v-if="hostKeyPrompt !== null" class="ws-overlay">
        <div class="ws-dialog" role="alertdialog" aria-labelledby="ws-tofu-title">
          <h2 id="ws-tofu-title">First connect to {{ hostName }}</h2>
          <p>
            The server's identity could not be verified against a saved pin — expected
            on a first connect. Check the fingerprint out of band if you can.
          </p>
          <p class="ws-launch-line">{{ hostKeyPrompt.keyType }} · {{ hostKeyPrompt.fingerprint }}</p>
          <p class="muted">
            Connect and pin remembers this key; a later connect presenting a different
            key will be refused.
          </p>
          <div class="ws-dialog-actions">
            <button type="button" @click="decideHostKey('reject')">Cancel</button>
            <button type="button" @click="decideHostKey('once')">Connect once</button>
            <button type="button" class="button primary" @click="decideHostKey('always')">Connect and pin</button>
          </div>
        </div>
      </div>

      <!-- Host key changed against its pin -->
      <div v-if="hostKeyMismatch !== null" class="ws-overlay">
        <div class="ws-dialog" role="alertdialog" aria-labelledby="ws-mismatch-title">
          <h2 id="ws-mismatch-title">Host key changed</h2>
          <p>
            The server's key is not the pinned key from a previous connect, so the
            connection was refused. This is expected if the server was rebuilt or its
            key was rotated on purpose; otherwise stop and investigate.
          </p>
          <p class="ws-launch-line">{{ hostKeyMismatch.keyType }} · {{ hostKeyMismatch.fingerprint }}</p>
          <div class="ws-dialog-actions">
            <button type="button" @click="hostKeyMismatch = null">Dismiss</button>
            <button type="button" class="button primary" @click="forgetPinAndReconnect">
              Remove pin &amp; reconnect
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
