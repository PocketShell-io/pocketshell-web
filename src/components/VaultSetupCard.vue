<script setup lang="ts">
import { computed, ref } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { useVaultGateStore } from '../stores/vaultGate';
import NewPassphraseFields from './NewPassphraseFields.vue';

/**
 * First setup (design section 5): create the account's vault passphrase.
 * One passphrase from now on — the vault also carries the sync passphrase.
 * It must differ from the sync passphrase (decision #7): the host list is
 * protected more weakly and would otherwise be a cheap way to guess it.
 */
const hosts = useHostsStore();
const gate = useVaultGateStore();
const fresh = ref('');
const remember = ref<'every-time' | 'remember'>('every-time');
const understood = ref(false);
const busy = ref(false);
const error = ref('');

const hasHostList = computed(() => hosts.unlocked && gate.mainExists);
const chosen = computed(() => fresh.value);

async function create() {
  if (chosen.value === '' || !understood.value) return;
  busy.value = true;
  error.value = '';
  try {
    await gate.createVault(chosen.value, remember.value === 'remember');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="unlock-card setup-card" aria-labelledby="setup-title">
    <div class="unlock-mark" aria-hidden="true">&gt;_</div>
    <h1 id="setup-title">Create your vault passphrase</h1>
    <p class="unlock-lede">
      Your SSH keys and host passwords are encrypted in this browser with this passphrase before they reach your
      account. One passphrase unlocks your keys and your host list on every device.
    </p>
    <form class="unlock-form" @submit.prevent="create">
      <p v-if="hasHostList" class="muted fine">
        Use a passphrase different from your sync passphrase. After this you only type the vault passphrase; it opens
        your host list too.
      </p>
      <NewPassphraseFields id-prefix="setup" @update:valid="fresh = $event" />

      <p class="warn-text">
        <strong>If you forget it, your keys cannot be recovered.</strong> You'll reset the vault and upload them
        again. PocketShell never sees this passphrase and cannot reset it for you.
      </p>
      <label class="unlock-remember">
        <input v-model="understood" type="checkbox" />
        <span>I understand that a forgotten passphrase means uploading my keys again</span>
      </label>

      <fieldset class="choice">
        <legend class="flabel">On this device</legend>
        <label class="unlock-remember">
          <input v-model="remember" type="radio" value="every-time" name="setup-remember" />
          <span>Type it every time</span>
        </label>
        <label class="unlock-remember">
          <input v-model="remember" type="radio" value="remember" name="setup-remember" />
          <span>Remember on this device</span>
        </label>
      </fieldset>

      <button class="primary create" type="submit" :disabled="busy || chosen === '' || !understood">
        {{ busy ? 'Creating the vault…' : 'Create vault' }}
      </button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </section>
</template>

<style scoped>
.setup-card {
  width: min(460px, 100%);
}

.choice {
  margin: 12px 0 0;
  padding: 0;
  border: 0;
}

.choice input[type='radio'],
.unlock-remember input[type='checkbox'] {
  accent-color: var(--accent-dim);
  flex-shrink: 0;
}

.warn-text {
  margin: 16px 0 4px;
  padding: 10px 12px;
  background: var(--warning-soft);
  border-radius: 6px;
  font-size: var(--text-small);
  color: var(--fg);
}

.fine {
  margin: 12px 0 0;
  font-size: var(--text-small);
}

.create {
  margin-top: 12px;
  width: 100%;
}
</style>
