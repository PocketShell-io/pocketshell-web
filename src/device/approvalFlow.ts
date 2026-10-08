/**
 * The /device page's state machine, kept free of Vue so it can be driven in
 * node tests: enter code → review the request → result.
 *
 * Safety properties this class owns (the view only binds to it):
 *   - nothing touches the network until the user submits a code — a
 *     `?code=` prefill only fills the field;
 *   - the broker's approve endpoint is reachable ONLY through approve() /
 *     deny(), and only from the review step, for the exact code that was
 *     looked up and shown (editing the field afterwards cannot retarget it);
 *   - one request in flight at a time, so a double click cannot submit twice.
 */
import { DeviceAuthError, deviceAuthErrorMessage, type DeviceDecision, type DeviceRequestInfo } from '../api/deviceAuth';
import { NotSignedInError } from '../api/sync';
import { formatUserCode, formatUserCodeInput, isValidUserCode, normalizeUserCode } from './userCode';

export interface DeviceAuthApi {
  lookup(userCode: string): Promise<DeviceRequestInfo>;
  decide(userCode: string, approve: boolean): Promise<DeviceDecision>;
}

export type FlowStep = 'enter' | 'review' | 'result';

export class DeviceApprovalFlow {
  step: FlowStep = 'enter';
  /** The field's text, always normalized + dashed. */
  input = '';
  busy = false;
  error = '';
  /** Set when the Google session is gone; the view routes through sign-in. */
  needsSignIn = false;
  /** The request under review, and the normalized code it was fetched for. */
  info: DeviceRequestInfo | null = null;
  reviewedCode = '';
  decision: DeviceDecision | null = null;
  resultError = '';

  private readonly api: DeviceAuthApi;

  constructor(api: DeviceAuthApi, prefill = '') {
    this.api = api;
    this.input = formatUserCodeInput(prefill);
  }

  setInput(raw: string): void {
    this.input = formatUserCodeInput(raw);
    this.error = '';
  }

  get canSubmit(): boolean {
    return this.step === 'enter' && !this.busy && isValidUserCode(normalizeUserCode(this.input));
  }

  /** The code as shown to the user, `XXXX-XXXX`. */
  get reviewedCodeDisplay(): string {
    return formatUserCode(this.reviewedCode);
  }

  /** Step 1 → 2: look the code up. Explicit user action only. */
  async submitCode(): Promise<void> {
    if (!this.canSubmit) return;
    const code = normalizeUserCode(this.input);
    this.busy = true;
    this.error = '';
    try {
      const info = await this.api.lookup(formatUserCode(code));
      this.info = info;
      this.reviewedCode = code;
      this.step = 'review';
    } catch (e) {
      this.error = this.describe(e);
    } finally {
      this.busy = false;
    }
  }

  approve(): Promise<void> {
    return this.decide(true);
  }

  deny(): Promise<void> {
    return this.decide(false);
  }

  /** Back from review to the code field (no network call). */
  back(): void {
    if (this.busy || this.step !== 'review') return;
    this.step = 'enter';
    this.info = null;
    this.reviewedCode = '';
  }

  /** Start over with an empty field. */
  reset(): void {
    if (this.busy) return;
    this.step = 'enter';
    this.input = '';
    this.error = '';
    this.info = null;
    this.reviewedCode = '';
    this.decision = null;
    this.resultError = '';
  }

  private async decide(approve: boolean): Promise<void> {
    if (this.step !== 'review' || this.busy || this.info === null || !isValidUserCode(this.reviewedCode)) return;
    this.busy = true;
    try {
      this.decision = await this.api.decide(formatUserCode(this.reviewedCode), approve);
      this.resultError = '';
    } catch (e) {
      this.decision = null;
      if (e instanceof DeviceAuthError && e.kind === 'lookup_required') {
        // The broker has no record of THIS account looking the code up (a
        // different account did, or the record is gone). Back to the code
        // step with the code kept: Continue re-runs the lookup and re-shows
        // the request before any approval.
        const code = this.reviewedCode;
        this.step = 'enter';
        this.info = null;
        this.reviewedCode = '';
        this.input = formatUserCode(code);
        this.error = e.message;
        this.resultError = '';
        return;
      }
      this.resultError = this.describe(e);
      if (this.needsSignIn) return; // stay on review; the view re-signs in
    } finally {
      this.busy = false;
    }
    this.step = 'result';
  }

  private describe(e: unknown): string {
    if (e instanceof NotSignedInError) {
      this.needsSignIn = true;
      return 'Your Google session expired. Sign in again to continue.';
    }
    if (e instanceof DeviceAuthError) return e.message;
    return deviceAuthErrorMessage('unexpected');
  }
}
