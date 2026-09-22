<script setup lang="ts">
/**
 * The Files tab's pane — an SFTP browser over the workspace's live
 * connection, the desktop's file browser narrowed to the web's first
 * contract: walk the tree, open a text file, edit it, save it back.
 * The transport (`WorkspaceSftp`) never throws for a host "no"; every
 * failure lands here as a sentence next to the thing that failed.
 */
import { computed, onMounted, ref } from 'vue';
import { WorkspaceSftp, MAX_TEXT_READ_BYTES, type DirEntry } from '../workspace/sftp';
import { formatBytes } from '../shared/byteSize';

const props = defineProps<{ sftp: WorkspaceSftp }>();

const path = ref('');
const homePath = ref('');
const entries = ref<DirEntry[]>([]);
const loading = ref(false);
const error = ref('');

const openPath = ref('');
const openName = ref('');
const text = ref('');
const saved = ref('');
const dirty = computed(() => text.value !== saved.value);
const saveBusy = ref(false);
const saveError = ref('');
const editorTooBig = computed(() => text.value.length > MAX_TEXT_READ_BYTES);

/** dirs first, each alphabetical; the list is the pane's stable shape. */
const sorted = computed(() =>
  [...entries.value].sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  }),
);

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }));
});

const parentPath = computed(() =>
  crumbs.value.length > 1 ? crumbs.value[crumbs.value.length - 2]?.path ?? '/' : '/',
);

async function go(to: string): Promise<void> {
  loading.value = true;
  error.value = '';
  const out = await props.sftp.list(to);
  loading.value = false;
  if (out.ok) {
    path.value = to;
    entries.value = out.value;
  } else {
    error.value = out.error;
  }
}

async function open(entry: DirEntry): Promise<void> {
  if (entry.type === 'dir' || entry.type === 'symlink') {
    await go(join(path.value, entry.name));
    return;
  }
  const full = join(path.value, entry.name);
  loading.value = true;
  error.value = '';
  const out = await props.sftp.readText(full);
  loading.value = false;
  if (out.ok) {
    openPath.value = full;
    openName.value = entry.name;
    text.value = out.value;
    saved.value = out.value;
    saveError.value = '';
  } else {
    error.value = out.error;
  }
}

async function save(): Promise<void> {
  saveBusy.value = true;
  saveError.value = '';
  const out = await props.sftp.writeFile(openPath.value, text.value);
  saveBusy.value = false;
  if (out.ok) saved.value = text.value;
  else saveError.value = out.error;
}

function closeEditor(): void {
  openPath.value = '';
  openName.value = '';
  text.value = '';
  saved.value = '';
  saveError.value = '';
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function sizeLabel(entry: DirEntry): string {
  if (entry.type !== 'file') return '';
  return formatBytes(entry.size);
}

function ageLabel(entry: DirEntry): string {
  if (entry.modifyTime === 0) return '';
  const s = Math.max(1, Math.round((Date.now() - entry.modifyTime) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

onMounted(async () => {
  const home = await props.sftp.home();
  homePath.value = home.ok ? home.value : '/';
  await go(homePath.value);
});
</script>

<template>
  <div class="ws-files">
    <nav class="ws-files-crumbs" aria-label="Path">
      <button class="ws-files-home" title="Home" @click="go(homePath)">~</button>
      <span class="muted">/</span>
      <template v-for="(c, i) in crumbs" :key="c.path">
        <button class="ws-files-crumb" @click="go(c.path)">{{ c.name }}</button>
        <span v-if="i < crumbs.length - 1" class="muted">/</span>
      </template>
    </nav>

    <p v-if="error" class="error ws-files-error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="muted">loading…</p>

    <div v-if="openPath" class="ws-files-editor">
      <div class="ws-files-editor-bar">
        <strong class="ws-files-editor-name">{{ openName }}</strong>
        <span v-if="dirty" class="ws-files-dirty" title="Unsaved changes">edited</span>
        <span class="ws-files-editor-actions">
          <button @click="closeEditor">Close</button>
          <button class="button primary" :disabled="!dirty || saveBusy || editorTooBig" @click="save">
            {{ saveBusy ? 'Saving…' : 'Save' }}
          </button>
        </span>
      </div>
      <p v-if="saveError" class="error" role="alert">{{ saveError }}</p>
      <p v-if="editorTooBig" class="error" role="alert">
        Over the {{ Math.floor(MAX_TEXT_READ_BYTES / 1000) }} KB edit cap — shrink the file before saving.
      </p>
      <textarea
        v-model="text"
        class="ws-files-textarea"
        spellcheck="false"
        aria-label="File contents"
      />
    </div>

    <ul v-else class="ws-files-list">
      <li v-if="crumbs.length > 0">
        <button class="ws-files-row" @click="go(parentPath)">
          <span class="ws-files-name muted">..</span>
        </button>
      </li>
      <li v-for="e in sorted" :key="e.name">
        <button class="ws-files-row" @click="open(e)">
          <span class="ws-files-name" :class="{ 'is-dir': e.type === 'dir' }">{{ e.name }}</span>
          <span class="ws-files-meta muted">{{ e.type === 'dir' ? '' : sizeLabel(e) }}</span>
          <span class="ws-files-meta muted">{{ ageLabel(e) }}</span>
        </button>
      </li>
      <li v-if="!loading && sorted.length === 0" class="muted ws-files-empty">empty directory</li>
    </ul>
  </div>
</template>
