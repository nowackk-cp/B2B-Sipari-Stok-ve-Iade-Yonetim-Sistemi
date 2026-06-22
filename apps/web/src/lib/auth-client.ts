import type { AuthSessionView, UserProfileView } from '@b2b/contracts';
import { apiFetch } from './api-fetch';

/**
 * Browser auth client.
 *
 * Security model (SECURITY_MODEL §1): the refresh token lives ONLY in the
 * HttpOnly cookie set by the API and is never read or stored by JS. The access
 * token is kept in memory (module scope) — never in localStorage/sessionStorage —
 * so it cannot be exfiltrated by XSS and is naturally dropped on reload (a page
 * refresh re-derives it from the refresh cookie via `refresh()`).
 */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

/** Test/SSR seam: set or clear the in-memory access token. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export async function login(email: string, password: string): Promise<UserProfileView> {
  const data = await apiFetch<AuthSessionView>('/auth/login', {
    method: 'POST',
    json: { email, password },
  });
  accessToken = data.accessToken;
  return data.user;
}

/** Re-derive an access token from the refresh cookie (e.g. after a reload). */
export async function refresh(): Promise<AuthSessionView> {
  const data = await apiFetch<AuthSessionView>('/auth/refresh', { method: 'POST' });
  accessToken = data.accessToken;
  return data;
}

export async function me(): Promise<UserProfileView> {
  if (!accessToken) throw new Error('no_session');
  return apiFetch<UserProfileView>('/auth/me', { accessToken });
}

/** Ensure a usable session, refreshing from the cookie when the token is gone. */
export async function ensureSession(): Promise<UserProfileView> {
  if (!accessToken) {
    await refresh();
  }
  return me();
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } finally {
    accessToken = null;
  }
}
