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

function harness(mint: () => Promise<{ token: string; expiresAtMs: number }>) {
  const copy = vi.fn<(token: string) => Promise<void>>().mockResolvedValue();
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
