import type { Pinia } from 'pinia';
import type { ConnectionState } from '@pocketshell/core';
import { useConnectionStore } from '@ui/app/stores/connection';

/**
 * The navigation guard — the one native "are you sure" a browser puts between
 * a keystroke and a closed tab.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — Ctrl+W on the web closes the TAB
 * ---------------------------------------------------------------------------
 * The desktop's half of this story is shared/windowKeys.ts: xterm cancels the
 * keydown (`0x17` IS readline's delete-word) and Electron honours a cancelled
 * keydown by never consulting the accelerator table. A browser honours
 * nothing. Ctrl+W is a RESERVED chord — Chrome, Edge and Firefox decide it in
 * the browser itself, after every page handler has had its say — so on the web
 * the same keystroke that deletes a word at the prompt also closes the tab,
 * and with it every session, pane and line of scrollback this document holds.
 * No capture listener, no stopPropagation, no listener removed and re-added
 * changes that; it is equally true of vscode.dev and every other browser IDE,
 * and it is why the desktop's fix does not carry over.
 *
 * What a page CAN do is make leaving confirmable. A `beforeunload` handler
 * turns Ctrl+W, a reload and the window close button into the browser's own
 * generic "Leave site?" dialog, and staying inside it voids the close. The
 * browser words it, renders it, and may suppress it (a tab the user never
 * interacted with, most mobile browsers); the page's whole vote is whether it
 * is asked for at all. A phone has no Ctrl+W to defend against, so the guard
 * exists for exactly the desktop browsers that suppress it least.
 *
 * WHEN IT ASKS
 * ------------
 * While the connection store is anywhere but 'idle' — connecting, connected,
 * reconnecting, or lost with the workspace still open — because in each of
 * those states closing the document discards sessions and scrollback the user
 * was never asked about. `disconnect()` lands the store back on 'idle', and
 * the guard goes quiet: leaving the host picker is free. SPA navigation
 * (hosts → account → back) never fires `beforeunload` at all, so in-app
 * movement is never nagged either.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 * Not an interception. Chromium's `navigator.keyboard.lock(['KeyW'])` really
 * does hand Ctrl+W to the page, but only while the document is fullscreen
 * through the Fullscreen API — and entering that requires a visible
 * affordance, which the shared chrome deliberately has no home for
 * (HostWorkspaceView: "There is deliberately NO host topbar"; the session
 * header's seven 28px controls are budgeted to the pixel). Wire the lock and
 * its button together, in one round, if that ever changes; until then the
 * dialog is the whole feature.
 */

/** True when closing the document now would discard a workspace the user never confirmed. */
export function shouldConfirmLeave(state: ConnectionState): boolean {
  return state !== 'idle';
}

/**
 * Install the guard for the page's lifetime.
 *
 * The store is read at UNLOAD time, not at install time — one listener, no
 * watcher to keep in step with the FSM, and the value it reads is whatever
 * the connection store believes the instant the tab tries to go away.
 */
export function armNavGuard(pinia: Pinia): void {
  const connection = useConnectionStore(pinia);
  window.addEventListener('beforeunload', (event) => {
    if (!shouldConfirmLeave(connection.state)) return;
    // preventDefault is the spec answer; returnValue is what Chrome's
    // beforeunload path still keys on. Set both.
    event.preventDefault();
    event.returnValue = '';
  });
}
