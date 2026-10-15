<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useVaultStore, WrongPassphraseError } from '../stores/vault';
import { useVaultGateStore } from '../stores/vaultGate';
import type { VaultKeyEntry } from '@pocketshell/core';
import KeyUploadForm from '../components/KeyUploadForm.vue';
import NewPassphraseFields from '../components/NewPassphraseFields.vue';
import VaultResetFlow from '../components/VaultResetFlow.vue';
import VaultUnlockForm from '../components/VaultUnlockForm.vue';

/**
 * /keys — the account key vault: the keys and passwords in it, where each is
 * used, and the vault's own settings (this device, passphrase, reset).
 * `?reset=1` opens straight into Forgot / reset — the link Android's and
 * psc's "Forgot it?" point at.
 */
const auth = useAuthStore();
const vault = useVaultStore();
const gate = useVaultGateStore();
const route = useRoute();
const router = useRouter();

const resetOpen = ref(route.query.reset === '1');
watch(
  () => route.query.reset,
  (v) => (resetOpen.value = v === '1'),
);

const adding = ref<'none' | 'key' | 'password'>('none');
const rotating = ref<VaultKeyEntry | null>(null);
const renaming = ref<string | null>(null);
const renameDraft = ref('');
const deleting = ref<VaultKeyEntry | null>(null);
const notice = ref('');
const error = ref('');
const passwordDraft = ref('');
const passwordName = ref('');
const copied = ref('');

const changeOpen = ref(false);
const currentPass = ref('');
const nextPass = ref('');
const changeBusy = ref(false);
const changeError = ref('');
const newFields = ref<InstanceType<typeof NewPassphraseFields> | null>(null);

onMounted(async () => {
  if (!auth.signedIn) {
    void router.replace({ name: 'login', query: { next: route.fullPath } });
    return;
  }
  if (gate.step !== 'ready') await gate.open();
});

/** Hosts using an entry, by name. */
const usedBy = computed(() => {
  const out: Record<string, string[]> = {};
  for (const [host, b] of Object.entries(vault.bindings)) (out[b.keyId] ??= []).push(host);
  return out;
});

function closeReset() {
  resetOpen.value = false;
  if (route.query.reset !== undefined) void router.replace({ name: 'keys' });
}

function onResetDone() {
  closeReset();
  adding.value = 'key';
}

function say(message: string) {
  notice.value = message;
  error.value = '';
}

async function guard(fn: () => Promise<void>) {
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function onAdded(entry: VaultKeyEntry, deduplicated: boolean) {
  adding.value = 'none';
  say(deduplicated ? `${entry.name} was already in your vault; renamed.` : `${entry.name} added to your vault.`);
}

function onRotated(entry: VaultKeyEntry) {
  const old = rotating.value;
  rotating.value = null;
  say(`Rotated ${old?.name ?? 'the key'} to ${entry.name}. Every host that used it now uses the new key; use Apply to host on the Hosts page so their host agents stop trusting the old one.`);
}

async function addPassword() {
  await guard(async () => {
    const entry = await vault.addPassword(passwordDraft.value, passwordName.value.trim() || 'Password');
    passwordDraft.value = '';
    passwordName.value = '';
    adding.value = 'none';
    say(`${entry.name} added to your vault.`);
  });
}

function startRename(e: VaultKeyEntry) {
  renaming.value = e.keyId;
  renameDraft.value = e.name;
}

async function saveRename(e: VaultKeyEntry) {
  await guard(async () => {
    await vault.renameKey(e.keyId, renameDraft.value.trim() || e.name);
    renaming.value = null;
  });
}

async function confirmDelete() {
  const e = deleting.value;
  if (e === null) return;
  await guard(async () => {
    const hosts = usedBy.value[e.keyId] ?? [];
    await vault.removeKey(e.keyId);
    deleting.value = null;
    say(
      hosts.length > 0
        ? `${e.name} deleted from your vault. ${hosts.join(', ')} still accept it until you use Apply to host on the Hosts page.`
        : `${e.name} deleted from your vault.`,
    );
  });
}

async function copyPublic(e: VaultKeyEntry) {
  await guard(async () => {
    const line = await vault.publicKeyOf(e.keyId);
    if (line === null) throw new Error('The public key is not available for this entry.');
    await navigator.clipboard.writeText(line);
    copied.value = e.keyId;
    setTimeout(() => (copied.value = ''), 2000);
  });
}

async function setRemember(on: boolean) {
  await guard(async () => {
    if (on) {
      await vault.applyRemember(true);
      say('This device now remembers your vault. Forget it here, or by signing out.');
    } else {
      await vault.forgetDevice();
      say('This device no longer remembers your vault; you will type the passphrase next time.');
    }
  });
}

function lockNow() {
  vault.lock();
  say('Vault locked. Your keys are no longer in memory in this tab.');
}

async function changePassphrase() {
  changeBusy.value = true;
  changeError.value = '';
  try {
    await gate.changePassphrase(currentPass.value, nextPass.value);
    currentPass.value = '';
    newFields.value?.clear();
    changeOpen.value = false;
    say('Vault passphrase changed. Devices that remember the vault keep working; elsewhere, type the new one.');
  } catch (e) {
    changeError.value =
      e instanceof WrongPassphraseError ? "That isn't your current vault passphrase." : e instanceof Error ? e.message : String(e);
  } finally {
    changeBusy.value = false;
  }
}

function created(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}
</script>

<template>
  <main class="page keys-page">
    <h1>Keys</h1>

    <!-- Reset only once the vault was probed: an unreadable (newer-format)
         vault must be updated for, never wiped. -->
    <template v-if="gate.step === 'checking'">
      <p class="muted" role="status">Opening your vault…</p>
    </template>

    <section v-else-if="gate.step === 'error'" class="muted-card" role="alert">
      <p class="error">{{ gate.error }}</p>
      <button type="button" @click="gate.open()">Try again</button>
    </section>

    <VaultResetFlow v-else-if="resetOpen && gate.resetAllowed" @done="onResetDone" @cancel="closeReset" />

    <section v-else-if="gate.step === 'corrupt'" class="muted-card" role="alert">
      <p class="error">
        Your vault can't be read: its header is damaged. Nothing can open it any more; reset it to start a new vault and
        upload your keys again.
      </p>
      <button type="button" class="primary" @click="resetOpen = true">Reset vault…</button>
    </section>

    <section v-else-if="gate.step === 'vault-locked'" class="unlock-card" aria-labelledby="keys-unlock">
      <h2 id="keys-unlock">Unlock your vault</h2>
      <VaultUnlockForm id-prefix="kv" @forgot="resetOpen = true" />
    </section>

    <section v-else-if="!vault.unlocked" class="muted-card">
      <p>Your account doesn't have a key vault yet, or your host list needs its passphrase first.</p>
      <RouterLink class="button primary" :to="{ name: 'app-hosts' }">Set up on the Hosts page</RouterLink>
    </section>

    <template v-else>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div class="list-head">
        <span class="muted">
          {{ vault.entries.length === 0 ? 'Your vault is empty.' : `${vault.entries.length} in your vault` }}
        </span>
        <span class="spacer" />
        <div class="head-actions">
          <RouterLink class="button" :to="{ name: 'app-hosts' }">Hosts</RouterLink>
          <button @click="adding = 'password'">Add password</button>
          <button class="primary" @click="adding = 'key'">Add key</button>
        </div>
      </div>

      <details v-if="adding === 'key'" class="keybox" open>
        <summary><span class="sumtitle">Add a private key</span></summary>
        <div class="cardbox-body">
          <p class="card-lede">
            Read in this browser and sealed with your vault passphrase before it is uploaded. If the key has its own
            passphrase you'll be asked for it once; the vault keeps the key decrypted, so other devices only need your
            vault passphrase.
          </p>
          <KeyUploadForm id-prefix="add" @added="onAdded" @cancel="adding = 'none'" />
        </div>
      </details>

      <details v-if="adding === 'password'" class="keybox" open>
        <summary><span class="sumtitle">Add a password or relay token</span></summary>
        <div class="cardbox-body">
          <form @submit.prevent="addPassword">
            <div class="field">
              <label class="flabel" for="pw-value">Password</label>
              <input id="pw-value" v-model="passwordDraft" type="password" autocomplete="new-password" />
            </div>
            <div class="field">
              <label class="flabel" for="pw-name">Name</label>
              <input id="pw-name" v-model="passwordName" placeholder="e.g. prod-box password" autocomplete="off" />
            </div>
            <div class="form-actions">
              <button class="primary" type="submit" :disabled="passwordDraft === ''">Add to vault</button>
              <button type="button" @click="adding = 'none'">Cancel</button>
            </div>
          </form>
        </div>
      </details>

      <section v-if="vault.entries.length > 0" class="hosts-card" aria-label="Keys in your vault">
        <div class="hosts-bar">Vault <span class="pill">end-to-end encrypted</span></div>
        <div v-for="e in vault.entries" :key="e.keyId" class="host-row">
          <div class="host-text">
            <div v-if="renaming !== e.keyId" class="name">{{ e.name }}</div>
            <form v-else class="rename" @submit.prevent="saveRename(e)">
              <label class="sr-only" :for="`rn-${e.keyId}`">Name</label>
              <input :id="`rn-${e.keyId}`" v-model="renameDraft" autocomplete="off" autofocus />
              <button class="primary" type="submit">Save</button>
              <button type="button" @click="renaming = null">Cancel</button>
            </form>
            <div class="meta">
              {{ e.type === 'password' ? 'password' : e.type }}
              <template v-if="e.fingerprint"> · {{ e.fingerprint }}</template>
              <template v-if="created(e.createdAt)"> · added {{ created(e.createdAt) }}</template>
            </div>
            <div class="meta">
              {{ usedBy[e.keyId]?.length ? `Used by ${usedBy[e.keyId].join(', ')}` : 'Not used by any host' }}
            </div>
            <div v-if="deleting?.keyId === e.keyId" class="confirm" role="alertdialog" :aria-labelledby="`del-${e.keyId}`">
              <p :id="`del-${e.keyId}`">
                Delete {{ e.name }} from your vault on every device?
                <template v-if="usedBy[e.keyId]?.length">
                  {{ usedBy[e.keyId].join(', ') }} will need another key. Deleting does not revoke it on those hosts:
                  they keep accepting this key until you use Apply to host on the Hosts page.
                </template>
              </p>
              <button class="primary" type="button" @click="confirmDelete">Delete</button>
              <button type="button" @click="deleting = null">Keep it</button>
            </div>
            <div v-if="rotating?.keyId === e.keyId" class="rotate">
              <p class="muted">
                Upload the replacement key. Every host using {{ e.name }} switches to it, and {{ e.name }} is deleted.
                Add the new public key to those servers first.
              </p>
              <KeyUploadForm :id-prefix="`rot-${e.keyId}`" :rotate-from="e" @added="onRotated" @cancel="rotating = null" />
            </div>
          </div>
          <div class="actions">
            <button v-if="e.type !== 'password'" @click="copyPublic(e)">
              {{ copied === e.keyId ? 'Copied' : 'Copy public key' }}
            </button>
            <button @click="startRename(e)">Rename</button>
            <button v-if="e.type !== 'password'" @click="rotating = e">Rotate</button>
            <button @click="deleting = e">Delete</button>
          </div>
        </div>
      </section>

      <section class="settings" aria-labelledby="vault-settings">
        <h2 id="vault-settings">Vault</h2>
        <div class="setting-row">
          <div>
            <div class="name">This device</div>
            <div class="meta">
              {{ vault.remembered ? 'Remembers your vault: unlocks without the passphrase.' : 'Asks for the passphrase every time.' }}
            </div>
          </div>
          <button v-if="vault.remembered" @click="setRemember(false)">Forget on this device</button>
          <button v-else @click="setRemember(true)">Remember on this device</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="name">Lock</div>
            <div class="meta">Drop the decrypted vault from this tab now.</div>
          </div>
          <button @click="lockNow">Lock vault</button>
        </div>
        <div class="setting-row">
          <div>
            <div class="name">Passphrase</div>
            <div class="meta">Changing it keeps your keys; other devices need the new one next time they ask.</div>
          </div>
          <button @click="changeOpen = !changeOpen">Change passphrase</button>
        </div>
        <form v-if="changeOpen" class="change" @submit.prevent="changePassphrase">
          <div class="field">
            <label class="flabel" for="cp-current">Current vault passphrase</label>
            <input id="cp-current" v-model="currentPass" type="password" autocomplete="current-password" />
          </div>
          <NewPassphraseFields ref="newFields" id-prefix="cp" @update:valid="nextPass = $event" />
          <p class="muted fine">If you forget the new one, your keys cannot be recovered.</p>
          <div class="form-actions">
            <button class="primary" type="submit" :disabled="changeBusy || currentPass === '' || nextPass === ''">
              {{ changeBusy ? 'Changing…' : 'Change passphrase' }}
            </button>
            <button type="button" @click="changeOpen = false">Cancel</button>
          </div>
          <p v-if="changeError" class="error" role="alert">{{ changeError }}</p>
        </form>
        <div class="setting-row">
          <div>
            <div class="name">Forgot your passphrase?</div>
            <div class="meta">Reset deletes the vault's keys after you sign in with Google again.</div>
          </div>
          <button @click="resetOpen = true">Reset vault…</button>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.keys-page .field {
  margin-top: 8px;
}

.keys-page .field input {
  width: 100%;
}

.muted-card {
  margin-top: 16px;
}

.rename {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.rename input {
  flex: 1 1 160px;
  min-width: 0;
}

.confirm,
.rotate {
  margin-top: 8px;
  padding: 10px 12px;
  background: var(--surface-2);
  border-radius: 6px;
  font-family: var(--font-ui);
  font-size: var(--text-small);
}

.confirm p {
  margin: 0 0 8px;
}

.confirm button {
  margin-right: 8px;
}

.settings {
  margin-top: 28px;
}

.settings h2 {
  margin: 0 0 8px;
  font-size: var(--text-lede);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-soft);
}

.setting-row .meta {
  font-size: var(--text-small);
  color: var(--fg-secondary);
}

.change {
  padding: 12px 0;
}

.fine {
  font-size: var(--text-fine);
}

.form-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
