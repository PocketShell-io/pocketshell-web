import { describe, expect, it, vi } from 'vitest';
import { DeviceAuthError, type DeviceRequestInfo } from '../src/api/deviceAuth';
import { NotSignedInError } from '../src/api/sync';
import { DeviceApprovalFlow, type DeviceAuthApi } from '../src/device/approvalFlow';

const INFO: DeviceRequestInfo = {
  label: 'alexey@laptop',
  requestIp: '203.0.113.7',
  userAgent: 'pocketshell/1.2',
  createdAt: 1_760_000_000_000,
  expiresAt: 1_760_000_600_000,
};

function mockApi(overrides: Partial<DeviceAuthApi> = {}) {
  return {
    lookup: vi.fn(async () => INFO),
    decide: vi.fn(async (_c: string, approve: boolean) => (approve ? 'approved' : 'denied') as const),
    ...overrides,
  };
}

describe('device approval flow', () => {
  it('a ?code= prefill fills the field and calls nothing', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    await Promise.resolve();
    expect(flow.input).toBe('BCDF-2345');
    expect(flow.step).toBe('enter');
    expect(api.lookup).not.toHaveBeenCalled();
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
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    await flow.submitCode();
    await flow.deny();
    expect(api.decide.mock.calls).toEqual([['BCDF-2345', false]]);
    expect(flow.decision).toBe('denied');
  });

  it('approve/deny are inert outside the review step', async () => {
    const api = mockApi();
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
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
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
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
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
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
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    await flow.submitCode();
    flow.back();
    expect(flow.step).toBe('enter');
    expect(flow.info).toBeNull();
    await flow.approve();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_code', /unknown or has expired/],
    ['expired', /expired/],
    ['too_many_attempts', /Too many attempts/],
    ['not_allowed', /not allowed/],
  ] as const)('a %s lookup error stays on the code step with a message', async (kind, msg) => {
    const api = mockApi({
      lookup: vi.fn(async () => {
        throw new DeviceAuthError(kind, 400, (await import('../src/api/deviceAuth')).deviceAuthErrorMessage(kind));
      }),
    });
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
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
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    await flow.submitCode();
    await flow.approve();
    expect(flow.step).toBe('result');
    expect(flow.decision).toBeNull();
    expect(flow.resultError).toBe('already used');
  });

  it('an expired Google session asks for sign-in instead of failing', async () => {
    const api = mockApi({
      lookup: vi.fn(async () => {
        throw new NotSignedInError('expired');
      }),
    });
    const flow = new DeviceApprovalFlow(api, 'BCDF2345');
    await flow.submitCode();
    expect(flow.needsSignIn).toBe(true);
    expect(flow.step).toBe('enter');
  });
});
