<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { claimsOf, renderLoginButton } from '../auth/google';
import { useAuthStore } from '../stores/auth';
import { useHostsStore } from '../stores/hosts';
import { useVaultStore } from '../stores/vault';
import { useVaultGateStore } from '../stores/vaultGate';
import NewPassphraseFields from './NewPassphraseFields.vue';

/**
 * Forgot passphrase / reset (design section 5): re-authenticate with Google,
 * read what a reset loses, type RESET, choose a new passphrase. The vault's
 * slots are wiped, the epoch bumped, and a new, empty vault created. Host
 * bindings and the sync passphrase carry over when this tab still knows them
 * (it is unlocked); otherwise the sync passphrase is asked for and checked
 * against the host list — or, if that is forgotten too, the host list is
 * deleted as well and a generated sync passphrase starts a new one. The new
 * vault passphrase must differ from the sync passphrase (decision #7).
 */
const emit = defineEmits<{ done: []; cancel: [] }>();

const FRESH_SECONDS = 300;

const auth = useAuthStore();
const hosts = useHostsStore();
const vault = useVaultStore();
const gate = useVaultGateStore();

const step = ref<'reauth' | 'confirm' | 'done'>('reauth');
const gsiSlot = ref<HTMLElement | null>(null);
const reauthError = ref('');
const confirmText = ref('');
const newPassphrase = ref('');
const syncMode = ref<'known' | 'enter' | 'forgot'>('enter');
const syncInput = ref('');
const remember = ref<'every-time' | 'remember'>('every-time');
const busy = ref(false);
const error = ref('');

const carry = vault.carryForReset();
const knownSync = carry.syncPassphrase ?? (hosts.unlocked ? hosts.passphrase : null);
if (knownSync !== null && knownSync !== '') syncMode.value = 'known';

/** A fresh Google sign-in for the SAME account, within the last 5 minutes. */
function onFreshToken(idToken: string) {
  try {
    const fresh = claimsOf(idToken);
    const current = claimsOf(auth.idToken);
    if (fresh.sub !== current.sub) {
      reauthError.value = `That is a different Google account (${fresh.email}). Sign in as ${current.email}.`;
      return;
    }
    const at = fresh.auth_time ?? fresh.iat ?? 0;
    if (Date.now() / 1000 - at > FRESH_SECONDS) {
      reauthError.value = 'That sign-in is not fresh. Choose your account again.';
      return;
    }
    auth.signIn(idToken);
    reauthError.value = '';
    step.value = 'confirm';
  } catch {
    reauthError.value = 'Google sign-in did not return a usable token. Try again.';
  }
}

onMounted(async () => {
  await nextTick();
  if (gsiSlot.value === null) return;
  try {
    const ok = await renderLoginButton(gsiSlot.value, onFreshToken);
    if (!ok) reauthError.value = 'Google sign-in is not configured on this deployment.';
  } catch (err) {
    reauthError.value = err instanceof Error ? err.message : String(err);
  }
});

const ready = computed(
  () =>
    confirmText.value.trim() === 'RESET' &&
    newPassphrase.value !== '' &&
    (syncMode.value !== 'enter' || syncInput.value !== '' || !gate.mainExists),
);

async function runReset() {
  if (!ready.value) return;
  busy.value = true;
  error.value = '';
  try {
    const sync =
      syncMode.value === 'known'
        ? ({ mode: 'known' } as const)
        : syncMode.value === 'enter' && gate.mainExists
          ? ({ mode: 'enter', passphrase: syncInput.value } as const)
          : ({ mode: 'forgot' } as const);
    await gate.resetVault(newPassphrase.value, sync, remember.value === 'remember');
    step.value = 'done';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="reset" aria-labelledby="reset-title">
    <h2 id="reset-title">Reset your vault</h2>

    <div class="explain">
      <p>
        A forgotten vault passphrase cannot be recovered: nobody, PocketShell included, can decrypt your keys without
        it. Resetting <strong>deletes every key and password in your vault</strong> on every device and starts a new,
        empty vault with a new passphrase.
      </p>
      <p>
        After the reset, upload your keys again from their files. Hosts keep their key assignments
        <template v-if="Object.keys(carry.hosts).length > 0"> ({{ Object.keys(carry.hosts).length }} carried over)</template>,
        so re-uploading the same key reattaches it.
      </p>
    </div>

    <div v-if="step === 'reauth'" class="reauth">
      <p class="muted">First, confirm it's you: sign in with Google again.</p>
      <div ref="gsiSlot" class="gsi-slot" />
      <p v-if="reauthError" class="error" role="alert">{{ reauthError }}</p>
      <button type="button" @click="emit('cancel')">Cancel</button>
    </div>

    <form v-else-if="step === 'confirm'" class="unlock-form" @submit.prevent="runReset">
      <NewPassphraseFields id-prefix="reset" @update:valid="newPassphrase = $event" />

      <fieldset v-if="gate.mainExists && syncMode !== 'known'" class="choice">
        <legend class="flabel">Your host list is encrypted with your sync passphrase</legend>
        <label class="unlock-remember">
          <input v-model="syncMode" type="radio" value="enter" name="reset-sync" />
          <span>I know my sync passphrase</span>
        </label>
        <div v-if="syncMode === 'enter'" class="field">
          <label class="flabel" for="reset-syncpass">Sync passphrase</label>
          <input id="reset-syncpass" v-model="syncInput" type="password" autocomplete="off" />
        </div>
        <label class="unlock-remember">
          <input v-model="syncMode" type="radio" value="forgot" name="reset-sync" />
          <span>I forgot that too: also delete my synced host list</span>
        </label>
      </fieldset>

      <fieldset class="choice">
        <legend class="flabel">On this device</legend>
        <label class="unlock-remember">
          <input v-model="remember" type="radio" value="every-time" name="reset-remember" />
          <span>Type it every time</span>
        </label>
        <label class="unlock-remember">
          <input v-model="remember" type="radio" value="remember" name="reset-remember" />
          <span>Remember on this device</span>
        </label>
      </fieldset>

      <div class="field">
        <label class="flabel" for="reset-confirm">Type RESET to delete your vault's keys</label>
        <input id="reset-confirm" v-model="confirmText" autocomplete="off" autocapitalize="characters" spellcheck="false" />
      </div>
      <div class="form-actions">
        <button class="primary danger" type="submit" :disabled="busy || !ready">
          {{ busy ? 'Resetting…' : 'Delete keys and reset the vault' }}
        </button>
        <button type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>

    <div v-else class="done" role="status">
      <p>Your vault was reset. Upload your keys again; hosts that used them pick them up automatically.</p>
      <button class="primary" type="button" @click="emit('done')">Upload keys</button>
    </div>
  </section>
</template>

<style scoped>
.reset {
  margin-top: 16px;
}

.reset h2 {
  margin: 0 0 8px;
  font-size: var(--text-lede);
}

.explain {
  padding: 12px 14px;
  background: var(--warning-soft);
  border-radius: 6px;
  font-size: var(--text-small);
}

.explain p {
  margin: 0 0 8px;
}

.explain p:last-child {
  margin: 0;
}

.reauth {
  margin-top: 16px;
}

.gsi-slot {
  margin: 8px 0 12px;
  min-height: 44px;
}

.choice {
  margin: 12px 0 0;
  padding: 0;
  border: 0;
}

.field {
  margin-top: 8px;
}

.field input {
  width: 100%;
}

.form-actions {
  margin-top: 16px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.danger {
  background: var(--error);
  color: var(--on-accent);
}

.done {
  margin-top: 16px;
}
</style>
