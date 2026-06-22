import type { CustomerListView, CustomerView } from '@b2b/contracts';
import { ApiError, apiFetch } from './api-fetch';
import { getAccessToken, refresh } from './auth-client';

/**
 * Browser client for customer master-data (`/api/v1/customers`).
 *
 * Every call goes through {@link apiFetch} (CLAUDE.md Mutlak Kural #1 — all
 * business traffic via `/api/v1`) which always sends the HttpOnly cookies
 * (`credentials: 'include'`) and the in-memory bearer token. The short-lived
 * access token is transparently refreshed once on a 401 (same pattern as the
 * products/warehouses/dashboard clients). `companyId` is NEVER sent — the owning
 * tenant is the server-resolved principal (rule 12).
 */

/**
 * Flatten an error into user-facing messages. RFC 7807 field errors (`errors[]`)
 * are surfaced verbatim (per-field validation); otherwise the human
 * `detail`/`title` is used, falling back to a generic line.
 */
export function problemMessages(err: unknown): string[] {
  if (err instanceof ApiError) {
    if (err.problem?.errors?.length) return err.problem.errors.map((e) => e.message);
    if (err.problem?.detail) return [err.problem.detail];
    if (err.message) return [err.message];
  }
  return ['Something went wrong. Please try again.'];
}

/** Run `fn` with the current token; on a 401 refresh once from the cookie and retry. */
async function withFreshToken<T>(fn: (token: string | null) => Promise<T>): Promise<T> {
  try {
    return await fn(getAccessToken());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await refresh();
      return fn(getAccessToken());
    }
    throw err;
  }
}

/** Whitelisted list/search/filter inputs (mirrors the backend list query). */
export interface CustomerListQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  /** "COMPANY" / "INDIVIDUAL" — omit for "all". */
  type?: string;
}

/**
 * Create/update payload. Deliberately has NO `companyId` field so a forged tenant
 * can never be sent (the strict backend pipe also rejects unknown keys). For an
 * update every field is optional.
 */
export interface CustomerWriteInput {
  code?: string;
  name?: string;
  type?: string;
  taxNumber?: string | null;
  email?: string | null;
  phone?: string | null;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** List/search the caller's company customers (cursor-paginated). */
export function listCustomers(query: CustomerListQuery = {}): Promise<CustomerListView> {
  const qs = buildQuery({
    limit: query.limit,
    cursor: query.cursor,
    search: query.search,
    type: query.type,
  });
  return withFreshToken((accessToken) =>
    apiFetch<CustomerListView>(`/customers${qs}`, { accessToken }),
  );
}

/** Create a customer in the caller's company. */
export function createCustomer(input: CustomerWriteInput): Promise<CustomerView> {
  return withFreshToken((accessToken) =>
    apiFetch<CustomerView>('/customers', { method: 'POST', json: input, accessToken }),
  );
}

/** Update a customer by its public id. */
export function updateCustomer(id: string, input: CustomerWriteInput): Promise<CustomerView> {
  return withFreshToken((accessToken) =>
    apiFetch<CustomerView>(`/customers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: input,
      accessToken,
    }),
  );
}

/** Soft-delete a customer by its public id (backend keeps the row + audit). */
export function deleteCustomer(id: string): Promise<void> {
  return withFreshToken((accessToken) =>
    apiFetch<void>(`/customers/${encodeURIComponent(id)}`, { method: 'DELETE', accessToken }),
  );
}
