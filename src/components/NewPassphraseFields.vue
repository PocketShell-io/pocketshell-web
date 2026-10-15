<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MIN_LENGTH, passphraseStrength } from '../vault/strength';

/**
 * A new vault passphrase, entered twice, with a strength meter. Emits the
 * passphrase once it is long enough and both entries match, else ''.
 */
const props = defineProps<{ idPrefix: string; label?: string }>();
const emit = defineEmits<{ 'update:valid': [passphrase: string] }>();

const first = ref('');
const second = ref('');
const strength = computed(() => passphraseStrength(first.value));
const mismatch = computed(() => second.value !== '' && first.value !== second.value);
watch([first, second], () => {
  emit('update:valid', first.value.length >= MIN_LENGTH && first.value === second.value ? first.value : '');
});
defineExpose({
  clear() {
    first.value = '';
    second.value = '';
  },
});
</script>

<template>
  <div class="newpass">
    <div class="field">
      <label class="flabel" :for="`${props.idPrefix}-new`">{{ props.label ?? 'New vault passphrase' }}</label>
      <input
        :id="`${props.idPrefix}-new`"
        v-model="first"
        type="password"
        autocomplete="new-password"
        :aria-describedby="`${props.idPrefix}-meter`"
      />
    </div>
    <div class="meter" :id="`${props.idPrefix}-meter`" aria-live="polite">
      <span class="bars" aria-hidden="true">
        <span v-for="n in 4" :key="n" class="bar" :class="{ on: strength.score >= n, [`s${strength.score}`]: true }" />
      </span>
      <span class="meter-label">
        {{ first === '' ? `At least ${MIN_LENGTH} characters. A few unrelated words work well.` : `Strength: ${strength.label}` }}
      </span>
    </div>
    <div class="field">
      <label class="flabel" :for="`${props.idPrefix}-again`">Type it again</label>
      <input
        :id="`${props.idPrefix}-again`"
        v-model="second"
        type="password"
        autocomplete="new-password"
        :aria-invalid="mismatch ? 'true' : undefined"
      />
    </div>
    <p v-if="mismatch" class="error" role="alert">The two passphrases don't match.</p>
  </div>
</template>

<style scoped>
.newpass .field {
  margin-top: 8px;
}

.newpass input {
  width: 100%;
  min-width: 0;
}

.meter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 4px;
  font-size: var(--text-fine);
  color: var(--fg-secondary);
}

.bars {
  display: inline-flex;
  gap: 3px;
}

.bar {
  width: 22px;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
}

.bar.on.s1 {
  background: var(--error);
}

.bar.on.s2 {
  background: var(--warning);
}

.bar.on.s3,
.bar.on.s4 {
  background: var(--success);
}
</style>
