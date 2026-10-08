<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { isConfigured } from '../config';
import { renderLoginButton } from '../auth/google';
import { useAuthStore } from '../stores/auth';
import { afterLoginTarget } from '../auth/returnTo';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const buttonEl = ref<HTMLElement | null>(null);
// The GIS script arrives late (async defer), so the button slot tracks it:
// a placeholder holds the slot while loading, and a failure becomes a
// styled notice with a retry instead of a bare error paragraph.
const gsi = ref<'loading' | 'ready' | 'failed'>('loading');
const error = ref('');
const ready = isConfigured();
// Arriving from /device: say why sign-in is needed before the approval.
const forDevice = computed(() => route.query.next === 'device');

onMounted(async () => {
  if (auth.signedIn) {
    router.replace(afterLoginTarget(route.query));
    return;
  }
  if (!ready) return;
  try {
    await renderLoginButton(buttonEl.value!, (idToken) => {
      auth.signIn(idToken);
      // Sign-in lands on the home — the shared host picker — the same screen
      // every back path returns to; host prep lives one hop away on /app.
      // The one exception is the CLI-approval page, which asked to come back.
      router.push(afterLoginTarget(route.query));
    });
    gsi.value = 'ready';
  } catch (e) {
    gsi.value = 'failed';
    error.value = e instanceof Error ? e.message : String(e);
  }
});

function retry() {
  window.location.reload();
}
</script>

<template>
  <main class="page auth-page">
    <section class="auth-card" aria-labelledby="auth-heading">
      <div class="auth-mark" aria-hidden="true">&gt;_</div>
      <h1 id="auth-heading">Sign in to PocketShell</h1>
      <p v-if="forDevice" class="auth-lede">
        Sign in to review the <code>pocketshell login</code> request from your
        terminal. Nothing is approved until you confirm it on the next screen.
      </p>
      <p v-else class="auth-lede">
        Your hosts, in a browser tab. Sign in with the same Google account the
        desktop app syncs with.
      </p>
      <div v-if="!ready" class="auth-notice" role="note">
        <p>
          Login is not configured: <code>config.js</code> needs a Google
          <strong>Web application</strong> OAuth client ID (see the README's
          first-run checklist).
        </p>
      </div>
      <template v-else>
        <div v-if="gsi !== 'failed'" class="auth-slot">
          <div ref="buttonEl" class="auth-slot-button" />
          <div
            v-if="gsi === 'loading'"
            class="auth-slot-pending"
            role="status"
            aria-live="polite"
          >
            <span class="auth-spinner" aria-hidden="true" /> Loading sign-in…
          </div>
        </div>
        <div v-if="error" class="auth-notice" role="alert">
          <p>{{ error }}</p>
          <button type="button" @click="retry">Try again</button>
        </div>
      </template>
    </section>
    <nav class="auth-back">
      <a href="https://pocketshell.io/">← What is PocketShell?</a>
    </nav>
  </main>
</template>
