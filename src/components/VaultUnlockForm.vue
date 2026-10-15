<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useVaultStore, WrongPassphraseError } from '../stores/vault';
import { useVaultGateStore } from '../stores/vaultGate';

/**
 * The vault unlock (design section 5): passphrase, the per-device choice
 * (default: type it every time), Unlock. A wrong passphrase gets a plain
 * retry; from the fourth failure on the button waits out the backoff, with
 * the countdown on it.
 */
const props = defineProps<{ idPrefix?: string }>();
const emit = defineEmits<{ unlocked: []; forgot: [] }>();

const vault = useVaultStore();
const gate = useVaultGateStore();
const passphrase = ref('');
const remember = ref<'every-time' | 'remember'>('every-time');
const busy = ref(false);
const error = ref('');
const field = ref<HTMLInputElement | null>(null);
const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 500);
onBeforeUnmount(() => clearInterval(timer));

const id = (s: string) => `${props.idPrefix ?? 'vu'}-${s}`;
const waitSec = computed(() => Math.max(0, Math.ceil((vault.retryAt - now.value) / 1000)));

async function submit() {
  if (passphrase.value === '' || waitSec.value > 0) return;
  busy.value = true;
  error.value = '';
  try {
    await gate.submitVaultPassphrase(passphrase.value, remember.value === 'remember');
    passphrase.value = '';
    emit('unlocked');
  } catch (err) {
    error.value =
      err instanceof WrongPassphraseError
        ? "That passphrase didn't unlock your vault. Check it and try again."
        : err instanceof Error
          ? err.message
          : String(err);
    passphrase.value = '';
    field.value?.focus();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="unlock-form vault-form" @submit.prevent="submit">
    <label class="flabel" :for="id('pass')">Vault passphrase</label>
    <div class="unlock-row">
      <input
        :id="id('pass')"
        ref="field"
        v-model="passphrase"
        type="password"
        autocomplete="current-password"
        autofocus
      />
      <button class="primary" type="submit" :disabled="busy || passphrase === '' || waitSec > 0">
        {{ busy ? 'Unlocking…' : waitSec > 0 ? `Wait ${waitSec}s` : 'Unlock' }}
      </button>
    </div>
    <fieldset class="remember-choice">
      <legend class="sr-only">On this device</legend>
      <label class="unlock-remember">
        <input v-model="remember" type="radio" value="every-time" :name="id('remember')" />
        <span>Type it every time</span>
      </label>
      <label class="unlock-remember">
        <input v-model="remember" type="radio" value="remember" :name="id('remember')" />
        <span>Remember on this device</span>
      </label>
    </fieldset>
    <p class="unlock-remember-hint">
      Remembering keeps an encrypted vault key in this browser, locked to a key only this browser holds. The passphrase
      itself is never saved, and never sent to the server.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-else-if="gate.error" class="error" role="alert">{{ gate.error }}</p>
    <p class="forgot">
      <button type="button" class="linklike" @click="emit('forgot')">Forgot your passphrase?</button>
    </p>
  </form>
</template>

<style scoped>
.remember-choice {
  margin: 4px 0 0;
  padding: 0;
  border: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0 16px;
}

.remember-choice input[type='radio'] {
  accent-color: var(--accent-dim);
  flex-shrink: 0;
}

.forgot {
  margin: 12px 0 0;
}

.linklike {
  padding: 0;
  background: none;
  border: 0;
  color: var(--fg-secondary);
  font-size: var(--text-small);
  text-decoration: underline;
  cursor: pointer;
  min-height: 0;
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
