<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';
import { normalizeHostDraft } from '../hostForm';
import { parseSshConfigText } from '../sshConfigImport';
import type { HostEntry } from '../shared/types';

const auth = useAuthStore();
const hosts = useHostsStore();
const router = useRouter();

const passphrase = ref('');
const unlocking = ref(false);
const keyDraft = ref('');
const keyHost = ref<HostEntry | null>(null);
const keySaved = ref('');
const keyRemoved = ref('');
const keyPassphrase = ref('');
const keyFileName = ref('');

const formOpen = ref(false);
const draft = ref({ name: '', hostname: '', port: '22', user: '' });
const draftIsEdit = ref(false);
const saving = ref(false);
const formError = ref('');
const hostSaved = ref('');

const importOpen = ref(false);
const importStep = ref<'choose' | 'select' | 'missing'>('choose');
const importFileName = ref('');
const importText = ref('');
const parsed = ref<ReturnType<typeof parseSshConfigText> | null>(null);
const selectedNames = ref<string[]>([]);
const importedNames = ref<string[]>([]);
const importError = ref('');
const importing = ref(false);
const importDone = ref('');
/** The key dialog was opened from the import's credentials step. */
const importResume = ref(false);

onMounted(() => {
  // Unsigned visitors poking /app get the sign-in screen, not a host error.
  if (!auth.signedIn) router.replace({ name: 'login' });
});

async function unlock() {
  unlocking.value = true;
  hosts.error = '';
  try {
    await hosts.unlock(passphrase.value);
  } catch (e) {
    hosts.error = e instanceof Error ? e.message : String(e);
  } finally {
    unlocking.value = false;
  }
}

function describe(host: HostEntry): string {
  return `${host.user ? `${host.user}@` : ''}${host.hostname}:${host.port}`;
}

function newHost() {
  draft.value = { name: '', hostname: '', port: '22', user: '' };
  draftIsEdit.value = false;
  formOpen.value = true;
  keyHost.value = null;
  importOpen.value = false;
  formError.value = '';
}

function editHost(host: HostEntry) {
  draft.value = { name: host.name, hostname: host.hostname, port: String(host.port), user: host.user };
  draftIsEdit.value = true;
  formOpen.value = true;
  keyHost.value = null;
  importOpen.value = false;
  formError.value = '';
}

async function saveHost() {
  const base = hosts.hosts.find((host) => host.name === draft.value.name.trim());
  const res = normalizeHostDraft(draft.value, base);
  if (!res.ok) {
    formError.value = res.error;
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    await hosts.saveHost(res.entry);
    hostSaved.value = res.entry.name;
    formOpen.value = false;
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

/* --- Private key per host ------------------------------------------------ */

function attachKey(host: HostEntry) {
  keyHost.value = host;
  keyDraft.value = '';
  keyPassphrase.value = '';
  keyFileName.value = '';
  keySaved.value = '';
  formOpen.value = false;
  importOpen.value = false;
}

async function onKeyFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  // Read locally; the key joins the encrypted local store on Save, nothing else.
  keyDraft.value = await file.text();
  keyFileName.value = file.name;
  input.value = '';
}

async function saveKey() {
  if (keyHost.value === null) return;
  const pem = keyDraft.value.trim();
  const secret = pem === ''
    ? {}
    : { privateKeyPem: pem, ...(keyPassphrase.value === '' ? {} : { keyPassphrase: keyPassphrase.value }) };
  await hosts.setHostSecret(keyHost.value.name, secret);
  keySaved.value = keyHost.value.name;
  keyHost.value = null;
  if (importResume.value) {
    importResume.value = false;
    if (missingCredentials.value.length > 0) {
      importOpen.value = true;
      importStep.value = 'missing';
    } else {
      finishImport();
    }
  }
}

async function removeKey(host: HostEntry) {
  await hosts.removeHostSecret(host.name);
  keySaved.value = '';
  keyRemoved.value = host.name;
}

/* --- Import from an SSH config ------------------------------------------- */

function startImport() {
  importOpen.value = true;
  importStep.value = 'choose';
  importFileName.value = '';
  importText.value = '';
  parsed.value = null;
  selectedNames.value = [];
  importedNames.value = [];
  importError.value = '';
  keyHost.value = null;
  formOpen.value = false;
}

async function onConfigFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  importText.value = await file.text();
  importFileName.value = file.name;
  input.value = '';
}

/** Rows where the name is already in the synced list. */
function isSynced(name: string): boolean {
  return hosts.hosts.some((host) => host.name === name);
}

function parseImport() {
  importError.value = '';
  parsed.value = parseSshConfigText(importText.value);
  const total = parsed.value.hosts.length + parsed.value.skippedPatterns;
  if (total === 0) {
    importError.value = 'No Host entries found in that config — check the file and try again.';
    parsed.value = null;
    return;
  }
  // New hosts tick themselves; ones already in the account need a deliberate
  // re-tick, because importing them overwrites the synced entry.
  selectedNames.value = parsed.value.hosts.filter((p) => !isSynced(p.entry.name)).map((p) => p.entry.name);
  importStep.value = 'select';
}

const importSelection = computed<HostEntry[]>(() =>
  parsed.value?.hosts.filter((p) => selectedNames.value.includes(p.entry.name)).map((p) => p.entry) ?? [],
);

/** Imported hosts this browser has no key for — the "missing information"
 * the flow asks about before the user walks away. */
const missingCredentials = computed(() => importedNames.value.filter((name) => !hosts.secretHosts.includes(name)));

function addKeyForImported(host: HostEntry) {
  importResume.value = true;
  attachKey(host);
}

async function doImport() {
  if (importSelection.value.length === 0) return;
  importing.value = true;
  importError.value = '';
  try {
    const entries = importSelection.value;
    await hosts.importHosts(entries);
    importedNames.value = entries.map((entry) => entry.name);
    hostSaved.value = '';
    if (missingCredentials.value.length > 0) {
      importStep.value = 'missing';
    } else {
      finishImport();
    }
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e);
  } finally {
    importing.value = false;
  }
}

function finishImport() {
  importDone.value = `Imported ${importedNames.value.length} ${importedNames.value.length === 1 ? 'host' : 'hosts'} — desktops pick them up on their next sync.`;
  importOpen.value = false;
}

function cancelImport() {
  importOpen.value = false;
}

function open(host: HostEntry) {
  router.push({ name: 'term', params: { name: host.name } });
}
</script>

<template>
  <main class="page">
    <h1>Hosts</h1>

    <div v-if="!hosts.unlocked">
      <p class="muted">Enter the sync passphrase to decrypt your saved hosts (they never leave this browser unencrypted).</p>
      <form @submit.prevent="unlock">
        <input v-model="passphrase" type="password" placeholder="Sync passphrase" autofocus />
        <button class="primary" type="submit" :disabled="unlocking || passphrase === ''">
          {{ unlocking ? 'Decrypting…' : 'Unlock' }}
        </button>
      </form>
      <p v-if="hosts.error" class="error">{{ hosts.error }}</p>
    </div>

    <div v-else :class="{ empty: hosts.hosts.length === 0 && !formOpen && !importOpen }">
      <div class="list-head">
        <span v-if="hosts.hosts.length === 0" class="muted">
          No hosts synced yet — import your SSH config, add one here, or tick hosts in the desktop app and let it push.
        </span>
        <span class="spacer" />
        <button @click="startImport">Import config</button>
        <button class="primary" @click="newHost">Add host</button>
      </div>

      <details v-if="formOpen" class="keybox" open>
        <summary>{{ draftIsEdit ? `Edit ${draft.name}` : 'New host — stored encrypted in your account; desktops pick it up on their next sync' }}</summary>
        <form class="hostform" @submit.prevent="saveHost">
          <input v-model="draft.name" class="f-name" placeholder="Name (e.g. prod-box)" :disabled="draftIsEdit" autofocus />
          <input v-model="draft.hostname" class="f-host" placeholder="Hostname" />
          <input v-model="draft.user" class="f-user" placeholder="User (optional)" />
          <input v-model="draft.port" class="f-port" placeholder="Port" inputmode="numeric" />
          <button class="primary" type="submit" :disabled="saving || draft.hostname.trim() === ''">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
          <button type="button" @click="formOpen = false">Cancel</button>
        </form>
        <p v-if="formError" class="error">{{ formError }}</p>
      </details>

      <details v-if="importOpen" class="keybox" open>
        <summary>Import from SSH config — parsed in this browser; the file itself never leaves it</summary>

        <div v-if="importStep === 'choose'">
          <p class="muted import-hint">
            Load your <code>~/.ssh/config</code> (or paste it), then pick the hosts to sync.
            Ticked hosts join your account encrypted, like the rest of the list.
          </p>
          <div class="import-choose">
            <input type="file" class="f-config" aria-label="SSH config file" @change="onConfigFile" />
            <button type="button" :disabled="importText.trim() === ''" @click="parseImport">Parse hosts</button>
          </div>
          <textarea v-model="importText" placeholder="…or paste the config text here" aria-label="SSH config text" />
        </div>

        <div v-else-if="importStep === 'select'">
          <p class="muted import-hint">
            Parsed {{ parsed!.hosts.length }} {{ parsed!.hosts.length === 1 ? 'host' : 'hosts' }} from
            <strong>{{ importFileName || 'pasted config' }}</strong
            ><span v-if="parsed!.skippedPatterns > 0"> — {{ parsed!.skippedPatterns }} host {{ parsed!.skippedPatterns === 1 ? 'pattern' : 'patterns' }} skipped (wildcards can't be dialed directly)</span>.
          </p>
          <div class="import-list">
            <label v-for="p in parsed!.hosts" :key="p.entry.name" class="import-row">
              <input v-model="selectedNames" type="checkbox" :value="p.entry.name" />
              <span class="import-name">{{ p.entry.name }}</span>
              <span class="meta">{{ describe(p.entry) }}<template v-if="p.entry.identityFile"> · key {{ p.entry.identityFile }}</template></span>
              <span v-if="isSynced(p.entry.name)" class="tag">already synced</span>
            </label>
          </div>
          <div class="import-foot">
            <button class="primary" :disabled="importing || importSelection.length === 0" @click="doImport">
              {{ importing ? 'Importing…' : `Import ${importSelection.length} ${importSelection.length === 1 ? 'host' : 'hosts'}` }}
            </button>
            <button type="button" @click="cancelImport">Cancel</button>
            <span class="muted">Selection syncs encrypted — the config file stays in this browser.</span>
          </div>
        </div>

        <div v-else>
          <p class="muted import-hint">
            {{ missingCredentials.length }} imported {{ missingCredentials.length === 1 ? 'host has' : 'hosts have' }}
            no key in this browser yet — without one they can't connect from here. Keys are stored encrypted and only
            sent to the bridge when you connect.
          </p>
          <div class="import-list">
            <div v-for="name in missingCredentials" :key="name" class="import-row">
              <span class="import-name">{{ name }}</span>
              <span class="meta">{{ describe(hosts.hosts.find((h) => h.name === name)!) }}</span>
              <button type="button" @click="addKeyForImported(hosts.hosts.find((h) => h.name === name)!)">Add key…</button>
            </div>
          </div>
          <div class="import-foot">
            <button class="primary" type="button" @click="finishImport">Done for now</button>
          </div>
        </div>
        <p v-if="importError" class="error">{{ importError }}</p>
      </details>

      <div v-for="host in hosts.hosts" :key="host.name" class="host-row">
        <div>
          <div class="name">{{ host.name }}</div>
          <div class="meta">
            {{ describe(host) }}<template v-if="host.identityFile"> · key {{ host.identityFile }}</template
            ><template v-if="!hosts.secretHosts.includes(host.name)"> · key needed</template>
          </div>
        </div>
        <div class="actions">
          <button v-if="hosts.secretHosts.includes(host.name)" @click="removeKey(host)">Remove key</button>
          <button @click="editHost(host)">Edit</button>
          <button @click="attachKey(host)">Key…</button>
          <button class="primary" @click="open(host)">Connect</button>
        </div>
      </div>
      <p v-if="hostSaved" class="muted">Saved {{ hostSaved }} to your account — desktops pick it up on their next sync.</p>
      <p v-if="importDone" class="muted">{{ importDone }}</p>
      <p v-if="keySaved" class="muted">Key for {{ keySaved }} stored in this browser.</p>
      <p v-if="keyRemoved" class="muted">Key for {{ keyRemoved }} removed from this browser.</p>

      <details v-if="keyHost" class="keybox" open>
        <summary>Private key for {{ keyHost.name }} (stored encrypted in this browser; sent to the bridge only when you connect)</summary>
        <div class="keyfile-row">
          <input type="file" class="f-keyfile" aria-label="Private key file" @change="onKeyFile" />
          <span v-if="keyFileName" class="muted">loaded {{ keyFileName }}</span>
        </div>
        <textarea v-model="keyDraft" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
        <div class="keypass-row">
          <input
            v-model="keyPassphrase"
            type="password"
            autocomplete="new-password"
            placeholder="Key passphrase (empty if the key isn't encrypted)"
            aria-label="Key passphrase"
          />
        </div>
        <p class="muted keypass-hint">If the key is encrypted, its passphrase is stored encrypted alongside it and used only when you connect.</p>
        <button class="primary" @click="saveKey">Save</button>
        <button @click="keyHost = null">Cancel</button>
      </details>
    </div>
  </main>
</template>
