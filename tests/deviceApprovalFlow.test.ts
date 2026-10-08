import { describe, expect, it, vi } from 'vitest';
import { DeviceAuthError, type DeviceRequestInfo } from '../src/api/deviceAuth';
import { NotSignedInError } from '../src/api/sync';
import { DeviceApprovalFlow, type DeviceAuthApi, type FlowOptions } from '../src/device/approvalFlow';

const INFO: DeviceRequestInfo = {
  label: 'alexey@laptop',
  requestIp: '203.0.113.7',
  userAgent: 'pocketshell/1.2',
  createdAt: 1_760_000_000_000,
  expiresAt: 1_760_000_600_000,
  serverNow: 1_760_000_012_000,
  sameNetwork: true,
};

function mockApi(overrides: Partial<DeviceAuthApi> = {}) {
  return {
    lookup: vi.fn(async () => INFO),
    decide: vi.fn(async (_c: string, approve: boolean) => (approve ? 'approved' : 'denied') as const),
    ...overrides,
  };
}

/** A flow where the user typed the whole code themselves. */
function typedFlow(api: DeviceAuthApi, options: FlowOptions = {}) {
  const flow = new DeviceApprovalFlow(api, '', options);
  flow.setInput('BCDF2345');
  return flow;
}

describe('device approval flow', () => {
  it('a ?code= prefill shows only the first half, calls nothing, and cannot Continue by itself', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    await Promise.resolve();
    expect(flow.prefilledCode).toBe('BCDF2345');
    expect(flow.prefillDisplay).toBe('BCDF-····');
    expect(flow.prefillDisplay).not.toContain('2345');
    expect(flow.step).toBe('enter');
    expect(flow.canSubmit).toBe(false);
    await flow.submitCode();
    expect(api.lookup).not.toHaveBeenCalled();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('a prefill needs the last four symbols typed to match before Continue', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    flow.setConfirm('23');
    expect(flow.canSubmit).toBe(false);
    expect(flow.confirmMismatch).toBe(false);
    flow.setConfirm('2346');
    expect(flow.canSubmit).toBe(false);
    expect(flow.confirmMismatch).toBe(true);
    flow.setConfirm('23456'); // too many symbols is not a match either
    expect(flow.canSubmit).toBe(false);
    expect(flow.confirmMismatch).toBe(true);
    flow.setConfirm('2345');
    expect(flow.canSubmit).toBe(true);
    // Typing into the (hidden) full-code field does not bypass the confirm.
    flow.setInput('ZZZZ-ZZZZ');
    await flow.submitCode();
    expect(api.lookup.mock.calls).toEqual([['BCDF-2345']]);
  });

  it('typing into the full-code field alone never satisfies a prefill', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    flow.setInput('BCDF2345');
    expect(flow.canSubmit).toBe(false);
  });

  it('a prefill can be abandoned for typing the whole code', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    flow.enterFullCode();
    expect(flow.prefilledCode).toBe('');
    expect(flow.input).toBe('');
    flow.setInput('GHJK6789');
    await flow.submitCode();
    expect(api.lookup.mock.calls).toEqual([['GHJK-6789']]);
  });

  it('an invalid prefill is ignored entirely', () => {
    const flow = new DeviceApprovalFlow(mockApi(), 'BCDF23');
    expect(flow.prefilledCode).toBe('');
    expect(flow.input).toBe('');
  });

  it('a different-network request cannot be approved until acknowledged', async () => {
    const api = mockApi({ lookup: vi.fn(async () => ({ ...INFO, sameNetwork: false })) });
    const flow = typedFlow(api);
    await flow.submitCode();
    expect(flow.networkCleared).toBe(false);
    expect(flow.canApprove).toBe(false);
    await flow.approve();
    expect(api.decide).not.toHaveBeenCalled();
    flow.acknowledgeNetwork(true);
    expect(flow.canApprove).toBe(true);
    await flow.approve();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', true]]);
  });

  it('deny needs no acknowledgement', async () => {
    const api = mockApi({ lookup: vi.fn(async () => ({ ...INFO, sameNetwork: false })) });
    const flow = typedFlow(api);
    await flow.submitCode();
    await flow.deny();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', false]]);
  });

  it('the acknowledgement does not carry over to another lookup', async () => {
    const api = mockApi({ lookup: vi.fn(async () => ({ ...INFO, sameNetwork: false })) });
    const flow = typedFlow(api);
    await flow.submitCode();
    flow.acknowledgeNetwork(true);
    flow.back();
    await flow.submitCode();
    expect(flow.networkAcknowledged).toBe(false);
    expect(flow.canApprove).toBe(false);
  });

  it('age and expiry run on the broker clock; an expired request cannot be approved', async () => {
    let local = 5_000_000; // a local clock wildly off from the broker's
    const api = mockApi();
    const flow = typedFlow(api, { now: () => local });
    await flow.submitCode();
    // created 1_760_000_000, broker now 1_760_000_012, expires 1_760_000_600
    expect(flow.timing()).toEqual({ ageSeconds: 12, remainingSeconds: 588 });
    local += 30_000;
    expect(flow.timing()).toEqual({ ageSeconds: 42, remainingSeconds: 558 });
    local += 558_000;
    expect(flow.expired).toBe(true);
    expect(flow.canApprove).toBe(false);
    await flow.approve();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('does not submit an incomplete code', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api);
    flow.setInput('bcdf-23');
    expect(flow.input).toBe('BCDF-23');
    expect(flow.canSubmit).toBe(false);
    await flow.submitCode();
    expect(api.lookup).not.toHaveBeenCalled();
  });

  it('a long paste is not truncated into a valid code', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api);
    flow.setInput('BCDF-2345-GH');
    expect(flow.input).toBe('BCDF-2345GH');
    expect(flow.inputTooLong).toBe(true);
    expect(flow.canSubmit).toBe(false);
    await flow.submitCode();
    expect(api.lookup).not.toHaveBeenCalled();
  });

  it('enter → review → approve, with approve only on the explicit call', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api);
    flow.setInput('bcdf 2345');
    await flow.submitCode();
    expect(api.lookup.mock.calls).toEqual([['BCDF-2345']]);
    expect(flow.step).toBe('review');
    expect(flow.info).toEqual(INFO);
    expect(flow.reviewedCodeDisplay).toBe('BCDF-2345');
    // Reaching review approves nothing.
    expect(api.decide).not.toHaveBeenCalled();

    await flow.approve();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', true]]);
    expect(flow.step).toBe('result');
    expect(flow.decision).toBe('approved');
  });

  it('deny sends approve:false', async () => {
    const api = mockApi();
    const flow = typedFlow(api);
    await flow.submitCode();
    await flow.deny();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', false]]);
    expect(flow.decision).toBe('denied');
  });

  it('approve/deny are inert outside the review step', async () => {
    const api = mockApi();
    const flow = typedFlow(api);
    await flow.approve();
    await flow.deny();
    expect(api.decide).not.toHaveBeenCalled();
    await flow.submitCode();
    await flow.approve();
    await flow.approve(); // second click on the result screen
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it('editing the field after lookup cannot retarget the approval', async () => {
    const api = mockApi();
    const flow = typedFlow(api);
    await flow.submitCode();
    flow.setInput('ZZZZ-ZZZZ');
    await flow.approve();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', true]]);
  });

  it('ignores a double click while a request is in flight', async () => {
    let release: () => void = () => {};
    const api = mockApi({
      decide: vi.fn(
        () => new Promise<'approved'>((r) => (release = () => r('approved'))),
      ),
    });
    const flow = typedFlow(api);
    await flow.submitCode();
    const first = flow.approve();
    const second = flow.deny();
    release();
    await Promise.all([first, second]);
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(flow.decision).toBe('approved');
  });

  it('back returns to the field without any call', async () => {
    const api = mockApi();
    const flow = typedFlow(api);
    await flow.submitCode();
    flow.back();
    expect(flow.step).toBe('enter');
    expect(flow.info).toBeNull();
    await flow.approve();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_code', /unknown, used up, or was already opened by another account/],
    ['too_many_wrong_codes', /Too many wrong codes from this account; wait an hour/],
    ['expired', /expired/],
    ['too_many_attempts', /Too many attempts/],
    ['not_allowed', /not allowed/],
  ] as const)('a %s lookup error stays on the code step with a message', async (kind, msg) => {
    const api = mockApi({
      lookup: vi.fn(async () => {
        throw new DeviceAuthError(kind, 400, (await import('../src/api/deviceAuth')).deviceAuthErrorMessage(kind));
      }),
    });
    const flow = typedFlow(api);
    await flow.submitCode();
    expect(flow.step).toBe('enter');
    expect(flow.error).toMatch(msg);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('an approve failure lands on the result screen as an error', async () => {
    const api = mockApi({
      decide: vi.fn(async () => {
        throw new DeviceAuthError('already_used', 409, 'already used');
      }),
    });
    const flow = typedFlow(api);
    await flow.submitCode();
    await flow.approve();
    expect(flow.step).toBe('result');
    expect(flow.decision).toBeNull();
    expect(flow.resultError).toBe('already used');
  });

  it('lookup_required on approve returns to the code step, keeps the code, and re-looks it up on Continue', async () => {
    const api = mockApi({
      decide: vi
        .fn()
        .mockRejectedValueOnce(new DeviceAuthError('lookup_required', 403, 'Look up the code again before approving.'))
        .mockResolvedValueOnce('approved'),
    });
    const flow = typedFlow(api);
    await flow.submitCode();
    await flow.approve();
    expect(flow.step).toBe('enter');
    expect(flow.input).toBe('BCDF-2345');
    expect(flow.error).toBe('Look up the code again before approving.');
    expect(flow.error).not.toMatch(/not allowed/);
    expect(flow.info).toBeNull();
    // Nothing approves until a fresh lookup and another explicit click.
    await flow.approve();
    expect(api.decide).toHaveBeenCalledTimes(1);
    await flow.submitCode();
    expect(api.lookup).toHaveBeenCalledTimes(2);
    expect(flow.step).toBe('review');
    await flow.approve();
    expect(api.decide).toHaveBeenCalledTimes(2);
    expect(flow.decision).toBe('approved');
  });

  it('an expired Google session asks for sign-in instead of failing', async () => {
    const api = mockApi({
      lookup: vi.fn(async () => {
        throw new NotSignedInError('expired');
      }),
    });
    const flow = typedFlow(api);
    await flow.submitCode();
    expect(flow.needsSignIn).toBe(true);
    expect(flow.step).toBe('enter');
  });
});
