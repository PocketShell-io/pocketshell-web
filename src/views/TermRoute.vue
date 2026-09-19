<script setup lang="ts">
/**
 * The /term/:name route's mode switch: a configured relay means the browser
 * speaks SSH itself, and the host gets the full sessions workspace (sidebar,
 * tabs, status bar). The Lambda bridge has no exec channel, so bridge-mode
 * users keep the single raw-shell terminal.
 */
import { computed } from 'vue';
import HostWorkspaceView from './HostWorkspaceView.vue';
import TerminalView from './TerminalView.vue';
import { config } from '../config';

const direct = computed(() => config.directWsUrl !== '');
</script>

<template>
  <HostWorkspaceView v-if="direct" />
  <TerminalView v-else />
</template>
