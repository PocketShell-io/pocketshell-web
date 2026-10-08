<script setup lang="ts">
/**
 * /device/sessions — the account's `pocketshell login` sessions: what each
 * machine called itself (unverified), where it signed in from, when it was
 * created, last used and expires, with Revoke per row and Revoke all (which
 * asks first). Every server string arrives sanitized from the API client and
 * renders through text interpolation only.
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { claimsOf } from '../auth/google';
import { DeviceAuthError, deviceAuthErrorMessage, makeDeviceAuthService, type CliSession } from '../api/deviceAuth';
import { NotSignedInError } from '../api/sync';
import { DEVICE_ROUTE, DEVICE_SESSIONS_ROUTE } from '../auth/returnTo';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const api = makeDeviceAuthService(auth);

const sessions = ref<CliSession[]>([]);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const confirmingAll = ref(false);

function signInAgain(): void {
  auth.signOut();
  void router.replace({ name: 'login', query: { next: DEVICE_SESSIONS_ROUTE } });
}

function tokenExpired(): boolean {
  try {
    return claimsOf(auth.idToken).exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

/** Runs one broker call with the page's busy/error handling. */
async function run<T>(call: () => Promise<T>): Promise<T | undefined> {
  busy.value = true;
  error.value = '';
  try {
    return await call();
  } catch (e) {
    if (e instanceof NotSignedInError) {
      signInAgain();
    } else {
      error.value = e instanceof DeviceAuthError ? e.message : deviceAuthErrorMessage('unexpected');
    }
    return undefined;
  } finally {
    busy.value = false;
  }
}

async function load(): Promise<void> {
  const rows = await run(() => api.listSessions());
  if (rows !== undefined) {
    sessions.value = rows;
    loaded.value = true;
  }
}

function revokedNotice(n: number): string {
  return n === 0 ? 'Nothing to revoke — already gone.' : `Revoked ${n} session${n === 1 ? '' : 's'}.`;
}

async function revoke(row: CliSession): Promise<void> {
  if (busy.value || row.tokenId === null) return;
  const tokenId = row.tokenId;
  notice.value = '';
  const n = await run(() => api.revokeSession(tokenId));
  if (n === undefined) return;
  notice.value = revokedNotice(n);
  await load();
}

function askRevokeAll(): void {
  if (busy.value) return;
  notice.value = '';
  confirmingAll.value = true;
}

async function revokeAll(): Promise<void> {
  if (busy.value || !confirmingAll.value) return;
  const n = await run(() => api.revokeAllSessions());
  confirmingAll.value = false;
  if (n === undefined) return;
  notice.value = revokedNotice(n);
  await load();
}

function formatTime(ms: number | null, missing = 'unknown'): string {
  if (ms === null) return missing;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? missing : d.toLocaleString();
}

onMounted(() => {
  if (tokenExpired()) signInAgain();
  else void load();
});
</script>

<template>
  <main class="page auth-page">
    <section class="auth-card device-card sessions-card" aria-labelledby="sessions-heading">
      <h1 id="sessions-heading">CLI sessions</h1>
      <p class="auth-lede">
        Machines signed in with <code>pocketshell login</code>. Each can enroll
        hosts, connect to your hosts and remove or revoke your devices until
        it expires (30 days, or 14 days unused). Revoke any you do not
        recognize.
      </p>

      <div v-if="error" class="auth-notice" role="alert">
        <p>{{ error }}</p>
      </div>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>

      <p v-if="!loaded && !error" class="device-hint">Loading…</p>
      <p v-else-if="loaded && sessions.length === 0" class="device-hint">No CLI sessions.</p>

      <ul v-if="sessions.length > 0" class="sessions-list" aria-label="CLI sessions">
        <li v-for="(row, i) in sessions" :key="row.tokenId ?? `row-${i}`" class="sessions-row">
          <div class="sessions-text">
            <div class="device-mono sessions-label">{{ row.label }}</div>
            <dl class="sessions-meta">
              <dt>Request IP</dt>
              <dd class="device-mono">{{ row.requestIp || 'unknown' }}</dd>
              <dt>Created</dt>
              <dd>{{ formatTime(row.createdAt) }}</dd>
              <dt>Last used</dt>
              <dd>{{ formatTime(row.lastUsedAt, 'never') }}</dd>
              <dt>Expires</dt>
              <dd>{{ formatTime(row.expiresAt) }}</dd>
            </dl>
          </div>
          <button
            v-if="row.tokenId !== null"
            type="button"
            :disabled="busy"
            :aria-label="`Revoke ${row.label}`"
            @click="revoke(row)"
          >
            Revoke
          </button>
        </li>
      </ul>

      <template v-if="sessions.length > 0">
        <div v-if="confirmingAll" class="device-danger" role="alertdialog" aria-labelledby="revoke-all-q">
          <p id="revoke-all-q">
            Revoke all {{ sessions.length }} CLI session{{ sessions.length === 1 ? '' : 's' }}? Every
            machine signed in with <code>pocketshell login</code> will have to sign in again.
          </p>
          <div class="device-actions">
            <button type="button" :disabled="busy" @click="confirmingAll = false">Cancel</button>
            <button type="button" class="danger" :disabled="busy" @click="revokeAll">Revoke all sessions</button>
          </div>
        </div>
        <div v-else class="device-actions">
          <button type="button" :disabled="busy" @click="askRevokeAll">Revoke all</button>
        </div>
      </template>

      <p class="device-account">
        <RouterLink :to="{ name: DEVICE_ROUTE }">Approve a CLI sign-in</RouterLink>
        <RouterLink :to="{ name: 'app-hosts' }">Your hosts</RouterLink>
      </p>
    </section>
  </main>
</template>
