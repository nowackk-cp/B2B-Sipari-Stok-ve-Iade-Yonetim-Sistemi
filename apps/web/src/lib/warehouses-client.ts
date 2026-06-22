import type { WarehouseListView, WarehouseView } from '@b2b/contracts';
import { ApiError, apiFetch } from './api-fetch';
import { getAccessToken, refresh } from './auth-client';

/**
 * Browser client for warehouse master-data (`/api/v1/warehouses`).
 *
 * Every call goes through {@link apiFetch} (CLAUDE.md Mutlak Kural #1 — all
 * business traffic via `/api/v1`) which always sends the HttpOnly cookies
 * (`credentials: 'include'`) and the in-memory bearer token. The short-lived
 * access token is transparently refreshed once on a 401 (same pattern as the
 * products/dashboard clients). `companyId` is NEVER sent — the owning tenant is
 * the server-resolved principal (rule 12).
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
export interface WarehouseListQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  /** "true" / "false" — omit for "all". */
  isActive?: string;
}

/**
 * Create/update payload. Deliberately has NO `companyId` field so a forged tenant
 * can never be sent (the strict backend pipe also rejects unknown keys). For an
 * update every field is optional.
 */
export interface WarehouseWriteInput {
  code?: string;
  name?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  isActive?: boolean;
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

/** List/search the caller's in-scope warehouses (cursor-paginated). */
export function listWarehouses(query: WarehouseListQuery = {}): Promise<WarehouseListView> {
  const qs = buildQuery({
    limit: query.limit,
    cursor: query.cursor,
    search: query.search,
    isActive: query.isActive,
  });
  return withFreshToken((accessToken) =>
    apiFetch<WarehouseListView>(`/warehouses${qs}`, { accessToken }),
  );
}

/** Create a warehouse in the caller's company. */
export function createWarehouse(input: WarehouseWriteInput): Promise<WarehouseView> {
  return withFreshToken((accessToken) =>
    apiFetch<WarehouseView>('/warehouses', { method: 'POST', json: input, accessToken }),
  );
}

/** Update a warehouse by its public id. */
export function updateWarehouse(id: string, input: WarehouseWriteInput): Promise<WarehouseView> {
  return withFreshToken((accessToken) =>
    apiFetch<WarehouseView>(`/warehouses/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: input,
      accessToken,
    }),
  );
}

/** Soft-delete a warehouse by its public id (backend keeps the row + audit). */
export function deleteWarehouse(id: string): Promise<void> {
  return withFreshToken((accessToken) =>
    apiFetch<void>(`/warehouses/${encodeURIComponent(id)}`, { method: 'DELETE', accessToken }),
  );
}
