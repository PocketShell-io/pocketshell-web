<script setup lang="ts">
/**
 * /device — approve (or deny) a `pocketshell login` request from the CLI.
 *
 * Three steps: enter the code the terminal printed → review what is asking
 * (machine label, IP, user agent, time, and the account it would act as) →
 * result. A `?code=` link only prefills the field; looking it up, and above
 * all approving, take an explicit click each (device/approvalFlow.ts holds
 * those rules). Every server string renders through text interpolation —
 * never v-html — after the API client has stripped control/bidi characters.
 */
import { nextTick, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { claimsOf } from '../auth/google';
import { makeDeviceAuthService } from '../api/deviceAuth';
import { DeviceApprovalFlow } from '../device/approvalFlow';
import { codeFromQuery, formatUserCode } from '../device/userCode';
import { useAuthStore } from '../stores/auth';
import { DEVICE_ROUTE } from '../auth/returnTo';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const flow = reactive(new DeviceApprovalFlow(makeDeviceAuthService(auth), codeFromQuery(route.query.code)));
const reviewHeading = ref<HTMLElement | null>(null);
const resultHeading = ref<HTMLElement | null>(null);

/** Back through Google sign-in, returning here with the code in hand. */
function signInAgain(): void {
  const pending = codeFromQuery(flow.reviewedCode || flow.input);
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
            :aria-invalid="flow.error !== '' || flow.inputTooLong"
            aria-describedby="device-code-error"
            @input="onInput"
          />
          <button type="submit" class="primary" :disabled="!flow.canSubmit">
            {{ flow.busy ? 'Checking…' : 'Continue' }}
          </button>
        </form>
        <div v-if="flow.error" id="device-code-error" class="auth-notice" role="alert">
          <p>{{ flow.error }}</p>
        </div>
        <div v-else-if="flow.inputTooLong" id="device-code-error" class="auth-notice" role="alert">
          <p>That is longer than a code. Check it against your terminal and type it again.</p>
        </div>
      </template>

      <!-- Step 2: review and decide -->
      <template v-else-if="flow.step === 'review' && flow.info">
        <h1 id="device-heading" ref="reviewHeading" tabindex="-1">Is this you signing in?</h1>
        <p class="auth-lede">A command-line client is asking to sign in to your account.</p>
        <dl class="device-facts">
          <dt>Code</dt>
          <dd class="device-mono">{{ flow.reviewedCodeDisplay }}</dd>
          <dt>Machine</dt>
          <dd class="device-mono">{{ flow.info.label }}</dd>
          <dt>Request IP</dt>
          <dd class="device-mono">{{ flow.info.requestIp || 'unknown' }}</dd>
          <dt>Client</dt>
          <dd>{{ flow.info.userAgent || 'unknown' }}</dd>
          <dt>Requested</dt>
          <dd>{{ formatTime(flow.info.createdAt) }}</dd>
          <dt>Approving as</dt>
          <dd>{{ auth.email }}</dd>
        </dl>
        <div class="device-warning" role="note">
          <p>
            Only approve if you just ran <code>pocketshell login</code> yourself
            and the code matches. Approving gives that machine access to your
            PocketShell gateway account (enroll hosts, connect to your hosts)
            for 30 days.
          </p>
        </div>
        <div v-if="flow.resultError" class="auth-notice" role="alert">
          <p>{{ flow.resultError }}</p>
        </div>
        <div class="device-actions">
          <button type="button" :disabled="flow.busy" @click="flow.deny()">Deny</button>
          <button type="button" class="primary" :disabled="flow.busy" @click="flow.approve()">
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
            <p>{{ flow.resultError }}</p>
          </div>
        </template>
        <div class="device-actions">
          <button type="button" @click="flow.reset()">Enter another code</button>
        </div>
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
