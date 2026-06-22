import type { CreditNoteListView, CreditNoteView } from '@b2b/contracts';
import { ApiError, apiFetch } from './api-fetch';
import { getAccessToken, refresh } from './auth-client';

/**
 * Browser client for credit notes (`/api/v1/credit-notes`) plus the return→credit
 * note issue command (`POST /api/v1/returns/:id/credit-note`).
 *
 * Every call goes through {@link apiFetch} (CLAUDE.md Mutlak Kural #1 — all
 * business traffic via `/api/v1`) which always sends the HttpOnly cookies
 * (`credentials: 'include'`) and the in-memory bearer token. The short-lived
 * access token is transparently refreshed once on a 401 (same pattern as the
 * orders/invoices/returns clients).
 *
 * Reads are list + by-id only (a credit note is created as ISSUED by the issue
 * command — no edit/void in this slice). `companyId` and every server-derived
 * amount (subtotal/vat/total/number) are NEVER sent — they are resolved entirely
 * server-side from the source return × the original order/invoice line price+VAT
 * (rules 3, 11, 12, 16).
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
export interface CreditNoteListQuery {
  limit?: number;
  cursor?: string;
  /** "ISSUED" / "VOID" — omit for "all". */
  status?: string;
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

/** List the caller's company credit notes (cursor-paginated, scope-filtered server-side). */
export function listCreditNotes(query: CreditNoteListQuery = {}): Promise<CreditNoteListView> {
  const qs = buildQuery({ limit: query.limit, cursor: query.cursor, status: query.status });
  return withFreshToken((accessToken) =>
    apiFetch<CreditNoteListView>(`/credit-notes${qs}`, { accessToken }),
  );
}

/** Get one credit note (with its lines) by public id. */
export function getCreditNote(id: string): Promise<CreditNoteView> {
  return withFreshToken((accessToken) =>
    apiFetch<CreditNoteView>(`/credit-notes/${encodeURIComponent(id)}`, { accessToken }),
  );
}

/**
 * Issue a credit note for an APPROVED return (`POST /returns/:id/credit-note`) and
 * return the (possibly replayed) ISSUED credit note — with a gapless,
 * server-allocated number (rule 11). `Idempotency-Key` is MANDATORY (rule 9): the
 * caller passes a STABLE key so a transient-failure retry replays the same credit
 * note instead of allocating a second number. A second credit note for the same
 * return is a 409 ("already credited"); a return whose order has no invoice is a
 * 422. No client body — totals are computed from the return server-side.
 */
export function issueCreditNoteForReturn(
  returnId: string,
  idempotencyKey: string,
): Promise<CreditNoteView> {
  return withFreshToken((accessToken) =>
    apiFetch<CreditNoteView>(`/returns/${encodeURIComponent(returnId)}/credit-note`, {
      method: 'POST',
      accessToken,
      headers: { 'idempotency-key': idempotencyKey },
    }),
  );
}
