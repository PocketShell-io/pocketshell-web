<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useVaultStore } from '../stores/vault';
import { useVaultGateStore } from '../stores/vaultGate';
import { settleVaultUnlock, unlockSheet } from '../vault/unlockSheet';
import VaultUnlockForm from './VaultUnlockForm.vue';

/**
 * The connect-time unlock sheet: a dial that needs a vault key while the
 * vault is locked lands here — never on a "pick a key" prompt. Unlocking
 * resumes the dial; Cancel fails it with the lock message.
 */
const vault = useVaultStore();
const gate = useVaultGateStore();
const router = useRouter();
const needsSetup = computed(() => vault.phase === 'absent');

function forgot() {
  settleVaultUnlock(false);
  void router.push({ name: 'keys', query: { reset: '1' } });
}

function setUp() {
  settleVaultUnlock(false);
  void router.push({ name: 'app-hosts' });
}

if (vault.phase === 'unknown') void gate.open();
</script>

<template>
  <div v-if="unlockSheet.open" class="sheet-backdrop" @click.self="settleVaultUnlock(false)">
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" @keydown.esc="settleVaultUnlock(false)">
      <h2 id="sheet-title">{{ needsSetup ? 'Set up your key vault' : 'Unlock your vault to connect' }}</h2>
      <template v-if="needsSetup">
        <p class="muted">Keys now live in your account's key vault. Create it on the Hosts page, then connect again.</p>
        <div class="sheet-actions">
          <button class="primary" type="button" @click="setUp">Go to Hosts</button>
          <button type="button" @click="settleVaultUnlock(false)">Cancel</button>
        </div>
      </template>
      <template v-else>
        <p v-if="unlockSheet.reason" class="muted">{{ unlockSheet.reason }}</p>
        <VaultUnlockForm id-prefix="sheet" @unlocked="settleVaultUnlock(true)" @forgot="forgot" />
        <div class="sheet-actions">
          <button type="button" @click="settleVaultUnlock(false)">Cancel</button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgb(0 0 0 / 0.5);
}

@media (min-width: 641px) {
  .sheet-backdrop {
    align-items: center;
  }
}

.sheet {
  width: min(420px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: 20px 20px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px 10px 0 0;
}

@media (min-width: 641px) {
  .sheet {
    border-radius: 10px;
  }
}

.sheet h2 {
  margin: 0 0 8px;
  font-size: var(--text-lede);
}

.sheet-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
