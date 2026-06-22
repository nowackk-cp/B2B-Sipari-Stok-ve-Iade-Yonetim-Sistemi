import type { ReturnListView, ReturnView } from '@b2b/contracts';
import { ApiError, apiFetch } from './api-fetch';
import { getAccessToken, refresh } from './auth-client';

/**
 * Browser client for returns (`/api/v1/returns`) plus the order→return create
 * command (`POST /api/v1/orders/:id/returns`).
 *
 * Every call goes through {@link apiFetch} (CLAUDE.md Mutlak Kural #1 — all
 * business traffic via `/api/v1`) which always sends the HttpOnly cookies
 * (`credentials: 'include'`) and the in-memory bearer token. The short-lived
 * access token is transparently refreshed once on a 401 (same pattern as the
 * orders/invoices/products/warehouses/customers clients).
 *
 * A return is raised against a SHIPPED order (status `DRAFT`, no stock effect) and
 * restocks the goods on approval (status `APPROVED`). Both the create and the
 * approve command REQUIRE a client-generated `Idempotency-Key` (rule 9): the caller
 * passes a STABLE key so a transient-failure retry replays the same command instead
 * of creating/approving twice. `companyId`, the warehouse and every server-derived
 * field are NEVER sent — the return is written to the actor's real company and the
 * order's warehouse, resolved server-side; line quantities are the only client
 * input (rules 3, 12, 16).
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
export interface ReturnListQuery {
  limit?: number;
  cursor?: string;
  /** "DRAFT" / "APPROVED" — omit for "all". */
  status?: string;
}

/**
 * One requested return line. Only the product, the quantity and an optional reason
 * are ever sent — the line is bound to an ORDER line by its product public id and
 * the returnable quantity is computed SERVER-side from the shipped quantity.
 */
export interface CreateReturnItemInput {
  /** Public id of the product being returned. */
  productId: string;
  /** Positive quantity as an integer string (BIGINT-safe — never a JS number). */
  quantity: string;
  /** Optional per-line reason/note. */
  reason?: string | null;
}

/**
 * Create payload. Deliberately has NO `companyId`/`warehouseId`/`status` field: the
 * strict backend pipe rejects unknown keys, the return is written to the actor's
 * real company and the order's warehouse, and prices/totals are not part of a
 * return at all.
 */
export interface CreateReturnInput {
  items: CreateReturnItemInput[];
  reason?: string | null;
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

/** List the caller's company returns (cursor-paginated, scope-filtered server-side). */
export function listReturns(query: ReturnListQuery = {}): Promise<ReturnListView> {
  const qs = buildQuery({ limit: query.limit, cursor: query.cursor, status: query.status });
  return withFreshToken((accessToken) => apiFetch<ReturnListView>(`/returns${qs}`, { accessToken }));
}

/** Get one return (with its lines) by public id. */
export function getReturn(id: string): Promise<ReturnView> {
  return withFreshToken((accessToken) =>
    apiFetch<ReturnView>(`/returns/${encodeURIComponent(id)}`, { accessToken }),
  );
}

/**
 * Raise a return for a SHIPPED order (`POST /orders/:id/returns`) and return the
 * (possibly replayed) DRAFT return. `Idempotency-Key` is MANDATORY (rule 9): the
 * caller passes a STABLE key so a transient-failure retry replays the same return
 * instead of creating a second one. The same key reused with a different payload is
 * a 409. A non-SHIPPED order is a 409.
 */
export function createReturn(
  orderId: string,
  input: CreateReturnInput,
  idempotencyKey: string,
): Promise<ReturnView> {
  return withFreshToken((accessToken) =>
    apiFetch<ReturnView>(`/orders/${encodeURIComponent(orderId)}/returns`, {
      method: 'POST',
      json: input,
      accessToken,
      headers: { 'idempotency-key': idempotencyKey },
    }),
  );
}

/**
 * Approve a DRAFT return (`POST /returns/:id/approve`) — the server atomically
 * restocks the goods (on_hand+, one RETURN_IN ledger movement) and transitions
 * DRAFT→APPROVED. `Idempotency-Key` is MANDATORY (rule 9): the caller passes a
 * STABLE key so a transient-failure retry replays the same approval instead of
 * double-restocking. An already-APPROVED return is a same-key replay or a 409. No
 * client body — the approve command takes no fields.
 */
export function approveReturn(id: string, idempotencyKey: string): Promise<ReturnView> {
  return withFreshToken((accessToken) =>
    apiFetch<ReturnView>(`/returns/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      accessToken,
      headers: { 'idempotency-key': idempotencyKey },
    }),
  );
}
