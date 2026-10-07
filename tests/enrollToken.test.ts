import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEnrollTokenController,
  emptyEnrollTokenView,
  type EnrollTokenView,
} from '../src/platform/enrollTokenStore';

/**
 * The enrollment-token dialog's custody rules: the minted token is
 * MEMORY-ONLY and every exit — close, unmount, regenerate failure, expiry —
 * erases it; a generation guard drops late broker answers so a closed
 * request can never repopulate the dialog; copy is dead the moment the
 * token expires. Nothing is ever logged or persisted.
 */

function harness(
  mint: () => Promise<{ token: string; expiresAtMs: number }>,
  copyImpl?: (token: string) => Promise<void>,
) {
  const copy = copyImpl
    ? vi.fn(copyImpl)
    : vi.fn<(token: string) => Promise<void>>().mockResolvedValue();
  let latest: EnrollTokenView = emptyEnrollTokenView();
  const controller = createEnrollTokenController({
    mint,
    copy: (token) => copy(token),
    onState: (view) => {
      latest = view;
    },
  });
  return { controller, copy, latest: () => latest };
}

const TOKEN_A = 'enroll-token-A.bmj.sig';
const TOKEN_B = 'enroll-token-B.bmj.sig';
const EXPIRY = Date.now() + 300_000;

describe('enrollmentTokenExpiresAndClosedRequestCannotRepopulate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a close (or unmount) during the exchange drops the late token — the dialog stays empty', async () => {
    let resolveMint: (v: { token: string; expiresAtMs: number }) => void = () => {};
    const h = harness(() => new Promise((resolve) => (resolveMint = resolve)));
    h.controller.open();
    const generating = h.controller.generate();
    await vi.advanceTimersByTimeAsync(0);
    h.controller.close(); // the user closed the dialog mid-exchange
    resolveMint({ token: TOKEN_A, expiresAtMs: EXPIRY }); // the broker answers late
    await generating;
    expect(h.latest().token).toBe('');
    expect(h.latest().expiresAtMs).toBeNull();
    expect(h.latest().error).toBe('');
    expect(h.copy).not.toHaveBeenCalled(); // nothing was ever surfaced, nothing copied
  });

  it('a failed regeneration erases the previous token — no stale copyable credential', async () => {
    let fail = false;
    const h = harness(async () => {
      if (fail) throw new Error('The account service could not mint a gateway credential right now.');
      return { token: TOKEN_A, expiresAtMs: EXPIRY };
    });
    h.controller.open();
    await h.controller.generate();
    expect(h.latest().token).toBe(TOKEN_A);
    fail = true;
    await h.controller.generate();
    expect(h.latest().token).toBe('');
    expect(h.latest().expiresAtMs).toBeNull();
    expect(h.latest().copied).toBe(false);
    expect(h.latest().error).toMatch(/could not mint/);
  });

  it('the token expires on its own clock: field emptied, expired flagged, copy dead', async () => {
    const h = harness(() => Promise.resolve({ token: TOKEN_A, expiresAtMs: Date.now() + 5_000 }));
    h.controller.open();
    await h.controller.generate();
    expect(h.latest().token).toBe(TOKEN_A);
    h.copy.mockClear(); // the success auto-copy already happened
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.latest().token).toBe('');
    expect(h.latest().expired).toBe(true);
    await h.controller.copyAgain();
    expect(h.copy).not.toHaveBeenCalled(); // copy stays disabled after expiry
  });

  it('copyAgain refuses once expired and works before it', async () => {
    const h = harness(() => Promise.resolve({ token: TOKEN_B, expiresAtMs: Date.now() + 60_000 }));
    h.controller.open();
    await h.controller.generate();
    await h.controller.copyAgain();
    expect(h.copy).toHaveBeenCalledWith(TOKEN_B);
    expect(h.latest().copied).toBe(true);
    h.copy.mockClear();
    // A next generate with an already-past expiry clamps to an immediate
    // expiry — never a stale copyable token.
    const late = harness(() => Promise.resolve({ token: TOKEN_B, expiresAtMs: Date.now() - 1 }));
    late.controller.open();
    await late.controller.generate();
    await vi.advanceTimersByTimeAsync(0); // the clamped 0ms expiry timer fires
    expect(late.latest().token).toBe('');
    expect(late.latest().expired).toBe(true);
    late.copy.mockClear(); // the pre-expiry-tick auto-copy is not the question here
    await late.controller.copyAgain();
    expect(late.copy).not.toHaveBeenCalled();
  });

  it('close after a COMPLETED token clears it, and a superseded request cannot repopulate', async () => {
    const resolvers: Array<(v: { token: string; expiresAtMs: number }) => void> = [];
    const h = harness(() => new Promise((resolve) => resolvers.push(resolve)));
    h.controller.open();
    // First exchange completes the normal way.
    h.controller.generate();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolvers).toHaveLength(1);
    resolvers[0]!({ token: TOKEN_A, expiresAtMs: EXPIRY });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest().token).toBe(TOKEN_A);
    // A second exchange starts, the dialog closes, THEN the broker answers:
    // the close also erased the old token, and the late answer lands nowhere.
    h.controller.generate();
    await vi.advanceTimersByTimeAsync(0);
    h.controller.close();
    resolvers[1]!({ token: TOKEN_B, expiresAtMs: EXPIRY });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.latest().token).toBe('');
    expect(h.latest().expiresAtMs).toBeNull();
    expect(h.copy).toHaveBeenCalledTimes(1); // only the first token was ever copied
  });

  it('open clears everything, close is idempotent, and busy resets', async () => {
    const h = harness(() => Promise.resolve({ token: TOKEN_A, expiresAtMs: EXPIRY }));
    h.controller.open();
    await h.controller.generate();
    expect(h.latest().token).toBe(TOKEN_A);
    h.controller.open(); // reopened for another host
    expect(h.latest()).toEqual(emptyEnrollTokenView());
    h.controller.close();
    h.controller.close();
    expect(h.latest()).toEqual(emptyEnrollTokenView());
    expect(h.latest().busy).toBe(false);
  });
});

describe('final-corrections custody regressions — fake clock + controlled promises', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expiredArrivalIsNeverCopied — an already-expired mint surfaces nothing, copies nothing', async () => {
    let resolveMint: (v: { token: string; expiresAtMs: number }) => void = () => {};
    const h = harness(() => new Promise((resolve) => (resolveMint = resolve)));
    h.controller.open();
    const generating = h.controller.generate();
    await vi.advanceTimersByTimeAsync(0);
    // The broker answers with a token whose deadline has already passed —
    // scheduling lag, a lying clock, whatever. It must be dead on arrival.
    resolveMint({ token: TOKEN_A, expiresAtMs: Date.now() - 1_000 });
    await generating;
    expect(h.latest().token).toBe('');
    expect(h.latest().expiresAtMs).toBeNull();
    expect(h.latest().expired).toBe(true);
    expect(h.latest().busy).toBe(false);
    expect(h.copy).not.toHaveBeenCalled(); // the pre-0ms-erase auto-copy hole, closed
    // And no clamped timer is left behind to re-flag anything later.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.latest()).toEqual({ ...emptyEnrollTokenView(), expired: true });
  });

  it('oldExpiryTimerCannotEraseReplacement — close+reopen cancels the old dialog timer', async () => {
    const mints: Array<{ token: string; expiresAtMs: number }> = [
      { token: TOKEN_A, expiresAtMs: Date.now() + 5_000 },
      { token: TOKEN_B, expiresAtMs: Date.now() + 60_000 },
    ];
    const h = harness(() => Promise.resolve(mints.shift()!));
    h.controller.open();
    await h.controller.generate(); // token A, expiry timer at +5s
    expect(h.latest().token).toBe(TOKEN_A);
    h.controller.close();
    h.controller.open(); // a fresh dialog for another host
    expect(h.latest()).toEqual(emptyEnrollTokenView());
    // The OLD dialog's timer dies with the old dialog: its firing range
    // passes, and the fresh dialog neither erases nor flags.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.latest()).toEqual(emptyEnrollTokenView());
    // A replacement token in the reopened dialog survives the old deadline…
    await h.controller.generate();
    expect(h.latest().token).toBe(TOKEN_B);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.latest().token).toBe(TOKEN_B);
    expect(h.latest().expired).toBe(false);
    // …and dies on its own clock only.
    await vi.advanceTimersByTimeAsync(55_000);
    expect(h.latest().token).toBe('');
    expect(h.latest().expired).toBe(true);
  });

  it('copyAfterWallClockExpiryRefusesEvenBeforeTheTimer — the clock, not the flag', async () => {
    const h = harness(() => Promise.resolve({ token: TOKEN_A, expiresAtMs: Date.now() + 5_000 }));
    h.controller.open();
    await h.controller.generate();
    h.copy.mockClear(); // the auto-copy belonged to the mint
    // A background tab throttled the timer: the wall clock passes the
    // deadline while `expired` is still false and the timer un-fired.
    vi.setSystemTime(Date.now() + 6_000);
    expect(h.latest().expired).toBe(false);
    await h.controller.copyAgain();
    expect(h.copy).not.toHaveBeenCalled(); // refused, not copied
    expect(h.latest().token).toBe(''); // retired here, not left copyable
    expect(h.latest().expired).toBe(true);
    await h.controller.copyAgain(); // and nothing resurrects it
    expect(h.copy).not.toHaveBeenCalled();
  });

  it('lateCopyCompletionAfterCloseAndReopenCannotTouchTheFreshDialog', async () => {
    const resolvers: Array<() => void> = [];
    const h = harness(
      () => Promise.resolve({ token: TOKEN_A, expiresAtMs: Date.now() + 60_000 }),
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    h.controller.open();
    const generating = h.controller.generate();
    await vi.advanceTimersByTimeAsync(0); // mint resolved, auto-copy pending
    expect(h.latest().token).toBe(TOKEN_A);
    expect(h.latest().copied).toBe(false);
    h.controller.close();
    h.controller.open(); // the next dialog instance
    const fresh = { ...h.latest() };
    resolvers[0]!(); // the stale clipboard write completes
    await generating;
    expect(h.latest()).toEqual(fresh); // untouched: no copied flag, no error, no token
    expect(h.latest()).toEqual(emptyEnrollTokenView());

    // Same custody for a manual copyAgain left in flight across close+reopen.
    const h2 = harness(
      () => Promise.resolve({ token: TOKEN_B, expiresAtMs: Date.now() + 60_000 }),
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    h2.controller.open();
    const generating2 = h2.controller.generate();
    await vi.advanceTimersByTimeAsync(0); // token minted; auto-copy pending
    const pending = h2.controller.copyAgain(); // a second write, also pending
    expect(resolvers.length).toBe(3); // auto-copy, then copyAgain
    h2.controller.close();
    h2.controller.open();
    const fresh2 = { ...h2.latest() };
    resolvers[2]!(); // the copyAgain write completes late
    await pending;
    expect(h2.latest()).toEqual(fresh2);
    expect(h2.latest().copied).toBe(false);
    expect(h2.latest().error).toBe('');
    resolvers[1]!(); // drain the still-suspended auto-copy write
    await generating2;
  });
});

describe('clipboard completions are wall-clock bound too', () => {
  // The counterexample: a background tab throttles the expiry TIMER while a
  // clipboard write is in flight, and the wall clock crosses the broker's
  // absolute deadline. The pending completion must not mark a dead token
  // `copied` (success) or leave a dead token in the field behind the
  // manual-copy hint (rejection) — the completion re-checks the actual clock
  // and retires the token, without claiming to undo the write already
  // submitted to the browser. Timers never run: only Date.now() moves.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Per-write settle control: the k-th clipboard write is settled by
   * `resolvers[k](false)` (RESOLVE) or `resolvers[k](true)` (REJECT) —
   * every write gets its OWN promise and its OWN verdict, so a "late
   * rejection" test can actually reject the write it names (the old
   * reject-first counter rejected only write #0; every later write
   * silently resolved). */
  type WriteSettle = (reject: boolean) => void;
  function harnessWithPendingCopy(resolvers: WriteSettle[]): ReturnType<typeof harness> {
    const h = harness(
      () => Promise.resolve({ token: TOKEN_A, expiresAtMs: Date.now() + 5_000 }),
      () =>
        new Promise<void>((resolve, reject) => {
          resolvers.push((rejectWrite: boolean) =>
            rejectWrite ? reject(new Error('blocked')) : resolve(),
          );
        }),
    );
    return h;
  }

  /** The starting state the retirement regressions below require: an
   * in-window MANUAL-copy failure has left the "copy it by hand" hint up
   * over a still-copyable token. (The AUTO-copy's in-window rejection
   * deliberately sets no error — the token just stays in the field.) */
  async function establishManualCopyHint(
    h: ReturnType<typeof harnessWithPendingCopy>,
    resolvers: WriteSettle[],
  ): Promise<void> {
    h.controller.open();
    const generating = h.controller.generate();
    await vi.advanceTimersByTimeAsync(0); // mint landed, auto-copy pending
    resolvers[0]!(true); // the AUTO-copy is refused inside the window
    await generating;
    expect(h.latest().token).toBe(TOKEN_A); // kept in the field for a manual copy
    expect(h.latest().copied).toBe(false);
    const firstRetry = h.controller.copyAgain();
    resolvers[1]!(true); // the manual retry is refused inside the window
    await firstRetry;
    expect(h.latest().error).toContain('copy it by hand'); // the hint is up
  }

  it('autoCopySuccessAfterWallClockExpiryRetiresInsteadOfCopied', async () => {
    const resolvers: WriteSettle[] = [];
    const h = harnessWithPendingCopy(resolvers);
    h.controller.open();
    const generating = h.controller.generate();
    await vi.advanceTimersByTimeAsync(0); // mint landed, auto-copy pending
    expect(h.latest().token).toBe(TOKEN_A);
    expect(h.latest().copied).toBe(false);
    // The tab is backgrounded: the timer never fires, the wall clock passes
    // the broker's deadline while the write is still in flight.
    vi.setSystemTime(Date.now() + 6_000);
    resolvers[0]!(false); // the write RESOLVES now
    await generating;
    expect(h.latest().token).toBe(''); // retired, not left copyable
    expect(h.latest().expired).toBe(true);
    expect(h.latest().copied).toBe(false); // never flagged copied past expiry
    expect(h.latest().error).toBe('');
    expect(h.latest().busy).toBe(false);
  });

  it('autoCopyRejectionAfterWallClockExpiryRetiresInsteadOfHinting', async () => {
    const resolvers: WriteSettle[] = [];
    const h = harnessWithPendingCopy(resolvers);
    h.controller.open();
    const generating = h.controller.generate();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 6_000);
    resolvers[0]!(true); // the write REJECTS now
    await generating;
    expect(h.latest().token).toBe('');
    expect(h.latest().expired).toBe(true);
    expect(h.latest().copied).toBe(false);
    // No "copy it by hand" hint for a token that no longer exists.
    expect(h.latest().error).toBe('');
    expect(h.latest().busy).toBe(false);
  });

  it('copyAgainSuccessAfterWallClockExpiryRetires', async () => {
    const resolvers: WriteSettle[] = [];
    const h = harnessWithPendingCopy(resolvers);
    h.controller.open();
    const generating = h.controller.generate();
    await vi.advanceTimersByTimeAsync(0); // mint landed, auto-copy pending
    resolvers[0]!(false); // the auto-copy lands inside the window
    await generating;
    expect(h.latest().copied).toBe(true);
    const pending = h.controller.copyAgain(); // second write, pending
    vi.setSystemTime(Date.now() + 6_000); // clock passes the deadline, timer unfired
    resolvers[1]!(false); // the copyAgain write resolves
    await pending;
    expect(h.latest().token).toBe('');
    expect(h.latest().expired).toBe(true);
    expect(h.latest().copied).toBe(false);
  });

  it('copyAgainRejectionAfterWallClockExpiryRetires', async () => {
    // The required regression shape: FIRST an in-window manual-copy failure
    // leaves the hint up, THEN the wall clock expires with the timers
    // throttled, THEN that later write settles — truly REJECTED, like the
    // copy it retried. Retirement must clear the stale hint with
    // everything else: no token, no error, not copied, expired.
    const resolvers: WriteSettle[] = [];
    const h = harnessWithPendingCopy(resolvers);
    await establishManualCopyHint(h, resolvers);
    const pending = h.controller.copyAgain(); // the next manual write, in flight
    vi.setSystemTime(Date.now() + 6_000); // the throttled timer never fires
    resolvers[2]!(true); // the pending manual write is REJECTED late
    await pending;
    expect(h.latest().token).toBe(''); // retired, not left copyable
    expect(h.latest().expired).toBe(true);
    expect(h.latest().copied).toBe(false);
    expect(h.latest().error).toBe(''); // the stale hint died with the token
  });

  it('staleManualCopyHintDiesWhenTheExpiryTimerFires', async () => {
    // Retirement route: the timer itself. The hint outlives neither the
    // token nor the field it hints at.
    const resolvers: WriteSettle[] = [];
    const h = harnessWithPendingCopy(resolvers);
    await establishManualCopyHint(h, resolvers);
    await vi.advanceTimersByTimeAsync(6_000); // the expiry timer fires
    expect(h.latest().token).toBe('');
    expect(h.latest().expired).toBe(true);
    expect(h.latest().copied).toBe(false);
    expect(h.latest().error).toBe('');
  });

  it('staleManualCopyHintDiesAtTheCopyEntryClockCheck', async () => {
    // Retirement route: the wall clock passes the deadline with the timer
    // unfired, and the next copy entry refuses and retires on the spot.
    const resolvers: WriteSettle[] = [];
    const h = harnessWithPendingCopy(resolvers);
    await establishManualCopyHint(h, resolvers);
    vi.setSystemTime(Date.now() + 6_000);
    await h.controller.copyAgain(); // refused at the entry, retired here
    expect(h.copy).toHaveBeenCalledTimes(2); // the refused retry started no write
    expect(h.latest().token).toBe('');
    expect(h.latest().expired).toBe(true);
    expect(h.latest().copied).toBe(false);
    expect(h.latest().error).toBe('');
  });
});
