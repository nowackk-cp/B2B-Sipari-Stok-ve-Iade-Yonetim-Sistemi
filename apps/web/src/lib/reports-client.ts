import type {
  InventoryReportView,
  ReturnsReportView,
  SalesReportGroupBy,
  SalesReportView,
} from '@b2b/contracts';
import { ApiError, apiFetch } from './api-fetch';
import { getAccessToken, refresh } from './auth-client';

/**
 * Browser client for the read-only reports surface (`/api/v1/reports/*`).
 *
 * Every call goes through {@link apiFetch} (CLAUDE.md Mutlak Kural #1 — all
 * business traffic via `/api/v1`) which always sends the HttpOnly cookies
 * (`credentials: 'include'`) and the in-memory bearer token. The short-lived
 * access token is transparently refreshed once on a 401 (same pattern as the
 * orders/invoices/returns clients).
 *
 * Reports are READ-ONLY aggregates. Every figure is scoped to the caller's real
 * company and intersected with their warehouse scope SERVER-side (resolved from
 * PostgreSQL, never a JWT claim) — the frontend never sends `companyId` or any
 * tenant claim, and only forwards the query params the backend DTOs whitelist
 * (the strict pipe rejects unknown keys with a 400).
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

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/** Whitelisted sales-report inputs (mirror {@link SalesReportQuery} on the API). */
export interface SalesReportParams {
  /** Inclusive UTC range start, `YYYY-MM-DD` (REQUIRED by the backend). */
  dateFrom: string;
  /** Inclusive UTC range end, `YYYY-MM-DD` (REQUIRED by the backend). */
  dateTo: string;
  /** Optional warehouse public id — intersected with scope, can never widen it. */
  warehouseId?: string;
  /** Bucket granularity (defaults to `day` server-side). */
  groupBy?: SalesReportGroupBy;
}

/** Whitelisted inventory-report inputs (mirror {@link InventoryReportQuery}). */
export interface InventoryReportParams {
  limit?: number;
  cursor?: string;
  warehouseId?: string;
  /** Keep only balances at/below the product's critical threshold. */
  lowStockOnly?: boolean;
  /** Case-insensitive match on product name or SKU. */
  search?: string;
}

/** Whitelisted returns-report inputs (mirror {@link ReturnsReportQuery}). */
export interface ReturnsReportParams {
  /** Inclusive UTC range start, `YYYY-MM-DD` (REQUIRED by the backend). */
  dateFrom: string;
  /** Inclusive UTC range end, `YYYY-MM-DD` (REQUIRED by the backend). */
  dateTo: string;
  warehouseId?: string;
  /** Whitelisted return-status filter (DRAFT/APPROVED/RECEIVED/REJECTED/COMPLETED). */
  status?: string;
}

/** Gross-sales report over ISSUED invoices (period × currency buckets). */
export function fetchSalesReport(params: SalesReportParams): Promise<SalesReportView> {
  const qs = buildQuery({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    warehouseId: params.warehouseId,
    groupBy: params.groupBy,
  });
  return withFreshToken((accessToken) =>
    apiFetch<SalesReportView>(`/reports/sales${qs}`, { accessToken }),
  );
}

/** Inventory report (balances + available + low-stock flag), cursor-paginated. */
export function fetchInventoryReport(
  params: InventoryReportParams = {},
): Promise<InventoryReportView> {
  const qs = buildQuery({
    limit: params.limit,
    cursor: params.cursor,
    warehouseId: params.warehouseId,
    // Only forward the flag when filtering on — keeps the query minimal.
    lowStockOnly: params.lowStockOnly ? true : undefined,
    search: params.search,
  });
  return withFreshToken((accessToken) =>
    apiFetch<InventoryReportView>(`/reports/inventory${qs}`, { accessToken }),
  );
}

/** Returns report (counts, returned quantity, credit-note totals). */
export function fetchReturnsReport(params: ReturnsReportParams): Promise<ReturnsReportView> {
  const qs = buildQuery({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    warehouseId: params.warehouseId,
    status: params.status,
  });
  return withFreshToken((accessToken) =>
    apiFetch<ReturnsReportView>(`/reports/returns${qs}`, { accessToken }),
  );
}
