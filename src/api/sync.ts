/**
 * Sync API client (aws-infra sandbox/pocketshell-sync contract). Every call
 * sends `Authorization: Bearer <Google ID token>`; the API Gateway JWT
 * authorizer enforces signature, audience and expiry independently.
 */
import { config } from '../config';
import type { PulledSlot } from '../types';

export class SyncApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`sync API ${status}: ${message}`);
  }
}

async function request<T>(method: string, path: string, idToken: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.syncApiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = await res.text();
    } catch {
      /* keep statusText */
    }
    throw new SyncApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export interface SlotMeta {
  slot: string;
  version: number;
  size: number;
  updatedAt: string;
}

export const syncApi = {
  me: (idToken: string) => request<{ sub: string; email: string }>('GET', '/me', idToken),
  listSlots: (idToken: string) => request<SlotMeta[]>('GET', '/settings', idToken),
  getSlot: (idToken: string, slot: string) =>
    request<PulledSlot | null>('GET', `/settings/${slot}`, idToken),
};
