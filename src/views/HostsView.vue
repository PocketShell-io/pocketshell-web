<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';
import { normalizeHostDraft } from '../hostForm';
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

const formOpen = ref(false);
const draft = ref({ name: '', hostname: '', port: '22', user: '' });
const draftIsEdit = ref(false);
const saving = ref(false);
const formError = ref('');
const hostSaved = ref('');

onMounted(() => {
  // Unsigned visitors poking /app get the landing page, not a sign-in error.
  if (!auth.signedIn) router.replace({ name: 'landing' });
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
  formError.value = '';
}

function editHost(host: HostEntry) {
  draft.value = { name: host.name, hostname: host.hostname, port: String(host.port), user: host.user };
  draftIsEdit.value = true;
  formOpen.value = true;
  keyHost.value = null;
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

async function attachKey(host: HostEntry) {
  keyHost.value = host;
  keyDraft.value = '';
  keySaved.value = '';
  formOpen.value = false;
}

async function saveKey() {
  if (keyHost.value === null) return;
  const pem = keyDraft.value.trim();
  await hosts.setHostSecret(keyHost.value.name, pem === '' ? {} : { privateKeyPem: pem });
  keySaved.value = keyHost.value.name;
  keyHost.value = null;
}

async function removeKey(host: HostEntry) {
  await hosts.removeHostSecret(host.name);
  keySaved.value = '';
  keyRemoved.value = host.name;
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

    <div v-else>
      <div class="list-head">
        <span v-if="hosts.hosts.length === 0" class="muted">
          No hosts synced yet — add one here, or tick hosts in the desktop app and let it push.
        </span>
        <span class="spacer" />
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

      <div v-for="host in hosts.hosts" :key="host.name" class="host-row">
        <div>
          <div class="name">{{ host.name }}</div>
          <div class="meta">{{ describe(host) }}<span v-if="host.identityFile" class="muted"> · key {{ host.identityFile }}</span></div>
        </div>
        <span class="spacer" />
        <button v-if="hosts.secretHosts.includes(host.name)" @click="removeKey(host)">Remove key</button>
        <button @click="editHost(host)">Edit</button>
        <button @click="attachKey(host)">Key…</button>
        <button class="primary" @click="open(host)">Connect</button>
      </div>
      <p v-if="hostSaved" class="muted">Saved {{ hostSaved }} to your account — desktops pick it up on their next sync.</p>
      <p v-if="keySaved" class="muted">Key for {{ keySaved }} stored in this browser.</p>
      <p v-if="keyRemoved" class="muted">Key for {{ keyRemoved }} removed from this browser.</p>

      <details v-if="keyHost" class="keybox" open>
        <summary>Private key for {{ keyHost.name }} (stored encrypted in this browser; sent to the bridge only when you connect)</summary>
        <textarea v-model="keyDraft" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
        <button class="primary" @click="saveKey">Save</button>
        <button @click="keyHost = null">Cancel</button>
      </details>
    </div>
  </main>
</template>
