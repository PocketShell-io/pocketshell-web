<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { describeWriteFailure, useVaultStore } from '../stores/vault';
import type { GatewayAuthPolicy, VaultAddKeyResult as AddKeyResult, VaultKeyEntry } from '@pocketshell/core';
import {prepareSshPrivateKey} from '@pocketshell/core';

/**
 * Upload one private key into the vault: a file or pasted text, a name, and
 * — only when the key turns out to be encrypted — that key's own passphrase,
 * asked once. The vault stores the key decrypted, so every other device needs
 * only the vault passphrase. With `rotateFrom` the upload replaces that key
 * on every host bound to it. Parsed in this tab; nothing leaves it unsealed.
 */
const props = defineProps<{ idPrefix: string; rotateFrom?: VaultKeyEntry; submitLabel?: string; bindHost?:{hostAlias:string;gatewayAuth:GatewayAuthPolicy} }>();
const emit = defineEmits<{ added: [entry: VaultKeyEntry, deduplicated: boolean]; cancel: [] }>();

const vault = useVaultStore();
const pem = ref('');
const fileName = ref('');
const name = ref(props.rotateFrom?.name ?? '');
const keyPassphrase = ref('');
const vaultPassphrase = ref('');
const needsPassphrase = ref(false);
const busy = ref(false);
const error = ref('');
const id = (s: string) => `${props.idPrefix}-${s}`;
let alive = true;
let fileGeneration = 0;

/** The pasted key and its passphrase never outlive the form. */
function clearSecrets() {
  fileGeneration++;
  pem.value = '';
  keyPassphrase.value = '';
  vaultPassphrase.value = '';
  fileName.value = '';
  needsPassphrase.value = false;
}

function cancel() {
  vault.cancelAddition();
  clearSecrets();
  emit('cancel');
}

onBeforeUnmount(() => {alive = false; vault.cancelAddition(); clearSecrets();});

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  const seq=++fileGeneration;
  const text=await file.text();
  if(!alive || seq!==fileGeneration)return;
  pem.value = text;
  fileName.value = file.name;
  if (name.value === '') name.value = file.name.replace(/\.(pem|key)$/i, '');
  needsPassphrase.value = false;
  keyPassphrase.value = '';
  input.value = '';
  await inspectKey();
}

async function inspectKey() {
  if(busy.value || !pem.value.trim())return;
  const text=pem.value;const parsed=await prepareSshPrivateKey(text);
  if(!alive || busy.value || pem.value!==text)return;
  needsPassphrase.value=parsed.kind==='needsPassphrase';
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
  if (busy.value || vaultPassphrase.value === '' || pem.value.trim() === '' || (needsPassphrase.value && keyPassphrase.value === '')) return;
  busy.value = true;
  error.value = '';
  try {
    const label = name.value.trim() || 'SSH key';
    const pass = needsPassphrase.value && keyPassphrase.value !== '' ? keyPassphrase.value : undefined;
    const confirmation = vaultPassphrase.value;
    vaultPassphrase.value = '';
    const r = props.rotateFrom
      ? await vault.rotateKey(props.rotateFrom.keyId, pem.value, label, pass, confirmation)
      : await vault.addKey(pem.value, label, pass, confirmation, props.bindHost);
    if (!alive) return;
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
          <input :id="id('file')" type="file" aria-label="Private key file" :disabled="busy" @change="onFile" />
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
        :disabled="busy"
        @input="needsPassphrase = false; fileGeneration++"
        @blur="inspectKey"
      ></textarea>
    </div>
    <div class="field">
      <label class="flabel" :for="id('name')">Name</label>
      <input :id="id('name')" v-model="name" placeholder="e.g. laptop ed25519" autocomplete="off" :disabled="busy" />
    </div>
    <div v-if="needsPassphrase" class="field">
      <label class="flabel" :for="id('kpass')">This key's passphrase</label>
      <input :id="id('kpass')" v-model="keyPassphrase" type="password" autocomplete="off" autofocus :disabled="busy" />
    </div>
    <div class="field">
      <label class="flabel" :for="id('vaultpass')">Vault passphrase</label>
      <input :id="id('vaultpass')" v-model="vaultPassphrase" type="password" autocomplete="current-password" autocapitalize="off" :disabled="busy" />
      <p class="muted hint">Confirm your vault passphrase each time you add or replace a key.</p>
    </div>
    <p v-if="error" :class="needsPassphrase && !error.startsWith('That') ? 'muted hint' : 'error'" role="alert">{{ error }}</p>
    <div class="form-actions">
      <button class="primary" type="submit" :disabled="busy || pem.trim() === '' || vaultPassphrase === '' || (needsPassphrase && keyPassphrase === '')">
        {{ busy ? 'Encrypting…' : (props.submitLabel ?? (props.rotateFrom ? 'Rotate key' : 'Add to vault')) }}
      </button>
      <button type="button" @click="cancel">Cancel</button>
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
