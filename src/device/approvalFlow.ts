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
 *   - one request in flight at a time, so a double click cannot submit twice;
 *   - a `?code=` link is never enough on its own: the user must type the
 *     code's last four symbols from their terminal (a phishing link carries
 *     a code the victim's terminal never printed, so they have nothing to
 *     type);
 *   - when the broker says the request came from a different network, Approve
 *     stays shut until the user explicitly acknowledges that;
 *   - an expired request (on the broker's clock) cannot be approved.
 */
import { DeviceAuthError, deviceAuthErrorMessage, type DeviceDecision, type DeviceRequestInfo } from '../api/deviceAuth';
import { NotSignedInError } from '../api/sync';
import { requestTiming, type RequestTiming } from './requestTiming';
import { formatUserCode, formatUserCodeInput, isOverlongUserCode, isValidUserCode, normalizeUserCode } from './userCode';

export interface DeviceAuthApi {
  lookup(userCode: string): Promise<DeviceRequestInfo>;
  decide(userCode: string, approve: boolean): Promise<DeviceDecision>;
}

export type FlowStep = 'enter' | 'review' | 'result';

/** How many trailing symbols of a link-prefilled code the user must type. */
export const CONFIRM_SYMBOLS = 4;

export interface FlowOptions {
  /** Local clock, ms. Injected by tests. */
  now?: () => number;
}

export class DeviceApprovalFlow {
  step: FlowStep = 'enter';
  /** The field's text, always normalized + dashed. */
  input = '';
  /** The code a `?code=` link carried (normalized), until the user either
   * confirms it or chooses to type a code in full. While set, the page shows
   * only its first half and asks for the last four symbols. */
  prefilledCode = '';
  /** What the user typed for the last four symbols, normalized. */
  confirmInput = '';
  busy = false;
  error = '';
  /** Set when the Google session is gone; the view routes through sign-in. */
  needsSignIn = false;
  /** The request under review, and the normalized code it was fetched for. */
  info: DeviceRequestInfo | null = null;
  reviewedCode = '';
  decision: DeviceDecision | null = null;
  resultError = '';
  /** Local ms when the lookup under review answered (for the countdown). */
  receivedAt = 0;
  /** The user ticked "I understand this came from a different network". */
  networkAcknowledged = false;

  private readonly api: DeviceAuthApi;
  private readonly now: () => number;

  constructor(api: DeviceAuthApi, prefill = '', options: FlowOptions = {}) {
    this.api = api;
    this.now = options.now ?? Date.now;
    const code = normalizeUserCode(prefill);
    // Only a whole valid code puts the page in confirm mode; anything else
    // starts with an empty field.
    this.prefilledCode = isValidUserCode(code) ? code : '';
  }

  /** `BCDF-····`: the link's code with the part the user must supply hidden,
   * so it cannot be copied off this page. */
  get prefillDisplay(): string {
    if (!this.prefilledCode) return '';
    const shown = this.prefilledCode.slice(0, -CONFIRM_SYMBOLS);
    return formatUserCode(shown + '·'.repeat(CONFIRM_SYMBOLS));
  }

  setConfirm(raw: string): void {
    this.confirmInput = normalizeUserCode(raw);
    this.error = '';
  }

  /** Four (or more) symbols typed that are not the link code's last four. */
  get confirmMismatch(): boolean {
    return (
      this.prefilledCode !== '' &&
      this.confirmInput.length >= CONFIRM_SYMBOLS &&
      this.confirmInput !== this.prefilledCode.slice(-CONFIRM_SYMBOLS)
    );
  }

  /** Leave confirm mode: the user types the code from their terminal in full. */
  enterFullCode(): void {
    if (this.busy || this.step !== 'enter') return;
    this.prefilledCode = '';
    this.confirmInput = '';
    this.input = '';
    this.error = '';
  }

  /** The code Continue would look up, or '' when it may not yet. */
  private get codeToSubmit(): string {
    if (this.prefilledCode) {
      return this.confirmInput === this.prefilledCode.slice(-CONFIRM_SYMBOLS) ? this.prefilledCode : '';
    }
    const code = normalizeUserCode(this.input);
    return isValidUserCode(code) ? code : '';
  }

  /** Broker-clock age/expiry of the request under review. */
  timing(): RequestTiming {
    if (this.info === null) return { ageSeconds: null, remainingSeconds: null };
    return requestTiming(this.info, this.receivedAt, this.now());
  }

  get expired(): boolean {
    return this.timing().remainingSeconds === 0;
  }

  /** A different-network request needs the explicit acknowledgement. */
  get networkCleared(): boolean {
    return this.info !== null && (this.info.sameNetwork || this.networkAcknowledged);
  }

  get canApprove(): boolean {
    return this.step === 'review' && !this.busy && this.networkCleared && !this.expired;
  }

  acknowledgeNetwork(value: boolean): void {
    this.networkAcknowledged = value === true;
  }

  setInput(raw: string): void {
    this.input = formatUserCodeInput(raw);
    this.error = '';
  }

  get canSubmit(): boolean {
    return this.step === 'enter' && !this.busy && this.codeToSubmit !== '';
  }

  /** The field holds more symbols than a code: a long paste is invalid as a
   * whole, never cut down to a code that happens to be its prefix. */
  get inputTooLong(): boolean {
    return isOverlongUserCode(normalizeUserCode(this.input));
  }

  /** The code as shown to the user, `XXXX-XXXX`. */
  get reviewedCodeDisplay(): string {
    return formatUserCode(this.reviewedCode);
  }

  /** Step 1 → 2: look the code up. Explicit user action only. */
  async submitCode(): Promise<void> {
    if (!this.canSubmit) return;
    const code = this.codeToSubmit;
    this.busy = true;
    this.error = '';
    try {
      const info = await this.api.lookup(formatUserCode(code));
      this.info = info;
      this.receivedAt = this.now();
      this.networkAcknowledged = false;
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
    this.networkAcknowledged = false;
  }

  /** Start over with an empty field. */
  reset(): void {
    if (this.busy) return;
    this.step = 'enter';
    this.input = '';
    this.prefilledCode = '';
    this.confirmInput = '';
    this.error = '';
    this.info = null;
    this.reviewedCode = '';
    this.networkAcknowledged = false;
    this.decision = null;
    this.resultError = '';
  }

  private async decide(approve: boolean): Promise<void> {
    if (this.step !== 'review' || this.busy || this.info === null || !isValidUserCode(this.reviewedCode)) return;
    if (approve && !this.canApprove) return;
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
        this.networkAcknowledged = false;
        // The user already typed or confirmed this code; it goes back in the
        // field in full, as their own entry.
        this.prefilledCode = '';
        this.confirmInput = '';
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
