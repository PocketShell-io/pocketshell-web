<script setup lang="ts">
import { computed, onMounted, ref, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';
import { useWarningsStore } from '../stores/warnings';
import { formatAge, type AplexerWarning } from '../aplexer/warnings';
import { normalizeHostDraft } from '../hostForm';
import { parseSshConfigText } from '../sshConfigImport';
import { claimsOf } from '../auth/google';
import { forgetPassphrase, recallPassphrase, rememberPassphrase } from '../shared/passphraseVault';
import type { HostEntry } from '../shared/types';

const auth = useAuthStore();
const hosts = useHostsStore();
const warnings = useWarningsStore();
const router = useRouter();

const passphrase = ref('');
/** Re-focused when an unlock attempt fails: the error announces, focus returns. */
const passphraseField = ref<HTMLInputElement | null>(null);
const unlocking = ref(false);
/** "Remember on this computer" — stores the passphrase in the passphraseVault
 * (key in IndexedDB, ciphertext in localStorage, this account only). */
const remember = ref(false);
/** True while mount checks for a saved passphrase: the card waits (no
 * password-field flash, no autofocus steal) for a possible auto-unlock. */
const checkingVault = ref(true);
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
/** The validation failure named the port field: #hf-port carries
 * aria-invalid (and the error border) until the form resets or saves. */
const portInvalid = ref(false);
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

/** The quiet confirmation is one notice at rest: a new action's feedback
 * supersedes the previous confirmation instead of stacking with it. */
function setNotice(slot: Ref<string>, message: string) {
  for (const notice of [hostSaved, importDone, keySaved, keyRemoved]) {
    if (notice !== slot) notice.value = '';
  }
  slot.value = message;
}

onMounted(async () => {
  try {
    // Unsigned visitors poking /app get the sign-in screen, not a host error.
    if (!auth.signedIn) {
      router.replace({ name: 'login' });
      return;
    }
    // Already unlocked (in-session navigation back to this view): refresh
    // the aplexer warnings sweep here; the fresh-unlock paths sweep below.
    // The store no-ops concurrent sweeps, so double-firing is safe.
    if (hosts.unlocked) void warnings.sweep().catch(() => {});
    // A saved passphrase for this account unlocks silently. Anything that
    // fails falls through to the card: recall already dropped a stale blob,
    // and a passphrase the server no longer accepts (changed on another
    // device) gets forgotten here explicitly.
    const saved = await recallPassphrase(claimsOf(auth.idToken).sub);
    if (saved !== null && saved !== '') {
      hosts.passphraseRemembered = true;
      try {
        await hosts.unlock(saved);
        void warnings.sweep().catch(() => {});
        return;
      } catch {
        hosts.passphraseRemembered = false;
        void forgetPassphrase(claimsOf(auth.idToken).sub);
        hosts.error = 'The saved passphrase no longer works — it was probably changed on another device.';
      }
    }
  } catch {
    // No readable vault (or no decodable token to namespace it by): the
    // unlock card is the answer, same as it ever was.
  } finally {
    checkingVault.value = false;
  }
});

async function unlock() {
  unlocking.value = true;
  hosts.error = '';
  try {
    await hosts.unlock(passphrase.value);
    // Credentials are in place: check every keyed host for unacknowledged
    // aplexer warnings (issue #1). The catch keeps a freak store error from
    // surfacing — the sweep's own contract is to degrade quietly.
    void warnings.sweep().catch(() => {});
    const sub = claimsOf(auth.idToken).sub;
    if (remember.value) {
      await rememberPassphrase(sub, passphrase.value);
      hosts.passphraseRemembered = true;
    } else if (hosts.passphraseRemembered) {
      // A stale vault (the passphrase just changed somewhere else) must not
      // survive an unticked unlock: what is saved would fail next time.
      await forgetPassphrase(sub);
      hosts.passphraseRemembered = false;
    }
    passphrase.value = '';
  } catch (e) {
    hosts.error = e instanceof Error ? e.message : String(e);
    passphraseField.value?.focus();
  } finally {
    unlocking.value = false;
  }
}

/** The vault's explicit exit, next to where the save is announced. The
 * unlocked session is untouched — only this browser's saved copy goes. */
async function forgetSaved() {
  await forgetPassphrase(claimsOf(auth.idToken).sub);
  hosts.passphraseRemembered = false;
}

function describe(host: HostEntry): string {
  return `${host.user ? `${host.user}@` : ''}${host.hostname}:${host.port}`;
}

// identityFile is the importing machine's path (often a Windows one) — the row
// only means "this key file", so show the bare name.
function keyFile(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// The hosts-list half of issue #1: a host's unacknowledged aplexer warnings
// and whether an ack for it is in flight, both read off the sweep store.
// Helpers (not raw indexing) because absent entries are the normal case.
function hostWarns(name: string): AplexerWarning[] {
  return warnings.byHost[name] ?? [];
}

function hostBusy(name: string): boolean {
  return warnings.busy[name] ?? false;
}

function newHost() {
  draft.value = { name: '', hostname: '', port: '22', user: '' };
  draftIsEdit.value = false;
  formOpen.value = true;
  keyHost.value = null;
  importOpen.value = false;
  formError.value = '';
  portInvalid.value = false;
}

function editHost(host: HostEntry) {
  draft.value = { name: host.name, hostname: host.hostname, port: String(host.port), user: host.user };
  draftIsEdit.value = true;
  formOpen.value = true;
  keyHost.value = null;
  importOpen.value = false;
  formError.value = '';
  portInvalid.value = false;
}

async function saveHost() {
  const base = hosts.hosts.find((host) => host.name === draft.value.name.trim());
  const res = normalizeHostDraft(draft.value, base);
  if (!res.ok) {
    formError.value = res.error;
    portInvalid.value = res.field === 'port';
    return;
  }
  saving.value = true;
  formError.value = '';
  portInvalid.value = false;
  try {
    await hosts.saveHost(res.entry);
    setNotice(hostSaved, res.entry.name);
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
  setNotice(keySaved, keyHost.value.name);
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
  setNotice(keyRemoved, host.name);
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
  setNotice(importDone, `Imported ${importedNames.value.length} ${importedNames.value.length === 1 ? 'host' : 'hosts'} — desktops pick them up on their next sync.`);
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
    <!-- Locked: the passphrase card IS the screen, in the accepted auth-card
         idiom, and its title is the page's only heading. While the saved
         passphrase is being tried, the card waits invisible — no flash. -->
    <section v-if="!hosts.unlocked && !checkingVault" class="unlock-card" aria-labelledby="unlock-title">
      <div class="unlock-mark" aria-hidden="true">&gt;_</div>
      <h1 id="unlock-title">Unlock your hosts</h1>
      <p class="unlock-lede">
        Enter the sync passphrase to decrypt your saved hosts (they never leave this browser unencrypted).
      </p>
      <form class="unlock-form" @submit.prevent="unlock">
        <label class="flabel" for="sync-passphrase">Sync passphrase</label>
        <div class="unlock-row">
          <input
            id="sync-passphrase"
            ref="passphraseField"
            v-model="passphrase"
            type="password"
            autocomplete="current-password"
            autofocus
          />
          <button class="primary" type="submit" :disabled="unlocking || passphrase === ''">
            {{ unlocking ? 'Decrypting…' : 'Unlock' }}
          </button>
        </div>
        <label class="unlock-remember">
          <input v-model="remember" type="checkbox" />
          <span>Remember the passphrase on this computer</span>
        </label>
        <p class="unlock-remember-hint">
          Stored encrypted with a key only this browser holds — the server never sees it.
        </p>
        <p v-if="hosts.error" class="error" role="alert">{{ hosts.error }}</p>
      </form>
    </section>

    <template v-else>
      <h1>Hosts</h1>

      <div :class="{ empty: hosts.hosts.length === 0 && !formOpen && !importOpen }">
        <div class="list-head">
          <span v-if="hosts.hosts.length === 0" class="muted">
            No hosts synced yet — import your SSH config, add one here, or tick hosts in the desktop app and let it push.
          </span>
          <span class="spacer" />
          <div class="head-actions">
            <button @click="startImport">Import config</button>
            <button class="primary" @click="newHost">Add host</button>
          </div>
        </div>

        <!-- One quiet confirmation idiom; spacing, not boxes, separates them. -->
        <p v-if="hostSaved" class="notice" role="status">Saved {{ hostSaved }} to your account — desktops pick it up on their next sync.</p>
        <p v-if="importDone" class="notice" role="status">{{ importDone }}</p>
        <p v-if="keySaved" class="notice" role="status">Key for {{ keySaved }} stored encrypted and synced to your account.</p>
        <p v-if="keyRemoved" class="notice" role="status">Key for {{ keyRemoved }} removed from this browser.</p>

        <!-- The vault's persistent presence: appears the moment a passphrase
             is saved (the tick's feedback) and stays for later sessions, so
             Forget is discoverable whenever the save is in force. -->
        <div v-if="hosts.passphraseRemembered" class="remember-row" role="status">
          <span class="muted">Passphrase saved on this computer — this browser unlocks without it.</span>
          <button type="button" @click="forgetSaved">Forget</button>
        </div>

        <!-- The list, in the landing's own hosts-mock: one bordered card with
             a mono caption bar and hairline-separated mono rows. -->
        <section v-if="hosts.hosts.length > 0" class="hosts-card" aria-label="Synced hosts">
          <div class="hosts-bar">Hosts <span class="pill">synced · encrypted</span></div>
          <div v-for="host in hosts.hosts" :key="host.name" class="host-row">
            <div class="host-text">
              <div class="name">{{ host.name }}</div>
              <div class="meta">
                {{ describe(host) }}<span v-if="host.identityFile" class="key-name"> · key {{ keyFile(host.identityFile) }}</span
                ><template v-if="!hosts.secretHosts.includes(host.name)"> · key needed</template>
              </div>
              <!-- Crash/OOM warnings from the host's aplexer (issue #1): the
                   terminal banner's rows again, surfaced in the list so a
                   crash is visible — and dismissible only on purpose —
                   without opening a session. -->
              <section v-if="hostWarns(host.name).length > 0" class="host-warns" aria-label="Crash warnings on this host">
                <div class="warn-head">
                  <p class="warn-title">
                    {{ hostWarns(host.name).length }} crash warning{{ hostWarns(host.name).length === 1 ? '' : 's' }} on this host
                  </p>
                  <button :disabled="hostBusy(host.name)" @click="warnings.ackAll(host.name)">Clear all</button>
                </div>
                <ul class="warn-list">
                  <li v-for="w in hostWarns(host.name)" :key="w.session" class="warn-row">
                    <span class="warn-kind" :class="w.kind === 'oom' ? 'is-oom' : 'is-crash'">
                      {{ w.kind === 'oom' ? 'OOM' : 'crash' }}
                    </span>
                    <span class="warn-sel">{{ w.workspace }}:{{ w.tag }}</span>
                    <span class="warn-detail">{{ w.detail }}</span>
                    <span class="warn-age">{{ formatAge(Date.now(), w.created_at_ms) }}</span>
                    <button :disabled="hostBusy(host.name)" @click="warnings.ack(host.name, w.session)">Acknowledge</button>
                  </li>
                </ul>
              </section>
            </div>
            <div class="actions">
              <button v-if="hosts.secretHosts.includes(host.name)" @click="removeKey(host)">Remove key</button>
              <button @click="editHost(host)">Edit</button>
              <button @click="attachKey(host)">Key…</button>
              <button class="primary" @click="open(host)">Connect</button>
            </div>
          </div>
        </section>

        <!-- New/edit host: a landing-FAQ card — short title, the storage
             sentence kept as the muted lede, labeled fields. -->
        <details v-if="formOpen" class="keybox" open>
          <summary><span class="sumtitle">{{ draftIsEdit ? `Edit ${draft.name}` : 'New host' }}</span></summary>
          <div class="cardbox-body">
            <p class="card-lede">Stored encrypted in your account; desktops pick it up on their next sync.</p>
            <form class="hostform" @submit.prevent="saveHost">
              <div class="field f-name">
                <label class="flabel" for="hf-name">Name</label>
                <input id="hf-name" v-model="draft.name" placeholder="Name (e.g. prod-box)" :disabled="draftIsEdit" autocomplete="off" autofocus />
              </div>
              <div class="field f-host">
                <label class="flabel" for="hf-host">Hostname</label>
                <input id="hf-host" v-model="draft.hostname" placeholder="Hostname" autocomplete="off" />
              </div>
              <div class="field f-user">
                <label class="flabel" for="hf-user">User</label>
                <input id="hf-user" v-model="draft.user" placeholder="User (optional)" autocomplete="off" />
              </div>
              <div class="field f-port">
                <label class="flabel" for="hf-port">Port</label>
                <input id="hf-port" v-model="draft.port" placeholder="Port" inputmode="numeric" :aria-invalid="portInvalid ? 'true' : undefined" />
              </div>
              <div class="form-actions">
                <button class="primary" type="submit" :disabled="saving || draft.hostname.trim() === ''">
                  {{ saving ? 'Saving…' : 'Save' }}
                </button>
                <button type="button" @click="formOpen = false">Cancel</button>
              </div>
            </form>
            <p v-if="formError" class="error" role="alert">{{ formError }}</p>
          </div>
        </details>

        <!-- Config import: same card, one step visible at a time. -->
        <details v-if="importOpen" class="keybox" open>
          <summary>Import from SSH config</summary>
          <div class="cardbox-body">
            <p class="card-lede">Parsed in this browser; the file itself never leaves it.</p>

            <div v-if="importStep === 'choose'">
              <p class="muted import-hint">
                Load your <code>~/.ssh/config</code> (or paste it), then pick the hosts to sync.
                Ticked hosts join your account encrypted, like the rest of the list.
              </p>
              <div class="import-choose">
                <div class="field f-config">
                  <label class="flabel" for="cfg-file">Config file</label>
                  <label class="filepick" for="cfg-file">
                    <span class="filepick-btn" aria-hidden="true">Choose file</span>
                    <span class="filepick-name" aria-hidden="true">{{ importFileName || 'No file chosen' }}</span>
                    <input id="cfg-file" type="file" aria-label="SSH config file" @change="onConfigFile" />
                  </label>
                </div>
                <button type="button" :disabled="importText.trim() === ''" @click="parseImport">Parse hosts</button>
              </div>
              <div class="field">
                <label class="flabel" for="cfg-text">Or paste the config text</label>
                <textarea id="cfg-text" v-model="importText" placeholder="…or paste the config text here" aria-label="SSH config text"></textarea>
              </div>
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
                  <span class="meta">{{ describe(p.entry) }}<span v-if="p.entry.identityFile" class="key-name"> · key {{ keyFile(p.entry.identityFile) }}</span></span>
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
                no key on this device yet — without one they can't connect from here. Keys are stored encrypted, sync
                with your account, and are only sent to the bridge when you connect.
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
            <p v-if="importError" class="error" role="alert">{{ importError }}</p>
          </div>
        </details>

        <!-- Private key: same card; the empty-save-removes semantics live in
             the store and are unchanged. -->
        <details v-if="keyHost" class="keybox" open>
          <summary><span class="sumtitle">Private key for {{ keyHost.name }}</span></summary>
          <div class="cardbox-body">
            <p class="card-lede">Stored encrypted, synced to your account; sent to the bridge only when you connect.</p>
            <div class="keyfile-row">
              <div class="field">
                <label class="flabel" for="kf-file">Key file</label>
                <label class="filepick" for="kf-file">
                  <span class="filepick-btn" aria-hidden="true">Choose file</span>
                  <span class="filepick-name" aria-hidden="true">{{ keyFileName || 'No file chosen' }}</span>
                  <input id="kf-file" type="file" aria-label="Private key file" @change="onKeyFile" />
                </label>
              </div>
            </div>
            <div class="field">
              <label class="flabel" for="kf-pem">Private key (PEM)</label>
              <textarea id="kf-pem" v-model="keyDraft" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
            </div>
            <div class="keypass-row">
              <div class="field">
                <label class="flabel" for="kf-pass">Key passphrase</label>
                <input
                  id="kf-pass"
                  v-model="keyPassphrase"
                  type="password"
                  autocomplete="new-password"
                  placeholder="Key passphrase"
                  aria-label="Key passphrase"
                />
              </div>
            </div>
            <p class="muted keypass-hint">If the key is encrypted, its passphrase is stored encrypted alongside it and used only when you connect.</p>
            <div class="form-actions">
              <button class="primary" @click="saveKey">Save</button>
              <button @click="keyHost = null">Cancel</button>
            </div>
          </div>
        </details>
      </div>
    </template>
  </main>
</template>
