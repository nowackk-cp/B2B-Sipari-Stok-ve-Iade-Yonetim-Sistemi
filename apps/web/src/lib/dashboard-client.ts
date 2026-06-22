import type { DashboardSummaryView } from '@b2b/contracts';
import { ApiError, apiFetch } from './api-fetch';
import { getAccessToken, refresh } from './auth-client';

/**
 * Fetch the management dashboard summary (`GET /dashboard/summary`).
 *
 * The in-memory access token is short-lived; if the API rejects it as expired
 * (401) we transparently re-derive a fresh token from the HttpOnly refresh
 * cookie once and retry. A second 401 propagates so the caller can bounce the
 * user to `/login`.
 */
export async function fetchDashboardSummary(): Promise<DashboardSummaryView> {
  try {
    return await apiFetch<DashboardSummaryView>('/dashboard/summary', {
      accessToken: getAccessToken(),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await refresh();
      return apiFetch<DashboardSummaryView>('/dashboard/summary', {
        accessToken: getAccessToken(),
      });
    }
    throw err;
  }
}
