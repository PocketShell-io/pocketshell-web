<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const auth = useAuthStore();
const router = useRouter();

function signOut() {
  auth.signOut();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="topbar">
    <RouterLink class="brand" :to="{ name: 'hosts' }">PocketShell</RouterLink>
    <span class="muted">web</span>
    <span class="spacer" />
    <span v-if="auth.signedIn" class="muted">{{ auth.email }}</span>
    <button v-if="auth.signedIn" @click="signOut">Sign out</button>
  </div>
  <RouterView />
</template>
