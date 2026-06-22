import type { ProductImportResultView, ProductListView, ProductView } from '@b2b/contracts';
import { ApiError, apiFetch, apiFetchResponse } from './api-fetch';
import { getAccessToken, refresh } from './auth-client';

/**
 * Browser client for the product catalog (`/api/v1/products`).
 *
 * Every call goes through {@link apiFetch}/{@link apiFetchResponse} (CLAUDE.md
 * Mutlak Kural #1 — all business traffic via `/api/v1`) which always sends the
 * HttpOnly cookies (`credentials: 'include'`) and the in-memory bearer token.
 * The short-lived access token is transparently refreshed once on a 401 (same
 * pattern as the dashboard client). Money stays a minor-unit STRING end-to-end;
 * `companyId` is NEVER sent — the tenant is the server-resolved principal.
 */

/**
 * Flatten an error into user-facing messages. RFC 7807 field errors (`errors[]`)
 * are surfaced verbatim (e.g. per-row import failures, per-field validation);
 * otherwise the human `detail`/`title` is used, falling back to a generic line.
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
export interface ProductListQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  /** "true" / "false" — omit for "all". */
  isActive?: string;
  categoryId?: string;
}

/** Filters for the CSV export (mirror the list filters, no pagination). */
export interface ProductExportQuery {
  search?: string;
  isActive?: string;
  categoryId?: string;
}

/**
 * Money input for a write: a minor-unit STRING amount + ISO currency. Never a JS
 * number (CLAUDE.md Mutlak Kural #3) — the string crosses the wire untouched.
 */
export interface ProductMoneyInput {
  amount: string;
  currency: string;
}

/**
 * Create/update payload. Deliberately has NO `companyId` field so a forged tenant
 * can never be sent (the strict backend pipe also rejects unknown keys). For an
 * update every field is optional.
 */
export interface ProductWriteInput {
  sku?: string;
  name?: string;
  description?: string | null;
  listPrice?: ProductMoneyInput;
  /** VAT rate in basis points (2000 = 20%). */
  vatRate?: number;
  criticalStockThreshold?: string | null;
  isActive?: boolean;
}

/** A downloaded file: the raw blob plus the server-provided (or fallback) name. */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
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

/** Parse the filename out of a `Content-Disposition` header, if present. */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  // RFC 5987 `filename*=UTF-8''...` first, then a quoted/bare `filename=`.
  const ext = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (ext?.[1]) {
    try {
      return decodeURIComponent(ext[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain filename */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim();
}

/** List/search the caller's catalog (cursor-paginated). */
export function listProducts(query: ProductListQuery = {}): Promise<ProductListView> {
  const qs = buildQuery({
    limit: query.limit,
    cursor: query.cursor,
    search: query.search,
    isActive: query.isActive,
    categoryId: query.categoryId,
  });
  return withFreshToken((accessToken) =>
    apiFetch<ProductListView>(`/products${qs}`, { accessToken }),
  );
}

/** Create a product in the caller's company. */
export function createProduct(input: ProductWriteInput): Promise<ProductView> {
  return withFreshToken((accessToken) =>
    apiFetch<ProductView>('/products', { method: 'POST', json: input, accessToken }),
  );
}

/** Update a product by its public id. */
export function updateProduct(id: string, input: ProductWriteInput): Promise<ProductView> {
  return withFreshToken((accessToken) =>
    apiFetch<ProductView>(`/products/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: input,
      accessToken,
    }),
  );
}

/** Soft-delete a product by its public id (backend keeps the row + audit). */
export function deleteProduct(id: string): Promise<void> {
  return withFreshToken((accessToken) =>
    apiFetch<void>(`/products/${encodeURIComponent(id)}`, { method: 'DELETE', accessToken }),
  );
}

/** Bulk-import products from a CSV file (multipart, all-or-nothing on the server). */
export function importProducts(file: File): Promise<ProductImportResultView> {
  const form = new FormData();
  form.append('file', file);
  return withFreshToken(async (accessToken) => {
    const res = await apiFetchResponse('/products/imports', {
      method: 'POST',
      body: form,
      accessToken,
    });
    return (await res.json()) as ProductImportResultView;
  });
}

/** Export the catalog as a CSV blob, honouring the current list filters. */
export function exportProducts(query: ProductExportQuery = {}): Promise<DownloadedFile> {
  const qs = buildQuery({
    search: query.search,
    isActive: query.isActive,
    categoryId: query.categoryId,
  });
  return withFreshToken(async (accessToken) => {
    const res = await apiFetchResponse(`/products/export${qs}`, { accessToken });
    const blob = await res.blob();
    const filename =
      filenameFromDisposition(res.headers.get('content-disposition')) ??
      `products-${new Date().toISOString().slice(0, 10)}.csv`;
    return { blob, filename };
  });
}
