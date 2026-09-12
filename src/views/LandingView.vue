<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { blogPosts } from '../generated/blog-posts';
import { ghHistory } from '../generated/gh-history';

const auth = useAuthStore();
// Tease the four newest posts; the full list lives at /blog. tmux-centric
// posts stay off the marketing page — PocketShell's session layer is aplexer,
// not tmux — so the blog is their only home.
const latestPosts = blogPosts
  .filter((p) => !/tmux/i.test(`${p.title} ${p.description}`))
  .slice(0, 4);

// The only conversion path is the Google sign-in on /login; a signed-in
// visitor skips straight past it to the app.
function ctaTo() {
  return { name: auth.signedIn ? 'hosts' : 'login' } as const;
}

// ---- The interactive desktop mock ----------------------------------------
//
// The hero recreates the desktop window and it is actually clickable: a
// folder row opens that folder's workspace, a tab switches the session, and
// the terminal + composer follow. Same shapes as the app: panel is
// root -> folder (SESSIONLIST.md), the tab bar carries the folder's
// sessions with their agent marks (agentMark.ts: hexagon = Claude Code,
// code = Codex), and a session with no cwd is a mono-label row.

interface MockTab {
  id: string;
  label: string;
  /** Agent mark icon; absent = plain shell or the Files tab. */
  mark?: string;
  term: string;
  draft: string;
}

interface MockFolder {
  id: string;
  root: 'git' | 'other';
  label: string;
  /** Green status dot: something in the folder is attached. */
  attached?: boolean;
  /** Session count; the app shows one only from 2 up. */
  count?: number;
  badges?: string[];
  time: string;
  /** Untracked row: labelled by the session's name, in mono. */
  mono?: boolean;
  activeTab: string;
  tabs: MockTab[];
}

const mockFolders = reactive<MockFolder[]>([
  {
    id: 'pocketshell',
    root: 'git',
    label: 'pocketshell',
    attached: true,
    count: 2,
    badges: ['claude', 'codex'],
    time: '6m',
    activeTab: 'review',
    tabs: [
      {
        id: 'review',
        label: 'review',
        mark: 'hexagon',
        draft: 'run the full suite, then update the PR description with what moved',
        term: `<span class="t-bullet">●</span> Update(src/agent/merge.ts)
  <span class="t-dim">└  src/agent/merge.ts ·</span> <span class="t-add">+12</span> <span class="t-del">−8</span>

<span class="t-bullet">●</span> Bash(npm test -- merge)
  <span class="t-dim">└</span>  <span class="t-add">✓ 14 tests passing</span> <span class="t-dim">(2.4s)</span>

<span class="t-bullet">●</span> Merge logic now lives in
  mergeSessions() — all three
  callers hand off to it instead
  of re-implementing the diff.
  PR notes updated.

<span class="t-run">✻</span> <span class="t-dim">Refactoring… (esc · 2h 6m)</span>`,
      },
      {
        id: 'api-fix',
        label: 'api-fix',
        mark: 'code',
        draft: 'ship it — bump the patch version and tag',
        term: `<span class="t-bullet">●</span> Update(src/api/handlers.ts)
  <span class="t-dim">└  src/api/handlers.ts ·</span> <span class="t-add">+9</span> <span class="t-del">−3</span>

<span class="t-bullet">●</span> Bash(npm run lint)
  <span class="t-dim">└</span>  <span class="t-add">✓ no issues</span> <span class="t-dim">(1.1s)</span>

<span class="t-bullet">●</span> The 500s came from a missing
  await on the session lookup —
  retries raced the close. Added
  the await and a regression test.

<span class="t-run">✻</span> <span class="t-dim">Patching… (esc · 6m)</span>`,
      },
      {
        id: 'spec',
        label: 'spec',
        draft: 'check the spec index for stale links',
        term: `<span class="t-prompt">$</span> npm run spec:check
<span class="t-green">✓</span> <span class="t-dim">12 specs · 0 failed · 1.8s</span>

<span class="t-prompt">$</span> <span class="cursor">█</span>`,
      },
      {
        id: 'files',
        label: 'Files',
        draft: '',
        term: `<span class="t-dir">src/</span>
<span class="t-dir">src/agent/</span>
  merge.ts
  merge.test.ts
  types.ts
<span class="t-dir">docs/</span>
package.json
README.md`,
      },
    ],
  },
  {
    id: 'dtc-website',
    root: 'git',
    label: 'dtc-website',
    badges: ['codex'],
    time: '3h',
    activeTab: 'git-dtc-website',
    tabs: [
      {
        id: 'git-dtc-website',
        label: 'git-dtc-website',
        mark: 'code',
        draft: 'tighten the pricing page copy too',
        term: `<span class="t-bullet">●</span> Update(content/courses.mdx)
  <span class="t-dim">└  content/courses.mdx ·</span> <span class="t-add">+21</span> <span class="t-del">−6</span>

<span class="t-bullet">●</span> Rewrote the cohort section
  lead and trimmed the FAQ
  answers to two sentences each.

<span class="t-run">✻</span> <span class="t-dim">Editing… (esc · 3h 12m)</span>`,
      },
    ],
  },
  {
    id: 'aplexer',
    root: 'git',
    label: 'aplexer',
    time: '3d',
    activeTab: 'spec',
    tabs: [
      {
        id: 'spec',
        label: 'spec',
        draft: 'summarise the open questions from the sync doc',
        term: `<span class="t-prompt">$</span> ./scripts/lint-docs
<span class="t-green">✓</span> <span class="t-dim">stylelint clean · 4.2s</span>

<span class="t-prompt">$</span> <span class="cursor">█</span>`,
      },
    ],
  },
  {
    id: 'dataops',
    root: 'git',
    label: 'dataops',
    time: '22h',
    activeTab: 'git-dataops',
    tabs: [
      {
        id: 'git-dataops',
        label: 'git-dataops',
        draft: "re-run yesterday's rollup",
        term: `<span class="t-prompt">$</span> make rollup
<span class="t-dim">daily rollup finished · 3 partitions</span>

<span class="t-prompt">$</span> <span class="cursor">█</span>`,
      },
    ],
  },
  {
    id: 'backup-script',
    root: 'other',
    label: 'backup-script',
    mono: true,
    time: '5d',
    activeTab: 'backup-script',
    tabs: [
      {
        id: 'backup-script',
        label: 'backup-script',
        draft: 'why did the 4am run skip Tuesday?',
        term: `<span class="t-prompt">$</span> crontab -l | grep backup
<span class="t-dim">0 4 * * * /usr/local/bin/backup.sh</span>

<span class="t-prompt">$</span> <span class="cursor">█</span>`,
      },
    ],
  },
]);

const selectedFolder = ref('pocketshell');
const gitFolders = computed(() => mockFolders.filter((f) => f.root === 'git'));
const otherFolders = computed(() => mockFolders.filter((f) => f.root === 'other'));
const activeFolder = computed(
  () => mockFolders.find((f) => f.id === selectedFolder.value) ?? mockFolders[0],
);
const activeTab = computed(
  () =>
    activeFolder.value.tabs.find((t) => t.id === activeFolder.value.activeTab) ??
    activeFolder.value.tabs[0],
);

function openFolder(id: string) {
  selectedFolder.value = id;
}

function selectTab(id: string) {
  activeFolder.value.activeTab = id;
}

// ---- The contribution calendar -------------------------------------------
//
// The "keep your agents busy" figure is drawn by the page from a snapshot
// synced by scripts/sync-gh-history.py (run it occasionally; it does not
// need to be fresh). Geometry mirrors GitHub's calendar: Sunday-first week
// columns, 10px cells on a 13px pitch, GitHub's dark level colors on the
// card's #0d1117 matte.

const CELL = 10;
const PITCH = CELL + 3;
const PAD_LEFT = 30;
const PAD_TOP = 18;

const LEVEL_COLORS = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface GraphDay {
  date: string;
  count: number;
  x: number;
  y: number;
  level: number;
}

const dayDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

// Levels are quartiles over the nonzero days, like GitHub's own coloring.
const cutoffs = (() => {
  const counts = ghHistory.weeks
    .flatMap((w) => w.days.map((d) => d.count))
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  const at = (q: number) => counts[Math.min(counts.length - 1, Math.floor(counts.length * q))] ?? 1;
  return [at(0.25), at(0.5), at(0.75)] as const;
})();

const graphDays: GraphDay[] = ghHistory.weeks.flatMap((w, wi) =>
  w.days.map((d) => ({
    date: d.date,
    count: d.count,
    x: PAD_LEFT + wi * PITCH,
    y: PAD_TOP + dayDate(d.date).getUTCDay() * PITCH,
    level:
      d.count <= 0
        ? 0
        : d.count <= cutoffs[0]
          ? 1
          : d.count <= cutoffs[1]
            ? 2
            : d.count <= cutoffs[2]
              ? 3
              : 4,
  })),
);

const graphWidth = PAD_LEFT + (ghHistory.weeks.length - 1) * PITCH + CELL + 8;
const graphHeight = PAD_TOP + 6 * PITCH + CELL + 4;

// Labels: the first week carries its own month; after that, a month is
// labeled at the first week that ends in it. Comparing against the previous
// week's Saturday catches months that start mid-week and months that start
// on a Sunday alike — one label per month, no collisions.
const monthLabels = (() => {
  const out: { x: number; name: string }[] = [];
  ghHistory.weeks.forEach((w, wi) => {
    const first = w.days[0];
    const last = w.days[w.days.length - 1];
    if (!first || !last) return;
    const b = dayDate(last.date);
    if (wi === 0) {
      out.push({ x: PAD_LEFT, name: MONTHS[dayDate(first.date).getUTCMonth()] });
      return;
    }
    const prev = ghHistory.weeks[wi - 1];
    const prevLast = dayDate(prev.days[prev.days.length - 1].date);
    if (prevLast.getUTCMonth() !== b.getUTCMonth()) {
      out.push({ x: PAD_LEFT + wi * PITCH, name: MONTHS[b.getUTCMonth()] });
    }
  });
  return out;
})();

const wdayLabels = [
  { name: 'Mon', row: 1 },
  { name: 'Wed', row: 3 },
  { name: 'Fri', row: 5 },
].map((w) => ({ name: w.name, y: PAD_TOP + w.row * PITCH + CELL - 2 }));

const fmtGraphDay = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    dayDate(iso),
  );

const fmtSynced = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(
  new Date(`${ghHistory.syncedAt}T00:00:00Z`),
);
</script>

<template>
  <div class="landing">
    <header class="topbar landing-topbar">
      <div class="topbar-rail">
        <RouterLink class="brand" :to="{ name: 'landing' }"
          ><span class="brand-mark">&gt;_</span> PocketShell</RouterLink
        >
        <nav class="site-nav">
          <a class="nav-link" href="#features">Features</a>
          <a class="nav-link" href="#how">How it works</a>
          <a class="nav-link" href="#security">Security</a>
          <a class="nav-link" href="#faq">FAQ</a>
          <a class="nav-link" href="/blog">Blog</a>
        </nav>
        <span class="spacer" />
        <RouterLink class="button" :to="ctaTo()">{{ auth.signedIn ? 'Open app' : 'Sign in' }}</RouterLink>
      </div>
    </header>

    <main>
      <section class="hero container">
        <div class="hero-copy">
          <p class="eyebrow">Agent-aware SSH, in a browser tab</p>
          <h1>Drop in on your AI agents from any browser tab.</h1>
          <p class="sub">
            Your agents run on your own machines. PocketShell opens a real
            terminal to them&nbsp;— sign in with Google, click a host, and see
            exactly where Claude Code, Codex, or OpenCode left off. Your
            browser is the terminal.
          </p>
          <div class="cta-row">
            <RouterLink class="button primary large" :to="ctaTo()">
              {{ auth.signedIn ? 'Open your hosts' : 'Sign in with Google' }}
            </RouterLink>
            <a class="text-link" href="#how">See how it works</a>
          </div>
          <p class="cta-note">Free · access is currently allowlisted · servers run the PocketShell CLI and nothing else</p>
          <ul class="chips" aria-label="Key facts">
            <li class="chip">Zero-knowledge sync</li>
            <li class="chip">Keys stay local</li>
            <li class="chip">Sessions live on your machine</li>
          </ul>
        </div>
        <section id="fact-strip" aria-label="Key facts">
          <ul class="fact-strip">
            <li class="fact"><strong>AES-256-GCM · PBKDF2 600k</strong>zero-knowledge, end-to-end</li>
            <li class="fact"><strong>Claude Code · Codex · OpenCode · Grok</strong>first-class sessions, not hidden panes</li>
            <li class="fact"><strong>Real xterm.js terminal</strong>scrollback, copy/paste, resize</li>
            <li class="fact"><strong>iPad · Chromebook · phone</strong>any browser tab works</li>
          </ul>
        </section>
        <div class="hero-visual" role="group" aria-label="Interactive preview of the PocketShell desktop app — click the folders and tabs">
          <!-- The PocketShell desktop window, recreated from the app itself
               and clickable: session panel (root -> folder tree, agent
               badges), the folder workspace's tab bar with agent marks, the
               live session in the terminal, and the prompt composer. Tokens
               match the app's dark theme (pocketshell-electron App.vue). -->
          <svg class="icon-defs" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <symbol id="mi-arrow-left" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></symbol>
              <symbol id="mi-ports" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></symbol>
              <symbol id="mi-usage" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></symbol>
              <symbol id="mi-refresh" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></symbol>
              <symbol id="mi-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></symbol>
              <symbol id="mi-collapse" viewBox="0 0 24 24"><polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" /></symbol>
              <symbol id="mi-hexagon" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></symbol>
              <symbol id="mi-code" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></symbol>
              <symbol id="mi-plus" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></symbol>
              <symbol id="mi-close" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></symbol>
              <symbol id="mi-attach" viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></symbol>
              <symbol id="mi-terminal" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></symbol>
            </defs>
          </svg>
          <div class="desktop-mock">
            <div class="bar">
              <span class="dot" /><span class="dot" /><span class="dot" />
              <span class="title">edge-1&nbsp;— pocketshell</span>
            </div>
            <div class="desk-body">
              <aside class="desk-side">
                <div class="side-head">
                  <span class="side-btn"><svg><use href="#mi-arrow-left" /></svg></span>
                  <span class="side-spacer" />
                  <span class="side-btn"><svg><use href="#mi-ports" /></svg></span>
                  <span class="side-btn"><svg><use href="#mi-usage" /></svg></span>
                  <span class="side-btn"><svg><use href="#mi-refresh" /></svg></span>
                  <span class="side-btn"><svg><use href="#mi-gear" /></svg></span>
                  <span class="side-btn"><svg><use href="#mi-collapse" /></svg></span>
                </div>
                <div class="side-tree">
                  <div class="root-row">
                    <span class="sdot on" />
                    <span class="dlabel">git</span>
                    <span class="count">5</span>
                    <span class="row-add"><svg><use href="#mi-plus" /></svg></span>
                  </div>
                  <button
                    v-for="f in gitFolders"
                    :key="f.id"
                    type="button"
                    class="dir-row"
                    :class="{ current: f.id === selectedFolder }"
                    :aria-current="f.id === selectedFolder ? 'true' : undefined"
                    @click="openFolder(f.id)"
                  >
                    <span class="sdot" :class="{ on: f.attached }" />
                    <span class="dlabel" :class="{ mono: f.mono }">{{ f.label }}</span>
                    <span v-if="f.count" class="count">{{ f.count }}</span>
                    <span v-for="b in f.badges" :key="b" class="badge">{{ b }}</span>
                    <span class="time">{{ f.time }}</span>
                  </button>
                  <div class="root-row">
                    <span class="sdot" />
                    <span class="dlabel">other</span>
                    <span class="count">1</span>
                  </div>
                  <button
                    v-for="f in otherFolders"
                    :key="f.id"
                    type="button"
                    class="dir-row"
                    :class="{ current: f.id === selectedFolder }"
                    :aria-current="f.id === selectedFolder ? 'true' : undefined"
                    @click="openFolder(f.id)"
                  >
                    <span class="sdot" :class="{ on: f.attached }" />
                    <span class="dlabel" :class="{ mono: f.mono }">{{ f.label }}</span>
                    <span class="time">{{ f.time }}</span>
                  </button>
                </div>
              </aside>
              <section class="desk-main">
                <div class="tabbar">
                  <button
                    v-for="t in activeFolder.tabs"
                    :key="t.id"
                    type="button"
                    class="tab"
                    :class="{ on: t.id === activeFolder.activeTab }"
                    :aria-current="t.id === activeFolder.activeTab ? 'true' : undefined"
                    @click="selectTab(t.id)"
                  >
                    <svg v-if="t.mark"><use :href="`#mi-${t.mark}`" /></svg>{{ t.label }}<span class="tab-x"><svg><use href="#mi-close" /></svg></span>
                  </button>
                  <span class="tab-add"><svg><use href="#mi-plus" /></svg></span>
                </div>
                <div class="desk-term">
                  <!-- Authored constants from mockFolders; v-html only ever
                       renders those markup spans. -->
                  <pre v-html="activeTab.term" />
                </div>
                <div class="desk-composer">
                  <div class="comp-head">
                    <span class="comp-title">Prompt</span>
                    <span class="comp-x"><svg><use href="#mi-close" /></svg></span>
                  </div>
                  <div class="comp-draft">{{ activeTab.draft }}</div>
                  <div class="comp-controls">
                    <span class="comp-tool"><svg><use href="#mi-attach" /></svg></span>
                    <span class="comp-tool"><svg><use href="#mi-terminal" /></svg></span>
                    <span class="comp-hint">Enter send · Shift+Enter newline</span>
                    <span class="comp-send">Send</span>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </section>

      <section id="how" class="band">
        <div class="container">
          <h2>From zero to your agents in three steps</h2>
          <ol class="steps">
            <li class="step">
              <span class="num">1</span>
              <h3>Your hosts are already there</h3>
              <p>Sign in with the same Google account the desktop app syncs with&nbsp;— your host list is already yours.</p>
            </li>
            <li class="step">
              <span class="num">2</span>
              <h3>Only you can read them</h3>
              <p>Enter your sync passphrase once to decrypt the host list. It never leaves this browser.</p>
            </li>
            <li class="step">
              <span class="num">3</span>
              <h3>Click a host, drop in on a session</h3>
              <p>Click Connect&nbsp;— a full terminal opens in the tab. Your agent sessions are already running on the machine; you're just attaching to them.</p>
            </li>
          </ol>
        </div>
      </section>

      <section id="features" class="band">
        <div class="container">
          <h2>Why a browser tab beats another terminal app</h2>
          <div class="frow">
            <div class="frow-copy">
              <h3>Your hosts, already there</h3>
              <p class="outcome">
                Hosts saved in the desktop app appear on the web automatically&nbsp;— no re-entering
                addresses, users, and ports a second time. The sync is zero-knowledge: the blob is
                encrypted in your browser before it leaves it, and the server stores ciphertext it
                can't read.
              </p>
              <ul class="chips" aria-label="Highlights">
                <li class="chip">Zero-knowledge sync</li>
                <li class="chip">AES-256-GCM</li>
                <li class="chip">Passphrase never leaves the device</li>
              </ul>
              <a class="text-link" href="/blog/ssh-config-file">Keep ~/.ssh/config tidy across machines</a>
            </div>
            <div class="frow-visual">
              <div class="hosts-mock" aria-hidden="true">
                <div class="hosts-bar">Hosts <span class="pill">synced · encrypted</span></div>
                <div class="hosts-row"><span class="hname">edge-1</span><span class="hmeta">deploy@203.0.113.10:22</span><span class="hbtn">Connect</span></div>
                <div class="hosts-row"><span class="hname">db-prod</span><span class="hmeta">admin@db.internal:22</span><span class="hbtn">Connect</span></div>
                <div class="hosts-row"><span class="hname">ci-runner</span><span class="hmeta">root@10.0.4.17:2222</span><span class="hbtn">Connect</span></div>
              </div>
            </div>
          </div>

          <div class="frow frow--flip">
            <div class="frow-copy">
              <h3>Agent sessions that outlive the tab</h3>
              <p class="outcome">
                Sessions live on your machine, managed by aplexer&nbsp;— the session
                layer that knows whether Claude Code, Codex, OpenCode, or Grok
                is running in each one. Close the laptop mid-refactor;
                from any browser, attach again and the screen is exactly where
                the agent left it&nbsp;— full xterm.js in the tab, not a
                screen-sharing approximation.
              </p>
              <ul class="chips" aria-label="Highlights">
                <li class="chip">Full scrollback</li>
                <li class="chip">Reattach anywhere</li>
                <li class="chip">Survives disconnects</li>
              </ul>
              <a class="text-link" href="/blog/ssh-ai-agents-remote-machines">Run AI agents on a remote machine over SSH</a>
            </div>
            <div class="frow-visual">
              <div class="term-mock" aria-hidden="true">
                <div class="bar">
                  <span class="dot" /><span class="dot" /><span class="dot" />
                  <span class="title">edge-1&nbsp;— api-fix</span>
                </div>
                <pre><span class="t-prompt">$</span> a attach api-fix
<span class="t-green">●</span> codex&nbsp;— working (6m)
  <span class="t-dim">✓ auth middleware tested</span>
  <span class="t-dim">→ editing src/api/handlers.ts</span>
<span class="t-prompt">$</span> <span class="cursor">█</span></pre>
              </div>
            </div>
          </div>

          <div class="frow">
            <div class="frow-copy">
              <h3>Works where clients can't</h3>
              <p class="outcome">
                iPad, Chromebook, a locked-down work laptop&nbsp;— if it has a browser, it's your
                terminal. Nothing to install, and private keys never sync: a key you
                attach stays encrypted in this browser, and when you connect it
                travels once, over the authenticated WebSocket, to the PocketShell
                bridge&nbsp;— used in memory to open your session, never stored there.
              </p>
              <ul class="chips" aria-label="Highlights">
                <li class="chip">Keys never sync</li>
                <li class="chip">Nothing to install</li>
                <li class="chip">Any modern browser</li>
              </ul>
              <a class="text-link" href="/blog/ssh-authorized-keys-hardening">One key per device: SSH keys, hardened</a>
            </div>
            <div class="frow-visual">
              <div class="devices" aria-hidden="true">
                <div class="device device--laptop">
                  <div class="screen"><span /><span class="hl" /><span /><span /></div>
                  <div class="base" />
                </div>
                <div class="device device--tablet"><div class="screen"><span /><span /><span class="hl" /><span /></div></div>
                <div class="device device--phone"><div class="screen"><span class="hl" /><span /><span /></div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="apps" class="band">
        <div class="container">
          <h2>One account, three ways in</h2>
          <p class="band-sub">PocketShell is a family: the same hosts, the same agent sessions, on every device you work from.</p>
          <div class="cards">
            <div class="card">
              <h3>Desktop</h3>
              <p>
                The keyboard-first home base. A session tree with an agent badge
                on every session, a prompt composer, file browser, port
                forwards, and provider quota. Hosts come straight from
                <code>~/.ssh/config</code>; a small helper on the box reads the
                rest.
              </p>
            </div>
            <div class="card">
              <h3>Android</h3>
              <p>
                Voice-first. Check on your agents from your phone, dictate
                prompts and commands, and unlock key passphrases biometrically.
              </p>
            </div>
            <div class="card">
              <h3>Web</h3>
              <p>
                This one. A real terminal to any synced host, in a browser tab&nbsp;— for iPads, Chromebooks, and locked-down machines where you
                can't install anything.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="security" class="band">
        <div class="container">
          <div class="security">
            <div class="security-copy">
              <h2>Zero-knowledge by design</h2>
              <p>No badges, no promises&nbsp;— this is the actual data path, step by step.</p>
              <ol class="sec-flow">
                <li class="sec-item">
                  <span class="n">01</span>
                  <h3>Passphrase stays local</h3>
                  <p>Typed once per session and used in your browser, never sent&nbsp;— there is no server-side reset, because the server never had it.</p>
                </li>
                <li class="sec-item">
                  <span class="n">02</span>
                  <h3>PBKDF2, 600,000 iterations</h3>
                  <p>The encryption key is derived from your passphrase with PBKDF2-SHA256, so the stored blob resists offline guessing.</p>
                </li>
                <li class="sec-item">
                  <span class="n">03</span>
                  <h3>AES-256-GCM before sync</h3>
                  <p>The host list is encrypted before it leaves the browser. The sync server stores ciphertext it cannot read.</p>
                </li>
                <li class="sec-item">
                  <span class="n">04</span>
                  <h3>Keys never sync at all</h3>
                  <p>SSH private keys are entered per host and encrypted with your passphrase in that one browser. On connect, a key goes once to the PocketShell bridge over the authenticated WebSocket and is used in memory to open the session&nbsp;— the sync server never sees it.</p>
                </li>
              </ol>
              <p class="sec-bridge">
                On your servers, the one dependency is the PocketShell CLI&nbsp;— it
                hosts the agent sessions (aplexer is the session layer) that
                every PocketShell app attaches to.
              </p>
              <RouterLink class="button primary large" :to="ctaTo()">
                {{ auth.signedIn ? 'Open your hosts' : 'Sign in with Google' }}
              </RouterLink>
            </div>
          </div>
        </div>
      </section>

      <section id="opensource" class="band">
        <div class="container">
          <div class="oss">
            <div class="oss-copy">
              <h2>Keep your agents busy at work</h2>
              <p>
                This is the GitHub contribution graph of the author,
                <a href="https://github.com/alexeygrigorev">Alexey Grigorev</a>&nbsp;— a
                year of working on many projects in parallel, with agents
                running in PocketShell sessions on his machines and check-ins
                from a phone, a tablet, a laptop. Keep yours just as busy:
                sign in, pick a host, and drop in on what they're doing right now.
              </p>
            </div>
            <figure class="oss-figure">
              <div class="oss-meta">
                <span class="oss-total">{{ ghHistory.total.toLocaleString('en-US') }} contributions in the last year</span>
                <span class="oss-legend" aria-hidden="true">Less<i v-for="(c, i) in LEVEL_COLORS" :key="i" :style="{ background: c }" />More</span>
              </div>
              <a
                class="oss-graph"
                href="https://github.com/alexeygrigorev"
                aria-label="GitHub contribution calendar for alexeygrigorev — follow along on GitHub"
              >
                <!-- Drawn from the synced snapshot (scripts/sync-gh-history.py);
                     per-rect <title> gives the hover tooltip for free. -->
                <svg
                  class="contrib"
                  :viewBox="`0 0 ${graphWidth} ${graphHeight}`"
                  role="img"
                  :aria-label="`${ghHistory.total} contributions by alexeygrigorev in the last year`"
                >
                  <text v-for="m in monthLabels" :key="`m${m.x}`" class="contrib-month" :x="m.x" y="12">{{ m.name }}</text>
                  <text v-for="w in wdayLabels" :key="w.name" class="contrib-wday" :x="PAD_LEFT - 6" :y="w.y">{{ w.name }}</text>
                  <rect
                    v-for="d in graphDays"
                    :key="d.date"
                    :x="d.x"
                    :y="d.y"
                    :width="CELL"
                    :height="CELL"
                    rx="2"
                    :fill="LEVEL_COLORS[d.level]"
                  >
                    <title>{{ d.count === 0 ? 'No contributions' : `${d.count} contribution${d.count === 1 ? '' : 's'}` }} on {{ fmtGraphDay(d.date) }}</title>
                  </rect>
                </svg>
              </a>
              <figcaption>
                Synced from GitHub on {{ fmtSynced }}&nbsp;— a snapshot, not a
                live feed. The live version is on
                <a href="https://github.com/alexeygrigorev">GitHub</a>.
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section id="blog" class="band">
        <div class="container">
          <h2>From the blog</h2>
          <p class="band-sub">Practical notes on SSH, remote machines, and running AI agents on them&nbsp;— the kind of things you'll want a terminal for.</p>
          <div class="cards blog-cards">
            <a v-for="post in latestPosts" :key="post.slug" class="card card-link" :href="`/blog/${post.slug}`">
              <h3>{{ post.title }}</h3>
              <p>{{ post.description }}</p>
              <span class="card-meta">{{ post.readingMinutes }} min read</span>
            </a>
          </div>
          <p class="band-more"><a class="text-link" href="/blog">All posts →</a></p>
        </div>
      </section>

      <section id="faq" class="band">
        <div class="container">
          <h2>Frequently asked questions</h2>
          <div class="faq">
            <details>
              <summary>Who can see my host list?</summary>
              <p>
                Only you. The list is encrypted in your browser before it
                syncs&nbsp;— PBKDF2 with 600,000 iterations derives the key from
                your sync
                passphrase, AES-256-GCM encrypts the blob. The server stores
                ciphertext it cannot read, and the passphrase never leaves your
                device.
              </p>
            </details>
            <details>
              <summary>Is my SSH private key safe?</summary>
              <p>
                Private keys never sync. A key you attach to a host is
                encrypted with your sync passphrase and stored only in this
                browser. When you connect, the key travels once, over the
                authenticated WebSocket (WSS), to the PocketShell bridge&nbsp;—
                which uses it in memory to open your SSH session and neither
                stores nor logs it. The sync server never sees key material.
              </p>
            </details>
            <details>
              <summary>Do I need the desktop app?</summary>
              <p>
                No. The Android app works on its own. The one awkward part is
                getting an SSH key onto your phone, so we suggest configuring
                the key in the web or desktop app first, then using the mobile
                version from there.
              </p>
            </details>
            <details>
              <summary>Do I need to install anything on my servers?</summary>
              <p>
                Yes&nbsp;— the PocketShell CLI. That's the one thing to install on
                each host you want in PocketShell. Your agent sessions live on
                the machine&nbsp;— aplexer is the session layer that hosts
                them&nbsp;— and the desktop, web, and Android apps all work
                against those
                sessions. Nothing else to install.
              </p>
            </details>
            <details>
              <summary>Which devices can I use?</summary>
              <p>
                Anything with a modern browser: Linux, macOS, Windows,
                Chromebooks, iPads, and Android tablets&nbsp;— including locked-down
                machines where you can't install software.
              </p>
            </details>
            <details>
              <summary>What happens to my session when the tab closes?</summary>
              <p>
                The terminal in the tab ends with it&nbsp;— your agent doesn't.
                Sessions live on your machine under aplexer, the same session
                layer the PocketShell desktop and Android apps attach to.
                Reconnect from any browser, attach again, and the screen is
                exactly where your agent left it.
              </p>
            </details>
            <details>
              <summary>What if I lose my sync passphrase?</summary>
              <p>
                Then the synced blob is undecryptable&nbsp;— by design. Zero-knowledge
                means there is no reset: you set a new passphrase, re-upload
                your hosts, and re-encrypt the SSH key with it. That's the trade
                for a server that can never read your synced data.
              </p>
            </details>
            <details>
              <summary>What does it cost?</summary>
              <p>
                For now, nothing&nbsp;— PocketShell is in active alpha development,
                and it's free. Later, the open-source version stays free;
                syncing between your devices is the part that will be paid.
              </p>
            </details>
          </div>
        </div>
      </section>

      <section class="band">
        <div class="container">
          <div class="final-cta">
            <!-- Brand illustration: generated art in the site's dark/green palette. -->
            <img
              class="final-cta-visual"
              src="/images/landing-agents.webp"
              alt=""
              width="1536"
              height="1024"
              loading="lazy"
            />
            <h2>Your agents are still running.</h2>
            <p>Check on them from any browser tab&nbsp;— same hosts, same account as the desktop app.</p>
            <RouterLink class="button primary large" :to="ctaTo()">
              {{ auth.signedIn ? 'Open your hosts' : 'Sign in with Google' }}
            </RouterLink>
          </div>
        </div>
      </section>
    </main>

    <footer class="landing-footer">
      <div class="footer-row">
        <span class="foot-brand"><span class="brand-mark">&gt;_</span> PocketShell</span>
        <span class="foot-dim">Built by Alexey Grigorev&nbsp;— a developer who wanted his servers from an iPad.</span>
        <nav class="footer-nav">
          <RouterLink :to="{ name: 'landing', hash: '#features' }">Features</RouterLink>
          <RouterLink :to="{ name: 'landing', hash: '#how' }">How it works</RouterLink>
          <RouterLink :to="{ name: 'landing', hash: '#security' }">Security</RouterLink>
          <RouterLink :to="{ name: 'landing', hash: '#faq' }">FAQ</RouterLink>
          <a href="/blog">Blog</a>
          <a href="https://github.com/alexeygrigorev">GitHub</a>
          <RouterLink :to="ctaTo()">{{ auth.signedIn ? 'Open app' : 'Sign in' }}</RouterLink>
        </nav>
      </div>
    </footer>
  </div>
</template>
