/**
 * The web's VaultServerVerifier: the phase-2 vault endpoints on the sync API
 * (W2; contract in pocketshell-sync docs/KEY-VAULT.md) — a server-side
 * verifier of AUTH (= HKDF(MK, "pocketshell-vault/v1/auth")) with failure
 * budgets, the gated header's KDF params, and an atomic reset. Phase 2 may
 * not be deployed: 404, 503 or a transport failure answers `unavailable`,
 * and the unlock relies on the client-side check value alone.
 */
import { config } from '../config';
import { parseKdfParams, type VaultServerStatus, type VaultServerVerifier } from '@pocketshell/core';
import { b64url } from './b64';

export function makeServerVerifier(idToken: () => string, fetchFn: typeof fetch = (...a) => fetch(...a)): VaultServerVerifier {
  const base = () => config.syncApiUrl.replace(/\/+$/, '');
  async function call(method: string, path: string, body?: unknown): Promise<Response | null> {
    try {
      return await fetchFn(`${base()}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${idToken()}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      return null;
    }
  }
  const json = async (res: Response): Promise<Record<string, unknown>> =>
    ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  /** The server's retryAfter is seconds. */
  const ms = (b: Record<string, unknown>) => num(b.retryAfter) * 1000;

  return {
    scoped() {
      const token = idToken();
      return makeServerVerifier(() => token, fetchFn);
    },
    async initialize({data,auth,epoch}) {
      const res=await call('POST','/vault/initialize',{data,auth:b64url(auth),epoch});
      if(res===null)return {kind:'error',message:'Vault setup is temporarily unavailable. Try again.'};
      const b=await json(res);
      if(res.status===201 && b.ok===true && b.version===1 && b.epoch===epoch)return {kind:'ok',version:1};
      if(res.status===409)return {kind:'conflict',currentVersion:0};
      return {kind:'error',message:'Vault creation was not confirmed. Retry with the same passphrase.'};
    },
    async status() {
      const res = await call('GET', '/vault/status');
      if (res === null || !res.ok) return { kind: 'unavailable' };
      const b = await json(res);
      if(!Number.isSafeInteger(b.epoch) || num(b.epoch)<1 || typeof b.hasVerifier!=='boolean')return {kind:'unavailable'};
      const out: VaultServerStatus = { kind: 'ok', epoch: num(b.epoch), hasVerifier: b.hasVerifier === true, retryAfterMs: ms(b) };
      const kdf = b.kdf === undefined ? null : parseKdfParams(b.kdf);
      if(b.kdf!==undefined && kdf===null)return {kind:'unavailable'};
      if (kdf !== null) out.kdf = kdf;
      return out;
    },
    async verify(auth) {
      const res = await call('POST', '/vault/verify', { auth: b64url(auth) });
      if (res === null) return { kind: 'unavailable' };
      const b = await json(res);
      if (res.ok && b.ok === true) return { kind: 'ok' };
      if (res.status === 401 && b.error === 'wrong_passphrase') return { kind: 'wrong', retryAfterMs: ms(b) };
      if (res.status === 429) return { kind: 'locked', retryAfterMs: ms(b) };
      if (res.status === 404 && b.error === 'no_verifier') return { kind: 'noVerifier' };
      // Route absent, verifier_stale, 400, 503: the check value decides.
      return { kind: 'unavailable' };
    },
    async setVerifier({ auth, epoch, currentAuth }) {
      const body: Record<string, unknown> = { auth: b64url(auth), epoch };
      if (currentAuth !== undefined) body.currentAuth = b64url(currentAuth);
      const res = await call('POST', '/vault/verifier', body);
      if (res === null) return { kind: 'unavailable' };
      const b = await json(res);
      if (res.ok && b.ok === true) return { kind: 'ok', epoch: num(b.epoch) };
      if (res.status === 409 && b.error === 'epoch_mismatch') return { kind: 'epochMismatch', epoch: num(b.epoch) };
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        return typeof b.error === 'string' ? { kind: 'refused' } : { kind: 'unavailable' };
      }
      return { kind: 'unavailable' };
    },
    async reset() {
      const res = await call('POST', '/vault/reset', { confirm: 'RESET' });
      if (res === null) return { kind: 'unavailable' };
      const b = await json(res);
      if (res.ok && b.ok === true) return { kind: 'ok', epoch: num(b.epoch) };
      if (res.status === 401 && b.error === 'fresh_auth_required') return { kind: 'freshAuthRequired' };
      return { kind: 'unavailable' };
    },
  };
}
