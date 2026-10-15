<script setup lang="ts">
import { computed, onMounted, ref, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useConnectionStore } from '@ui/app/stores/connection';
import { useHostsStore } from '../stores/hosts';
import { useWarningsStore } from '../stores/warnings';
import { formatAge, type AplexerWarning } from '../aplexer/warnings';
import { normalizeHostDraft } from '../hostForm';
import { parseSshConfigText } from '../sshConfigImport';
import { useVaultStore } from '../stores/vault';
import { useVaultGateStore } from '../stores/vaultGate';
import type { GatewayAuthPolicy as GatewayAuth, VaultKeyEntry } from '@pocketshell/core';
import VaultUnlockForm from '../components/VaultUnlockForm.vue';
import VaultSetupCard from '../components/VaultSetupCard.vue';
import MigrationCard from '../components/MigrationCard.vue';
import KeyUploadForm from '../components/KeyUploadForm.vue';
import type { HostEntry } from '@pocketshell/core';

const auth = useAuthStore();
const connection = useConnectionStore();
const hosts = useHostsStore();
const warnings = useWarningsStore();
const router = useRouter();
const vault = useVaultStore();
const gate = useVaultGateStore();

const passphrase = ref('');
/** Re-focused when an unlock attempt fails: the error announces, focus returns. */
const passphraseField = ref<HTMLInputElement | null>(null);
const unlocking = ref(false);
const keyHost = ref<HostEntry | null>(null);
const keySaved = ref('');
const keyRemoved = ref('');
/** The key dialog's choice: a vault entry id, or '' for none. */
const keyChoice = ref('');
const keyPolicy = ref<GatewayAuth>('both');
const keyMode = ref<'pick' | 'upload' | 'password'>('pick');
const passwordDraft = ref('');
const passwordName = ref('');
const keyError = ref('');
const keyBusy = ref(false);

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
  for (const notice of [hostSaved, importDone, keySaved, keyRemoved, applied]) {
    if (notice !== slot) notice.value = '';
  }
  slot.value = message;
}

onMounted(async () => {
  // Unsigned visitors poking /app get the sign-in screen, not a host error.
  if (!auth.signedIn) {
    router.replace({ name: 'login' });
    return;
  }
  // Already open (in-session navigation back to this view): refresh the
  // aplexer warnings sweep. Otherwise the silent open (remembered vault key
  // -> sync passphrase from the index -> host list) runs first, and the
  // gate's step decides the card.
  if (gate.step !== 'ready') await gate.open();
  if (gate.step === 'ready') void warnings.sweep().catch(() => {});
});

/** The sync-passphrase step: a pre-vault account opens its host list once,
 * then creates the vault (or a vault whose recorded sync passphrase went
 * stale is brought up to date). */
async function unlock() {
  unlocking.value = true;
  hosts.error = '';
  try {
    await gate.submitSyncPassphrase(passphrase.value);
    passphrase.value = '';
    if (gate.step === 'ready') void warnings.sweep().catch(() => {});
  } catch (e) {
    hosts.error = e instanceof Error ? e.message : String(e);
    passphraseField.value?.focus();
  } finally {
    unlocking.value = false;
  }
}

function onVaultUnlocked() {
  if (gate.step === 'ready') void warnings.sweep().catch(() => {});
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

/* --- Vault key per host -------------------------------------------------- */

function attachKey(host: HostEntry) {
  keyHost.value = host;
  const bound = vault.bindings[host.name];
  keyChoice.value = bound?.keyId ?? '';
  keyPolicy.value = bound?.gatewayAuth ?? 'both';
  keyMode.value = vault.entries.length === 0 ? 'upload' : 'pick';
  passwordDraft.value = '';
  passwordName.value = '';
  keyError.value = '';
  keySaved.value = '';
  formOpen.value = false;
  importOpen.value = false;
}

function entryLabel(e: VaultKeyEntry): string {
  return e.type === 'password' ? `${e.name} (password)` : `${e.name} · ${e.fingerprint ?? e.type}`;
}

/** A key just uploaded from the dialog is the host's choice. */
function onKeyUploaded(entry: VaultKeyEntry) {
  keyChoice.value = entry.keyId;
  keyMode.value = 'pick';
}

async function addPasswordEntry() {
  if (keyHost.value === null || passwordDraft.value === '') return;
  keyBusy.value = true;
  keyError.value = '';
  try {
    const entry = await vault.addPassword(
      passwordDraft.value,
      passwordName.value.trim() || `${keyHost.value.name} ${keyHost.value.link ? 'relay token' : 'password'}`,
    );
    passwordDraft.value = '';
    onKeyUploaded(entry);
  } catch (e) {
    keyError.value = e instanceof Error ? e.message : String(e);
  } finally {
    keyBusy.value = false;
  }
}

async function saveKey() {
  if (keyHost.value === null) return;
  keyBusy.value = true;
  keyError.value = '';
  try {
    await vault.bindHost(keyHost.value.name, keyChoice.value === '' ? null : keyChoice.value, keyPolicy.value);
    setNotice(keySaved, keyHost.value.name);
    keyHost.value = null;
  } catch (e) {
    keyError.value = e instanceof Error ? e.message : String(e);
    return;
  } finally {
    keyBusy.value = false;
  }
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
  await vault.bindHost(host.name, null);
  setNotice(keyRemoved, host.name);
}

const applying = ref('');
const applied = ref('');
const applyError = ref<{ host: string; message: string } | null>(null);

/** Push the host's gateway policy + vault public key to its host agent. */
async function applyToHost(host: HostEntry) {
  applying.value = host.name;
  applyError.value = null;
  try {
    const report = await vault.applyGatewayPolicy(host);
    const n = report.managedKeys.length;
    setNotice(applied, `${host.name} now accepts ${report.policy === 'host' ? "only its own keys" : report.policy === 'managed' ? 'only your vault key' : 'your vault key and its own keys'} through the gateway (${n} vault ${n === 1 ? 'key' : 'keys'} trusted).`);
  } catch (e) {
    applyError.value = { host: host.name, message: e instanceof Error ? e.message : String(e) };
  } finally {
    applying.value = '';
  }
}

function keyNameFor(host: HostEntry): string {
  const b = vault.bindings[host.name];
  return b ? (vault.entries.find((e) => e.keyId === b.keyId)?.name ?? '') : '';
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

async function open(host: HostEntry) {
  // The shared connection store owns dialling now: it resolves the secret,
  // runs the TOFU pin, fires bootstrap, and lands the workspace on the
  // desktop's routes. A second click on a connected host re-enters.
  if (
    connection.state === 'connected' &&
    connection.activeHost?.name === host.name &&
    connection.connectionId
  ) {
    void router.push({ name: 'host-sessions', params: { name: host.name } });
    return;
  }
  const ok = await connection.connect(host);
  if (ok) void router.push({ name: 'host-sessions', params: { name: host.name } });
}
</script>

<template>
  <main class="page">
    <!-- Not open yet: the gate's card IS the screen, in the accepted
         auth-card idiom, and its title is the page's only heading. While the
         silent open runs (remembered vault key), nothing flashes. -->
    <section v-if="gate.step === 'vault-locked'" class="unlock-card" aria-labelledby="unlock-title">
      <div class="unlock-mark" aria-hidden="true">&gt;_</div>
      <h1 id="unlock-title">Unlock your vault</h1>
      <p class="unlock-lede">
        Your vault passphrase opens your SSH keys and your host list. It never leaves this browser.
      </p>
      <VaultUnlockForm id-prefix="hv" @unlocked="onVaultUnlocked" @forgot="router.push({ name: 'keys', query: { reset: '1' } })" />
    </section>

    <section v-else-if="gate.step === 'sync-passphrase'" class="unlock-card" aria-labelledby="unlock-title">
      <div class="unlock-mark" aria-hidden="true">&gt;_</div>
      <h1 id="unlock-title">Unlock your hosts</h1>
      <p class="unlock-lede">
        <template v-if="vault.unlocked">{{ gate.error || 'Enter the sync passphrase your host list is encrypted with.' }}</template>
        <template v-else>
          Enter your sync passphrase to decrypt your saved hosts. Next you'll set up the key vault that keeps your SSH
          keys.
        </template>
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
        <p v-if="hosts.error" class="error" role="alert">{{ hosts.error }}</p>
      </form>
    </section>

    <VaultSetupCard v-else-if="gate.step === 'create-vault'" />

    <MigrationCard v-else-if="gate.step === 'migrate'" />

    <template v-else-if="gate.step === 'ready'">
      <h1>Hosts</h1>

      <div :class="{ empty: hosts.hosts.length === 0 && !formOpen && !importOpen }">
        <div class="list-head">
          <span v-if="hosts.hosts.length === 0" class="muted">
            No hosts synced yet — import your SSH config, add one here, or tick hosts in the desktop app and let it push.
          </span>
          <span class="spacer" />
          <div class="head-actions">
            <RouterLink class="button" :to="{ name: 'keys' }">Keys</RouterLink>
            <RouterLink class="button" :to="{ name: 'device-sessions' }">CLI sessions</RouterLink>
            <button @click="startImport">Import config</button>
            <button class="primary" @click="newHost">Add host</button>
          </div>
        </div>

        <!-- One quiet confirmation idiom; spacing, not boxes, separates them. -->
        <p v-if="hostSaved" class="notice" role="status">Saved {{ hostSaved }} to your account — desktops pick it up on their next sync.</p>
        <p v-if="importDone" class="notice" role="status">{{ importDone }}</p>
        <p v-if="keySaved" class="notice" role="status">Saved the vault key choice for {{ keySaved }}. Every device uses it after its next unlock.</p>
        <p v-if="applied" class="notice" role="status">{{ applied }}</p>
        <p v-if="applyError" class="error" role="alert">{{ applyError.host }}: {{ applyError.message }}</p>
        <p v-if="vault.pendingApply.length > 0" class="notice" role="status">
          Key changes for {{ vault.pendingApply.join(', ') }} reach the gateway once applied: use Apply to host on
          {{ vault.pendingApply.length === 1 ? 'that row' : 'those rows' }}. Until then the host agent keeps trusting
          the previous keys.
        </p>
        <p v-if="keyRemoved" class="notice" role="status">{{ keyRemoved }} no longer uses a vault key. The key itself stays in your vault.</p>

        <!-- The list, in the landing's own hosts-mock: one bordered card with
             a mono caption bar and hairline-separated mono rows. -->
        <section v-if="hosts.hosts.length > 0" class="hosts-card" aria-label="Synced hosts">
          <div class="hosts-bar">Hosts <span class="pill">synced · encrypted</span></div>
          <div v-for="host in hosts.hosts" :key="host.name" class="host-row">
            <div class="host-text">
              <div class="name">{{ host.name }}</div>
              <div class="meta">
                {{ describe(host) }}<span v-if="keyNameFor(host)" class="key-name"> · {{ keyNameFor(host) }}</span
                ><span v-else-if="host.identityFile" class="key-name"> · key {{ keyFile(host.identityFile) }}</span
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
              <button v-if="hosts.secretHosts.includes(host.name)" @click="removeKey(host)">Unassign key</button>
              <button
                v-if="vault.bindings[host.name] !== undefined"
                :class="{ primary: vault.pendingApply.includes(host.name) }"
                :disabled="applying === host.name"
                title="Push this host's gateway policy and vault public key to its host agent"
                @click="applyToHost(host)"
              >
                {{ applying === host.name ? 'Applying…' : 'Apply to host' }}
              </button>
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

        <!-- Vault key for a host: pick an entry (or add one right here), and
             the gateway policy. Keys live in the vault; a host only names one. -->
        <details v-if="keyHost" class="keybox" open>
          <summary><span class="sumtitle">Key for {{ keyHost.name }}</span></summary>
          <div class="cardbox-body">
            <p class="card-lede">
              Keys are stored in your vault, encrypted with your vault passphrase, decrypted in memory and sent to the
              bridge only when you connect.
            </p>
            <div class="mode-tabs" role="tablist" aria-label="Key source">
              <button type="button" role="tab" :aria-selected="keyMode === 'pick'" :disabled="vault.entries.length === 0" @click="keyMode = 'pick'">From vault</button>
              <button type="button" role="tab" :aria-selected="keyMode === 'upload'" @click="keyMode = 'upload'">Upload a key</button>
              <button type="button" role="tab" :aria-selected="keyMode === 'password'" @click="keyMode = 'password'">
                {{ keyHost.link ? 'Relay token' : 'Password' }}
              </button>
            </div>

            <div v-if="keyMode === 'upload'">
              <KeyUploadForm id-prefix="kf" submit-label="Add to vault" @added="onKeyUploaded" @cancel="keyMode = 'pick'" />
            </div>

            <form v-else-if="keyMode === 'password'" class="pw-form" @submit.prevent="addPasswordEntry">
              <div class="field">
                <label class="flabel" for="kf-pw">{{ keyHost.link ? 'Relay token' : 'Password' }}</label>
                <input id="kf-pw" v-model="passwordDraft" type="password" autocomplete="new-password" />
              </div>
              <div class="field">
                <label class="flabel" for="kf-pwname">Name</label>
                <input id="kf-pwname" v-model="passwordName" :placeholder="`${keyHost.name} ${keyHost.link ? 'relay token' : 'password'}`" autocomplete="off" />
              </div>
              <div class="form-actions">
                <button class="primary" type="submit" :disabled="keyBusy || passwordDraft === ''">Add to vault</button>
                <button type="button" @click="keyMode = 'pick'">Cancel</button>
              </div>
            </form>

            <form v-else class="pick-form" @submit.prevent="saveKey">
              <div class="field">
                <label class="flabel" for="kf-entry">Vault key</label>
                <select id="kf-entry" v-model="keyChoice">
                  <option value="">None</option>
                  <option v-for="e in vault.entries" :key="e.keyId" :value="e.keyId">{{ entryLabel(e) }}</option>
                </select>
              </div>
              <fieldset class="policy">
                <legend class="flabel">Through the PocketShell gateway, sign in with</legend>
                <label class="unlock-remember">
                  <input v-model="keyPolicy" type="radio" value="both" name="kf-policy" />
                  <span>This vault key, then the host's own keys</span>
                </label>
                <label class="unlock-remember">
                  <input v-model="keyPolicy" type="radio" value="managed" name="kf-policy" />
                  <span>Only this vault key</span>
                </label>
                <label class="unlock-remember">
                  <input v-model="keyPolicy" type="radio" value="host" name="kf-policy" />
                  <span>Only the host's own keys (no vault needed)</span>
                </label>
              </fieldset>
              <div class="form-actions">
                <button class="primary" type="submit" :disabled="keyBusy">{{ keyBusy ? 'Saving…' : 'Save' }}</button>
                <button type="button" @click="keyHost = null">Cancel</button>
              </div>
            </form>
            <p v-if="keyError" class="error" role="alert">{{ keyError }}</p>
          </div>
        </details>
      </div>
    </template>
  </main>
</template>
