<script setup lang="ts">
/**
 * /device — approve (or deny) a `pocketshell login` request from the CLI.
 *
 * Three steps: enter the code the terminal printed → review what is asking
 * (machine label, IP, user agent, time, and the account it would act as) →
 * result. Link codes stay hidden; the user types the whole code from their
 * own terminal before lookup. Lookup and approval each require an explicit
 * action. Different-network requests need acknowledgement. Server strings
 * never v-html — after the API client has stripped control/bidi characters.
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { claimsOf } from '../auth/google';
import { makeDeviceAuthService } from '../api/deviceAuth';
import { DeviceApprovalFlow } from '../device/approvalFlow';
import { codeFromQuery, formatUserCode } from '../device/userCode';
import { formatExpiry, formatRequestAge } from '../device/requestTiming';
import { useAuthStore } from '../stores/auth';
import { DEVICE_ROUTE, DEVICE_SESSIONS_ROUTE } from '../auth/returnTo';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const flow = reactive(new DeviceApprovalFlow(makeDeviceAuthService(auth), codeFromQuery(route.query.code)));
const reviewHeading = ref<HTMLElement | null>(null);
const resultHeading = ref<HTMLElement | null>(null);

/** Back through Google sign-in, returning here with the code in hand. */
function signInAgain(): void {
  const pending = codeFromQuery(flow.reviewedCode || flow.linkCode || flow.input);
  auth.signOut();
  void router.replace({
    name: 'login',
    query: { next: DEVICE_ROUTE, ...(pending ? { code: formatUserCode(pending) } : {}) },
  });
}

// An hourly Google ID token may already be stale in sessionStorage; catch
// that before the user types, rather than after they click.
function tokenExpired(): boolean {
  try {
    return claimsOf(auth.idToken).exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}
if (tokenExpired()) signInAgain();

watch(
  () => flow.needsSignIn,
  (needed) => {
    if (needed) signInAgain();
  },
);

// Move focus to each step's heading — never onto Approve — so a stray Enter
// or Space cannot decide anything.
watch(
  () => flow.step,
  async (step) => {
    await nextTick();
    if (step === 'review') reviewHeading.value?.focus();
    if (step === 'result') resultHeading.value?.focus();
  },
);

// A once-a-second tick drives the age/countdown and shuts Approve when the
// request expires (the flow's clock reads are not reactive on their own).
const tick = ref(0);
const ticker = setInterval(() => {
  tick.value += 1;
}, 1000);
onBeforeUnmount(() => clearInterval(ticker));
const timing = computed(() => {
  void tick.value;
  return flow.timing();
});
const approveEnabled = computed(() => {
  void tick.value;
  return flow.canApprove;
});

function onInput(event: Event): void {
  const el = event.target as HTMLInputElement;
  flow.setInput(el.value);
  // Normalization may leave the model unchanged (a rejected character), in
  // which case Vue would not repaint the field — write it back directly.
  el.value = flow.input;
}

function formatTime(ms: number | null): string {
  if (ms === null) return 'unknown';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString();
}
</script>

<template>
  <main class="page auth-page">
    <section class="auth-card device-card" aria-labelledby="device-heading">
      <div class="auth-mark" aria-hidden="true">&gt;_</div>

      <!-- Step 1: enter the code -->
      <template v-if="flow.step === 'enter'">
        <h1 id="device-heading">Approve a CLI sign-in</h1>
        <p class="auth-lede">
          Enter the code that <code>pocketshell login</code> printed in your
          terminal.
        </p>
        <form class="device-form" novalidate @submit.prevent="flow.submitCode()">
          <label for="device-code" class="device-label">Code</label>
          <input
            id="device-code"
            class="device-code-input"
            type="text"
            :value="flow.input"
            placeholder="XXXX-XXXX"
            autocomplete="off"
            autocapitalize="characters"
            autocorrect="off"
            spellcheck="false"
            :disabled="flow.busy"
            :aria-invalid="flow.error !== '' || flow.inputTooLong || flow.linkMismatch"
            aria-describedby="device-code-error"
            @input="onInput"
          />
          <button type="submit" class="primary" :disabled="!flow.canSubmit">
            {{ flow.busy ? 'Checking…' : 'Continue' }}
          </button>
        </form>
        <div v-if="flow.error" id="device-code-error" class="auth-notice" role="alert">
          <svg class="device-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 3v1" />
          </svg>
          <p>{{ flow.error }}</p>
        </div>
        <div v-else-if="flow.linkMismatch" id="device-code-error" class="auth-notice" role="alert">
          <svg class="device-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 3v1" />
          </svg>
          <p>This link was made for a different code. Only approve codes your own terminal printed.</p>
        </div>
        <div v-else-if="flow.inputTooLong" id="device-code-error" class="auth-notice" role="alert">
          <svg class="device-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 3v1" />
          </svg>
          <p>That is longer than a code. Check it against your terminal and type it again.</p>
        </div>
      </template>

      <!-- Step 2: review and decide -->
      <template v-else-if="flow.step === 'review' && flow.info">
        <h1 id="device-heading" ref="reviewHeading" tabindex="-1">Is this you signing in?</h1>
        <p class="auth-lede">A command-line client is asking to sign in to your account.</p>
        <div v-if="!flow.info.sameNetwork" class="device-danger" role="alert">
          <div class="device-callout-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 3 2 21h20L12 3Z" />
              <path d="M12 9v5m0 3v1" />
            </svg>
            <strong class="device-danger-title">Different network detected</strong>
          </div>
          <p>
            This request came from a different network than you. If you did
            not just run <code>pocketshell login</code> on another machine
            yourself, click Deny.
          </p>
          <label class="device-ack">
            <input
              type="checkbox"
              :checked="flow.networkAcknowledged"
              :disabled="flow.busy"
              @change="flow.acknowledgeNetwork(($event.target as HTMLInputElement).checked)"
            />
            <span>I ran <code>pocketshell login</code> on that other machine myself</span>
          </label>
        </div>
        <dl class="device-facts">
          <dt>Code</dt>
          <dd class="device-mono">{{ flow.reviewedCodeDisplay }}</dd>
          <dt>Machine name (reported by the machine, not verified)</dt>
          <dd class="device-mono">{{ flow.info.label }}</dd>
          <dt>Request IP</dt>
          <dd class="device-mono">{{ flow.info.requestIp || 'unknown' }}</dd>
          <dt>Client</dt>
          <dd>{{ flow.info.userAgent || 'unknown' }}</dd>
          <dt>Requested</dt>
          <dd>
            <span class="device-age">{{ formatRequestAge(timing.ageSeconds) }}</span>
            ({{ formatTime(flow.info.createdAt) }})
          </dd>
          <dt>Expires</dt>
          <dd :class="{ 'device-expired': timing.remainingSeconds === 0 }">
            {{ formatExpiry(timing.remainingSeconds) }}
          </dd>
          <dt>Approving as</dt>
          <dd>{{ auth.email }}</dd>
        </dl>
        <div class="device-warning" role="note">
          <div class="device-callout-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
              <path d="M12 8v5m0 3v1" />
            </svg>
            <strong class="device-warning-title">What approving grants</strong>
          </div>
          <p>
            Only approve if you just ran <code>pocketshell login</code> yourself
            and the code matches. Approving lets that machine act as you on the
            PocketShell gateway — enroll hosts, connect to your hosts, and
            remove or revoke your devices — for up to 30 days (14 days if
            unused).
          </p>
        </div>
        <div v-if="flow.resultError" class="auth-notice" role="alert">
          <svg class="device-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 3v1" />
          </svg>
          <p>{{ flow.resultError }}</p>
        </div>
        <div class="device-actions">
          <button type="button" :disabled="flow.busy" @click="flow.deny()">Deny</button>
          <button type="button" class="primary" :disabled="!approveEnabled" @click="flow.approve()">
            Approve
          </button>
        </div>
        <button type="button" class="device-link" :disabled="flow.busy" @click="flow.back()">
          Enter a different code
        </button>
      </template>

      <!-- Step 3: result -->
      <template v-else-if="flow.step === 'result'">
        <template v-if="flow.decision === 'approved'">
          <h1 id="device-heading" ref="resultHeading" tabindex="-1">Sign-in approved</h1>
          <p class="auth-lede">
            Go back to your terminal — <code>pocketshell login</code> finishes
            on its own. You can close this tab.
          </p>
        </template>
        <template v-else-if="flow.decision === 'denied'">
          <h1 id="device-heading" ref="resultHeading" tabindex="-1">Sign-in denied</h1>
          <p class="auth-lede">
            That machine was not given access. If you did not start this
            request, someone may have your code — nothing further is needed.
          </p>
        </template>
        <template v-else>
          <h1 id="device-heading" ref="resultHeading" tabindex="-1">Could not complete</h1>
          <div class="auth-notice" role="alert">
          <svg class="device-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 3v1" />
          </svg>
            <p>{{ flow.resultError }}</p>
          </div>
        </template>
        <div class="device-actions">
          <button type="button" @click="flow.reset()">Enter another code</button>
        </div>
        <p class="device-hint">
          <RouterLink :to="{ name: DEVICE_SESSIONS_ROUTE }">Manage CLI sessions</RouterLink>
          — see and revoke every machine signed in with <code>pocketshell login</code>.
        </p>
      </template>

      <p class="device-account">
        Signed in as <strong>{{ auth.email }}</strong>
        <button type="button" class="device-link" :disabled="flow.busy" @click="signInAgain">
          Use a different account
        </button>
      </p>
    </section>
  </main>
</template>
