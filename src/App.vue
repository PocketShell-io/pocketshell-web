<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

// The landing carries its own header; the app topbar is for the app pages.
const bare = computed(() => route.name === 'landing');

function signOut() {
  auth.signOut();
  router.push({ name: 'login' });
}
</script>

<template>
  <div v-if="!bare" class="topbar">
    <RouterLink class="brand" :to="{ name: 'hosts' }">PocketShell</RouterLink>
    <span class="muted">web</span>
    <span class="spacer" />
    <span v-if="auth.signedIn" class="muted">{{ auth.email }}</span>
    <button v-if="auth.signedIn" @click="signOut">Sign out</button>
  </div>
  <RouterView />
</template>
