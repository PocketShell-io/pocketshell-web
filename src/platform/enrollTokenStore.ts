/**
 * The enrollment-token dialog's lifecycle, as a framework-free controller so
 * the custody rules are unit-testable without a component harness.
 *
 * The token is MEMORY-ONLY: it lives in this state object, is never logged,
 * saved, or synced, and every exit path — close, unmount, regenerate
 * failure, expiry — erases it. A generation counter invalidates requests
 * that outlive their dialog: a broker answer arriving after a close (or
 * after a newer generate) is dropped whole, so a closed dialog can never be
 * repopulated by a late promise and a failed regeneration can never retain
 * the previous token.
 */

export interface EnrollTokenView {
  token: string;
  /** Absolute expiry from the broker (unix ms); memory-only. */
  expiresAtMs: number | null;
  /** Set once the expiry timer fired — copy stays off, field emptied. */
  expired: boolean;
  busy: boolean;
  error: string;
  copied: boolean;
}

export interface EnrollTokenController {
  /** Fresh dialog for one host: clears everything, invalidates any request
   * still in flight from a previous open. */
  open(): void;
  /** Close (and unmount): invalidate + erase. The safest button in the box. */
  close(): void;
  generate(): Promise<void>;
  copyAgain(): Promise<void>;
}

/** What a fresh view looks like — exported so hosts (and tests) can seed. */
export function emptyEnrollTokenView(): EnrollTokenView {
  return { token: '', expiresAtMs: null, expired: false, busy: false, error: '', copied: false };
}

export function createEnrollTokenController(opts: {
  /** Mint one token. Rejects → erased state plus the error sentence. */
  mint: () => Promise<{ token: string; expiresAtMs: number }>;
  /** Clipboard write; a rejection becomes the manual-copy hint. */
  copy: (token: string) => Promise<void>;
  /** Full-state render — the host mirrors this into its reactive view. */
  onState: (view: EnrollTokenView) => void;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): EnrollTokenController {
  const schedule = opts.setTimeoutImpl ?? setTimeout;
  const cancel = opts.clearTimeoutImpl ?? clearTimeout;
  let state: EnrollTokenView = emptyEnrollTokenView();
  /** Bumped by open/close/generate; a response from an older generation is
   * discarded whole — it must not repopulate anything. */
  let generation = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  function render(): void {
    opts.onState({ ...state });
  }

  function eraseToken(): void {
    state.token = '';
    state.expiresAtMs = null;
    state.expired = false;
    state.copied = false;
    if (expiryTimer !== null) {
      cancel(expiryTimer);
      expiryTimer = null;
    }
  }

  return {
    open() {
      generation += 1;
      state = emptyEnrollTokenView();
      render();
    },
    close() {
      generation += 1;
      state = emptyEnrollTokenView();
      render();
    },
    async generate() {
      if (state.busy) return;
      const mine = ++generation;
      eraseToken();
      state.busy = true;
      state.error = '';
      render();
      try {
        const minted = await opts.mint();
        if (mine !== generation) return; // closed or superseded mid-exchange
        state.token = minted.token;
        state.expiresAtMs = minted.expiresAtMs;
        expiryTimer = schedule(
          () => {
            expiryTimer = null;
            eraseToken();
            state.expired = true;
            render();
          },
          // Bounded by the broker contract; clamp so a clock skew can never
          // schedule a negative (fires immediately) timeout.
          Math.max(0, minted.expiresAtMs - Date.now()),
        );
        render();
        try {
          await opts.copy(minted.token);
          if (mine !== generation) return;
          state.copied = true;
          render();
        } catch {
          if (mine !== generation) return;
          // Clipboard blocked: the token stays in the field for a manual copy.
          render();
        }
      } catch (e) {
        if (mine !== generation) return;
        // A failed regeneration must not leave the previous token in place.
        eraseToken();
        state.error = e instanceof Error ? e.message : String(e);
        render();
      } finally {
        if (mine === generation) {
          state.busy = false;
          render();
        }
      }
    },
    async copyAgain() {
      if (state.token === '' || state.expired) return;
      try {
        await opts.copy(state.token);
        state.copied = true;
      } catch {
        state.error = 'Copying was blocked — select the token and copy it by hand.';
      }
      render();
    },
  };
}
