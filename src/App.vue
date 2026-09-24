<script setup lang="ts">
// The DESKTOP's root component, on the web: the router-outlet plus the one
// place the app's typography and theme settings are written into the
// document. The desktop's own App.vue is the authority for this wiring —
// every watcher here mirrors it, so a settings change repaints the same way
// on both platforms. (The old web topbar is gone: the shared views carry
// their own chrome, which is the point of the parity round.)
//
// The two desktop pieces that do NOT carry over:
//   - `api.win.setZoom` — browser zoom belongs to the browser;
//   - the account WINDOW (`?window=account`) — the web has an /account route.
import { onBeforeUnmount, onMounted, watchEffect } from 'vue';
import { fontCssVariables } from '@ui/fonts';
import { resolveTheme } from '@ui/themes';
import { useUpdateStore } from '@ui/app/stores/update';
import { useSettingsStore } from '@ui/app/stores/settings';
import { isShortcut } from '@pocketshell/core/shared/shortcuts';
import { deleteWordBackward } from '@pocketshell/core/shared/deleteWord';
import DiagBanner from '@ui/app/components/DiagBanner.vue';
import UpdateBanner from '@ui/app/components/UpdateBanner.vue';

const settings = useSettingsStore();

/**
 * Readline's `Ctrl+W` (`unix-word-rubout`) in the app's own text fields —
 * the desktop App.vue's semantics verbatim: kill the selection, else back
 * through the nearest whitespace, via the native edit path so the undo stack
 * and Vue's listeners stay honest. `.xterm` inputs are NOT text fields here.
 * (The desktop's macOS stand-down is about Electron's window menu; a browser
 * tab has no such menu, so the chord applies everywhere on the web.)
 */
function onDeleteWordBackward(e: KeyboardEvent): void {
  if (!isShortcut(settings.shortcutBindings, 'text.deleteWordBackward', e)) return;
  const target = e.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.disabled || target.readOnly) return;
  if (target.closest('.xterm')) return;
  const { selectionStart, selectionEnd, value } = target;
  if (selectionStart === null || selectionEnd === null) return;

  const result = deleteWordBackward(value, selectionStart, selectionEnd);
  const changed = result.value !== value;
  e.preventDefault();
  e.stopPropagation();
  if (!changed) return;

  try {
    target.setSelectionRange(result.caret, selectionEnd);
    if (!document.execCommand('delete')) throw new Error('unsupported');
  } catch {
    // A Chromium someday without the editing API. setRangeText performs the
    // same splice; an input event is dispatched by hand so every framework
    // listener stays honest.
    target.setRangeText('', result.caret, selectionEnd, 'end');
    target.setSelectionRange(result.caret, result.caret);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * The ONE place a theme becomes pixels — the chosen record's tokens written
 * onto `<html>` as inline custom properties, exactly the desktop's watcher.
 */
watchEffect(() => {
  const theme = resolveTheme(settings.theme);
  const el = document.documentElement;
  el.dataset['theme'] = theme.id;
  el.style.colorScheme = theme.appearance;
  for (const [name, value] of Object.entries(theme.tokens)) {
    el.style.setProperty(name, value);
  }
});

watchEffect(() => {
  const vars = fontCssVariables({
    monospaceFontFamily: settings.monospaceFontFamily,
    terminalFontSize: settings.terminalFontSize,
    editorFontSize: settings.editorFontSize,
  });
  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value);
  }
});

const updates = useUpdateStore();

onMounted(() => {
  void updates.check();
  window.addEventListener('keydown', onDeleteWordBackward, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDeleteWordBackward, true);
});
</script>

<template>
  <!-- The one app-wide surface: unhandled renderer errors, so a component
       that dies mid-render reports itself instead of leaving a blank screen. -->
  <DiagBanner />
  <UpdateBanner />
  <RouterView />
</template>

<style>
/* The desktop App.vue's document rules, verbatim. */
* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  /* CSS equivalent of Windows Terminal's "antialiasingMode": "grayscale", so
     the UI and the terminal it frames are rasterised the same way. */
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* Numbers must not jitter between rows: timestamps, ports, percentages. */
.session-time,
.fwd-table,
.meter-pct,
.sz,
.host-detail,
.folder-count {
  font-variant-numeric: tabular-nums;
}

/* Rows live inside `overflow-y: auto` lists, which clip a +2px offset ring.
   Inset it instead. */
:where(.session-row, .entry, .folder-header):focus-visible {
  outline-offset: -2px;
}
</style>
