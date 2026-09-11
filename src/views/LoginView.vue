<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { isConfigured } from '../config';
import { renderLoginButton } from '../auth/google';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const buttonEl = ref<HTMLElement | null>(null);
const error = ref('');
const ready = isConfigured();

onMounted(async () => {
  if (auth.signedIn) {
    router.replace({ name: 'hosts' });
    return;
  }
  if (!ready) return;
  try {
    await renderLoginButton(buttonEl.value!, (idToken) => {
      auth.signIn(idToken);
      router.push({ name: 'hosts' });
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <main class="page">
    <h1>PocketShell</h1>
    <p class="muted">Your hosts, in a browser tab. Sign in with the same Google account the desktop app syncs with.</p>
    <div v-if="!ready" class="error">
      Login is not configured: <code>config.js</code> needs a Google <strong>Web application</strong>
      OAuth client ID (see the README's first-run checklist).
    </div>
    <div v-else ref="buttonEl" />
    <p v-if="error" class="error">{{ error }}</p>
    <p class="muted"><RouterLink :to="{ name: 'landing' }">← What is PocketShell?</RouterLink></p>
  </main>
</template>
