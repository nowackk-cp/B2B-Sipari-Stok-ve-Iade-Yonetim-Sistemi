import type { AuthSessionView, UserProfileView } from '@b2b/contracts';

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

function apiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_API_BASE_URL is not configured');
  return url;
}

async function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(`${apiBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include', // send/receive the HttpOnly refresh cookie
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function getAccessToken(): string | null {
  return accessToken;
}

export async function login(email: string, password: string): Promise<UserProfileView> {
  const res = await postJson('/auth/login', { email, password });
  if (!res.ok) throw new Error('invalid_credentials');
  const data = (await res.json()) as AuthSessionView;
  accessToken = data.accessToken;
  return data.user;
}

/** Re-derive an access token from the refresh cookie (e.g. after a reload). */
export async function refresh(): Promise<AuthSessionView> {
  const res = await postJson('/auth/refresh');
  if (!res.ok) throw new Error('no_session');
  const data = (await res.json()) as AuthSessionView;
  accessToken = data.accessToken;
  return data;
}

export async function me(): Promise<UserProfileView> {
  if (!accessToken) throw new Error('no_session');
  const res = await fetch(`${apiBaseUrl()}/auth/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    credentials: 'include',
  });
  if (!res.ok) throw new Error('no_session');
  return (await res.json()) as UserProfileView;
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
    await postJson('/auth/logout');
  } finally {
    accessToken = null;
  }
}
