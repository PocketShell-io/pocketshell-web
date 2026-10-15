<script setup lang="ts">
import { ref } from 'vue';
import { describeWriteFailure, useVaultStore } from '../stores/vault';
import type { VaultAddKeyResult as AddKeyResult, VaultKeyEntry } from '@pocketshell/core';

/**
 * Upload one private key into the vault: a file or pasted text, a name, and
 * — only when the key turns out to be encrypted — that key's own passphrase,
 * asked once. The vault stores the key decrypted, so every other device needs
 * only the vault passphrase. With `rotateFrom` the upload replaces that key
 * on every host bound to it. Parsed in this tab; nothing leaves it unsealed.
 */
const props = defineProps<{ idPrefix: string; rotateFrom?: VaultKeyEntry; submitLabel?: string }>();
const emit = defineEmits<{ added: [entry: VaultKeyEntry, deduplicated: boolean]; cancel: [] }>();

const vault = useVaultStore();
const pem = ref('');
const fileName = ref('');
const name = ref(props.rotateFrom?.name ?? '');
const keyPassphrase = ref('');
const needsPassphrase = ref(false);
const busy = ref(false);
const error = ref('');
const id = (s: string) => `${props.idPrefix}-${s}`;

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  pem.value = await file.text();
  fileName.value = file.name;
  if (name.value === '') name.value = file.name.replace(/\.(pem|key)$/i, '');
  needsPassphrase.value = false;
  keyPassphrase.value = '';
  input.value = '';
}

function explain(r: Exclude<AddKeyResult, { kind: 'ok' }>): string {
  switch (r.kind) {
    case 'needsPassphrase':
      return '';
    case 'wrongPassphrase':
      return "That passphrase doesn't open this key. Check it and try again.";
    case 'invalid':
    case 'unsupported':
      return r.message;
    default:
      return describeWriteFailure(r);
  }
}

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const label = name.value.trim() || 'SSH key';
    const pass = needsPassphrase.value && keyPassphrase.value !== '' ? keyPassphrase.value : undefined;
    const r = props.rotateFrom
      ? await vault.rotateKey(props.rotateFrom.keyId, pem.value, label, pass)
      : await vault.addKey(pem.value, label, pass);
    if (r.kind === 'ok') {
      pem.value = '';
      keyPassphrase.value = '';
      needsPassphrase.value = false;
      emit('added', r.entry, r.deduplicated);
      return;
    }
    if (r.kind === 'needsPassphrase') {
      needsPassphrase.value = true;
      error.value = 'This key is encrypted. Enter its passphrase once; the vault keeps the key decrypted, sealed under your vault passphrase.';
      return;
    }
    error.value = explain(r);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="keyupload" @submit.prevent="submit">
    <div class="keyfile-row">
      <div class="field">
        <label class="flabel" :for="id('file')">Key file</label>
        <label class="filepick" :for="id('file')">
          <span class="filepick-btn" aria-hidden="true">Choose file</span>
          <span class="filepick-name" aria-hidden="true">{{ fileName || 'No file chosen' }}</span>
          <input :id="id('file')" type="file" aria-label="Private key file" @change="onFile" />
        </label>
      </div>
    </div>
    <div class="field">
      <label class="flabel" :for="id('pem')">Or paste the private key</label>
      <textarea
        :id="id('pem')"
        v-model="pem"
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        spellcheck="false"
        autocomplete="off"
        @input="needsPassphrase = false"
      ></textarea>
    </div>
    <div class="field">
      <label class="flabel" :for="id('name')">Name</label>
      <input :id="id('name')" v-model="name" placeholder="e.g. laptop ed25519" autocomplete="off" />
    </div>
    <div v-if="needsPassphrase" class="field">
      <label class="flabel" :for="id('kpass')">This key's passphrase</label>
      <input :id="id('kpass')" v-model="keyPassphrase" type="password" autocomplete="off" autofocus />
    </div>
    <p v-if="error" :class="needsPassphrase && !error.startsWith('That') ? 'muted hint' : 'error'" role="alert">{{ error }}</p>
    <div class="form-actions">
      <button class="primary" type="submit" :disabled="busy || pem.trim() === '' || (needsPassphrase && keyPassphrase === '')">
        {{ busy ? 'Encrypting…' : (props.submitLabel ?? (props.rotateFrom ? 'Rotate key' : 'Add to vault')) }}
      </button>
      <button type="button" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>

<style scoped>
.keyupload .field {
  margin-top: 8px;
}

.keyupload textarea {
  width: 100%;
  min-height: 90px;
  font-family: var(--font-mono);
  font-size: var(--text-fine);
}

.keyupload input:not([type='file']) {
  width: 100%;
  min-width: 0;
}

.hint {
  margin: 8px 0 0;
  font-size: var(--text-small);
}

.form-actions {
  margin-top: 12px;
}
</style>
