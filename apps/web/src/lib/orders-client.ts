import type { OrderListView, OrderView } from '@b2b/contracts';
import { ApiError, apiFetch } from './api-fetch';
import { getAccessToken, refresh } from './auth-client';

/**
 * Browser client for orders (`/api/v1/orders`).
 *
 * Every call goes through {@link apiFetch} (CLAUDE.md Mutlak Kural #1 — all
 * business traffic via `/api/v1`) which always sends the HttpOnly cookies
 * (`credentials: 'include'`) and the in-memory bearer token. The short-lived
 * access token is transparently refreshed once on a 401 (same pattern as the
 * products/warehouses/customers clients).
 *
 * This slice covers the DRAFT lifecycle only: list, read, create, edit (PATCH)
 * and cancel. Approve/ship live on the backend but are out of scope for this UI.
 * `companyId` is NEVER sent and prices are NEVER client-supplied — the owning
 * tenant and every line price/tax/total are server-resolved (rules 3, 12, 16).
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

/** Whitelisted list/filter inputs (mirrors the backend list query). */
export interface OrderListQuery {
  limit?: number;
  cursor?: string;
  /** "DRAFT" / "APPROVED" / "SHIPPED" / "CANCELLED" — omit for "all". */
  status?: string;
  /** Filter by source warehouse (public id). */
  warehouseId?: string;
}

/** One requested order line. Only the product and quantity are ever sent. */
export interface OrderItemInput {
  /** Public id of the product to order. */
  productId: string;
  /** Positive quantity as an integer string (BIGINT-safe — never a JS number). */
  quantity: string;
}

/**
 * Create payload. Deliberately has NO `companyId`, `unitPrice`, `vatRate`,
 * `subtotal`, `vat` or `total` field: the strict backend pipe rejects unknown
 * keys, and price/tax/totals are SERVER-derived from the products (rule 16).
 */
export interface CreateOrderInput {
  customerId: string;
  warehouseId: string;
  items: OrderItemInput[];
  note?: string | null;
}

/**
 * Update (PATCH) payload — a safe whole-draft replace. Every field is optional;
 * an absent field is left unchanged. When `items` is present it REPLACES all
 * existing lines. Same hardening as create: no `companyId`/price/tax/total keys.
 */
export interface UpdateOrderInput {
  customerId?: string;
  warehouseId?: string;
  items?: OrderItemInput[];
  note?: string | null;
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

/** List the caller's company orders (cursor-paginated, scope-filtered server-side). */
export function listOrders(query: OrderListQuery = {}): Promise<OrderListView> {
  const qs = buildQuery({
    limit: query.limit,
    cursor: query.cursor,
    status: query.status,
    warehouseId: query.warehouseId,
  });
  return withFreshToken((accessToken) => apiFetch<OrderListView>(`/orders${qs}`, { accessToken }));
}

/** Get one order (with its lines) by public id. */
export function getOrder(id: string): Promise<OrderView> {
  return withFreshToken((accessToken) =>
    apiFetch<OrderView>(`/orders/${encodeURIComponent(id)}`, { accessToken }),
  );
}

/** Create a DRAFT order in the caller's company. */
export function createOrder(input: CreateOrderInput): Promise<OrderView> {
  return withFreshToken((accessToken) =>
    apiFetch<OrderView>('/orders', { method: 'POST', json: input, accessToken }),
  );
}

/** Update a DRAFT order by its public id (whole-draft replace). */
export function updateOrder(id: string, input: UpdateOrderInput): Promise<OrderView> {
  return withFreshToken((accessToken) =>
    apiFetch<OrderView>(`/orders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: input,
      accessToken,
    }),
  );
}

/** Cancel a DRAFT order by its public id (no stock effect in this slice). */
export function cancelOrder(id: string, reason?: string | null): Promise<OrderView> {
  return withFreshToken((accessToken) =>
    apiFetch<OrderView>(`/orders/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      json: reason ? { reason } : {},
      accessToken,
    }),
  );
}
