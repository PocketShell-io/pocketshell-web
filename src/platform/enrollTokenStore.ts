/**
 * The enrollment-token dialog's lifecycle, as a framework-free controller so
 * the custody rules are unit-testable without a component harness.
 *
 * The token is MEMORY-ONLY: it lives in this state object, is never logged,
 * saved, or synced, and every exit path — close, unmount, regenerate
 * failure, expiry — erases it. Custody is enforced along two independent
 * axes, and every asynchronous completion is bound to BOTH:
 *
 *  - GENERATION: `open`, `close` and `generate` each bump the counter; a
 *    completion (broker answer, clipboard write, expiry timer) from an
 *    older generation is dropped whole, so a closed dialog can never be
 *    repopulated by a late promise, a failed regeneration can never retain
 *    the previous token, and a superseded or stale timer can never erase or
 *    flag a dialog it no longer belongs to.
 *  - THE CLOCK: the expiry timer is a convenience for the UI, never the
 *    authority. Before a token is surfaced or copied — auto-copy on mint
 *    and `copyAgain` alike — and again at EVERY asynchronous completion
 *    (broker answer, clipboard write settling either way), the actual wall
 *    clock is checked against the broker's absolute expiry, so an
 *    already-expired mint is never copied, a timer the browser throttled in
 *    a background tab cannot extend the token's life, and a completion that
 *    lands past the deadline retires the token instead of flagging it
 *    copied or leaving the manual-copy hint up. No polling (the timer stays
 *    the exact one-shot bound; the clock check is what gates every copy).
 *
 * A clipboard write that was already performed cannot be undone — nothing
 * here claims otherwise; retiring an expired token after its write settles
 * only stops THIS controller from displaying or re-copying it. The other
 * guarantees: stale completions mutate nothing (the next dialog opens
 * clean) and an expired token is never copied or re-copied.
 */

export interface EnrollTokenView {
  token: string;
  /** Absolute expiry from the broker (unix ms); memory-only. */
  expiresAtMs: number | null;
  /** Set once the token is past its expiry — by the timer, by an
   * already-expired mint arriving, or by a copy attempt noticing the clock
   * pass the deadline first. Copy stays off, field emptied. */
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
  /** Bumped by open/close/generate; a completion from an older generation
   * is discarded whole — it must not repopulate, erase, or flag anything
   * that no longer belongs to it. */
  let generation = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  function render(): void {
    opts.onState({ ...state });
  }

  /** Every lifecycle reset cancels the pending expiry timer first: the
   * timer belongs to THIS dialog instance, and a stale fire must neither
   * erase a replacement token nor flag a fresh dialog expired. The callback
   * is generation-bound too — belt and braces (see `expire`). */
  function cancelExpiryTimer(): void {
    if (expiryTimer !== null) {
      cancel(expiryTimer);
      expiryTimer = null;
    }
  }

  function eraseToken(): void {
    cancelExpiryTimer();
    state.token = '';
    state.expiresAtMs = null;
    state.expired = false;
    state.copied = false;
  }

  /** The clock, not the timer flag, decides whether the token is dead: a
   * throttled or not-yet-fired timer must never extend a token past the
   * broker's absolute deadline. */
  function clockExpired(): boolean {
    return state.expiresAtMs !== null && Date.now() >= state.expiresAtMs;
  }

  /** Expire the CURRENT token now — erase and flag, timer or clock invoked. */
  function expireNow(): void {
    eraseToken();
    state.expired = true;
    render();
  }

  return {
    open() {
      cancelExpiryTimer();
      generation += 1;
      state = emptyEnrollTokenView();
      render();
    },
    close() {
      cancelExpiryTimer();
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
        if (minted.expiresAtMs <= Date.now()) {
          // An already-expired mint is never surfaced, never auto-copied —
          // scheduling lag or a lying clock cannot conjure a copyable token.
          state.busy = false;
          expireNow();
          return;
        }
        state.token = minted.token;
        state.expiresAtMs = minted.expiresAtMs;
        expiryTimer = schedule(
          () => {
            expiryTimer = null;
            if (mine !== generation) return; // a reset cancelled us; never touch the successor
            expireNow();
          },
          // Exact bound: fires at the broker's deadline (clamped so a clock
          // skew can never schedule a negative timeout).
          Math.max(0, minted.expiresAtMs - Date.now()),
        );
        render();
        // The clock, again, immediately before the write: the arrival check
        // read the wall clock a scheduling tick ago, and a dialog resumed in a
        // background tab can resume past its own deadline.
        if (clockExpired()) {
          expireNow();
          return;
        }
        try {
          await opts.copy(minted.token);
          // A late clipboard completion is bound to BOTH axes: not a
          // closed/reopened dialog (generation), and not a token the wall
          // clock killed while the write was in flight (the expiry timer is a
          // convenience a throttled tab can delay; the clock is the
          // authority). Retiring here does not claim to undo the write the
          // browser already performed — it only refuses to keep displaying a
          // dead token or flag it `copied`.
          if (mine !== generation || state.token === '') return;
          if (clockExpired()) {
            expireNow();
            return;
          }
          state.copied = true;
          render();
        } catch {
          if (mine !== generation || state.token === '') return;
          if (clockExpired()) {
            // The rejection lands on a dead token: retiring it beats leaving
            // it in the field behind a manual-copy hint it can no longer
            // honour. The write the browser refused stays refused.
            expireNow();
            return;
          }
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
        if (mine === generation && state.busy) {
          state.busy = false;
          render();
        }
      }
    },
    async copyAgain() {
      if (state.token === '') return;
      if (clockExpired()) {
        // The wall clock passed the deadline before the timer fired (a
        // background tab, a lagging schedule): refuse — and retire the
        // token here rather than trust the timer to catch up.
        expireNow();
        return;
      }
      const mine = generation;
      try {
        await opts.copy(state.token);
        // The clipboard write itself is past undo; a completion from a
        // closed/replaced dialog just lands nowhere. And a completion whose
        // token the wall clock killed in flight is bound by the clock too:
        // retire, never flag `copied`, never leave the manual-copy error up.
        if (mine !== generation || state.token === '') return;
        if (clockExpired()) {
          expireNow();
          return;
        }
        state.copied = true;
      } catch {
        if (mine !== generation || state.token === '') return;
        if (clockExpired()) {
          expireNow();
          return;
        }
        state.error = 'Copying was blocked — select the token and copy it by hand.';
      }
      render();
    },
  };
}
