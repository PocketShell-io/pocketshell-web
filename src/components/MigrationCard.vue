<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useVaultGateStore } from '../stores/vaultGate';
import { hasUnreadable, legacyItems } from '../vault/legacyMigration';

/**
 * The one-time move of pre-vault credentials into the vault. It starts by
 * itself; the user is only asked about what could not move on its own (an
 * encrypted key whose passphrase was never saved). Old copies are deleted
 * after every credential has been read back out of the vault, or when the
 * user explicitly drops the rest.
 */
const gate = useVaultGateStore();
const busy = ref(false);
const error = ref('');
const passphrases = reactive<Record<string, string>>({});
const confirmDrop = ref(false);

const total = computed(() => (gate.legacy ? legacyItems(gate.legacy).length : 0));
const unreadable = computed(() => gate.legacy !== null && hasUnreadable(gate.legacy));
const canRetryWithOld = computed(
  () => gate.legacy !== null && [gate.legacy.account, gate.legacy.local].some((s) => s.state === 'unreadable' && s.reason === 'decrypt'),
);
const oldPassphrase = ref('');
const confirmDeleteUnreadable = ref(false);

async function retryWithOld() {
  busy.value = true;
  error.value = '';
  try {
    await gate.openLegacyWith(oldPassphrase.value);
    oldPassphrase.value = '';
    await gate.migrate({ ...passphrases });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function deleteUnreadable() {
  busy.value = true;
  try {
    await gate.deleteUnreadableLegacy();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
    confirmDeleteUnreadable.value = false;
  }
}

async function run() {
  busy.value = true;
  error.value = '';
  try {
    await gate.migrate({ ...passphrases });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function dropRest() {
  busy.value = true;
  try {
    await gate.finishMigration();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  // Auto-run only when there is something readable to move.
  if (gate.failures.length === 0 && total.value > 0) void run();
});
</script>

<template>
  <section class="unlock-card migrate-card" aria-labelledby="migrate-title">
    <div class="unlock-mark" aria-hidden="true">&gt;_</div>
    <h1 id="migrate-title">Moving your keys into the vault</h1>
    <p class="unlock-lede">
      Keys and passwords saved before the vault are moving into it, so every device can use them with your vault
      passphrase. The old copies are deleted once each one reads back from the vault.
    </p>
    <p v-if="busy && gate.failures.length === 0" class="muted status" role="status">
      Moving {{ total }} {{ total === 1 ? 'credential' : 'credentials' }}…
    </p>

    <form v-if="gate.failures.length > 0" class="unlock-form" @submit.prevent="run">
      <p class="muted">{{ gate.failures.length }} {{ gate.failures.length === 1 ? 'host needs' : 'hosts need' }} your help:</p>
      <div v-for="f in gate.failures" :key="f.host" class="fail-row">
        <div class="fail-host">{{ f.host }}</div>
        <p class="fail-msg">{{ f.message }}</p>
        <template v-if="f.reason === 'needs-passphrase' || f.reason === 'bad-passphrase'">
          <label class="flabel" :for="`mig-${f.host}`">Passphrase of the {{ f.host }} key</label>
          <input :id="`mig-${f.host}`" v-model="passphrases[f.host]" type="password" autocomplete="off" />
        </template>
      </div>
      <div class="form-actions">
        <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Moving…' : 'Try again' }}</button>
        <button type="button" :disabled="busy" @click="confirmDrop = true">Skip these</button>
      </div>
      <div v-if="confirmDrop" class="drop-confirm" role="alertdialog" aria-labelledby="drop-title">
        <p id="drop-title">
          Skipping deletes the old copies of these {{ gate.failures.length === 1 ? 'credential' : 'credentials' }}.
          You can upload the keys again on the Keys page.
        </p>
        <button type="button" class="primary" :disabled="busy" @click="dropRest">Delete old copies</button>
        <button type="button" @click="confirmDrop = false">Keep them for now</button>
      </div>
    </form>
    <div v-if="unreadable && gate.failures.length === 0 && !busy" class="unlock-form">
      <p class="muted" role="status">{{ gate.legacyNotice }}</p>
      <form v-if="canRetryWithOld" @submit.prevent="retryWithOld">
        <label class="flabel" for="mig-oldpass">Old sync passphrase</label>
        <div class="unlock-row">
          <input id="mig-oldpass" v-model="oldPassphrase" type="password" autocomplete="off" />
          <button class="primary" type="submit" :disabled="oldPassphrase === ''">Open them</button>
        </div>
      </form>
      <div class="form-actions">
        <button type="button" @click="gate.deferLegacy()">Continue without them for now</button>
        <button type="button" @click="confirmDeleteUnreadable = true">Delete them…</button>
      </div>
      <div v-if="confirmDeleteUnreadable" class="drop-confirm" role="alertdialog" aria-labelledby="del-unreadable">
        <p id="del-unreadable">
          These old copies could not be read, so nothing in them was moved. Deleting them is permanent; any key only stored
          there is gone.
        </p>
        <button type="button" class="primary" @click="deleteUnreadable">Delete permanently</button>
        <button type="button" @click="confirmDeleteUnreadable = false">Keep them</button>
      </div>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.migrate-card {
  width: min(460px, 100%);
}

.status {
  margin-top: 16px;
}

.fail-row {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-soft);
}

.fail-host {
  font-family: var(--font-mono);
  font-weight: 600;
}

.fail-msg {
  margin: 4px 0 8px;
  font-size: var(--text-small);
  color: var(--fg-secondary);
}

.fail-row input {
  width: 100%;
}

.form-actions {
  margin-top: 16px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.drop-confirm {
  margin-top: 12px;
  padding: 12px;
  background: var(--warning-soft);
  border-radius: 6px;
  font-size: var(--text-small);
}

.drop-confirm button {
  margin: 8px 8px 0 0;
}
</style>
