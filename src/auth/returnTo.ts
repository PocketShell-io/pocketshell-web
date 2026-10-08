/**
 * Where sign-in sends the user back to. Only the CLI-approval page and the
 * CLI-sessions page ask to come back (the rest of the app lands on the home picker, as before), and
 * the return target is a fixed route NAME chosen from a closed set, never a
 * URL from the query — so `?next=` cannot become an open redirect.
 */
import type { LocationQuery, LocationQueryRaw, RouteLocationNormalized, RouteLocationRaw } from 'vue-router';
import { codeFromQuery, formatUserCode } from '../device/userCode';

export const DEVICE_ROUTE = 'device';
export const DEVICE_SESSIONS_ROUTE = 'device-sessions';

function deviceQuery(code: unknown): LocationQueryRaw {
  const normalized = codeFromQuery(code);
  return normalized ? { code: formatUserCode(normalized) } : {};
}

/** The query /login gets when the guard bounces a signed-out visit. */
export function loginQueryFor(to: Pick<RouteLocationNormalized, 'name' | 'query'>): LocationQueryRaw {
  if (to.name === DEVICE_ROUTE) return { next: DEVICE_ROUTE, ...deviceQuery(to.query.code) };
  if (to.name === DEVICE_SESSIONS_ROUTE) return { next: DEVICE_SESSIONS_ROUTE };
  return to.query;
}

/** Where a fresh (or already present) session goes from /login. */
export function afterLoginTarget(query: LocationQuery): RouteLocationRaw {
  if (query.next === DEVICE_ROUTE) return { name: DEVICE_ROUTE, query: deviceQuery(query.code) };
  if (query.next === DEVICE_SESSIONS_ROUTE) return { name: DEVICE_SESSIONS_ROUTE };
  return { name: 'hosts' };
}
