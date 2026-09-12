<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';
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

async function attachKey(host: HostEntry) {
  keyHost.value = host;
  keyDraft.value = '';
  keySaved.value = '';
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
      <p v-if="hosts.hosts.length === 0" class="muted">
        No hosts synced yet — tick hosts in the desktop app and let it push, then reload here.
      </p>
      <div v-for="host in hosts.hosts" :key="host.name" class="host-row">
        <div>
          <div class="name">{{ host.name }}</div>
          <div class="meta">{{ describe(host) }}<span v-if="host.identityFile" class="muted"> · key {{ host.identityFile }}</span></div>
        </div>
        <span class="spacer" />
        <button v-if="hosts.secretHosts.includes(host.name)" @click="removeKey(host)">Remove key</button>
        <button @click="attachKey(host)">Key…</button>
        <button class="primary" @click="open(host)">Connect</button>
      </div>
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
