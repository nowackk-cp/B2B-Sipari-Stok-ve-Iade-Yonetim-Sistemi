/**
 * Public product catalog view-models (read DTOs) — TASK-011.
 *
 * These are the ONLY shapes the API returns for catalog resources. They are
 * hand-written contracts, never derived from Prisma models, so internal fields
 * (sequential PK, `companyId`, `deletedAt`) never leak (API_CONVENTIONS §7a/§7b).
 * Public identity is the UUID `publicId`; the sequential PK is never exposed.
 */

import type { Paginated } from './pagination';

/** Money as a minor-unit STRING + ISO currency (API_CONVENTIONS §5 — never a JS number). */
export interface MoneyView {
  /** Amount in minor units, as a string (precision-safe). */
  amount: string;
  /** ISO 4217 currency code, e.g. "TRY". */
  currency: string;
}

/** Safe, whitelisted projection of a product card. */
export interface ProductView {
  /** Public UUID identity (never the sequential PK). */
  id: string;
  sku: string;
  name: string;
  description: string | null;
  barcode: string | null;
  /** Unit of measure, e.g. "EACH", "KG". */
  unit: string;
  /** Owning category id (string) or null. */
  categoryId: string | null;
  /** VAT rate in basis points (2000 = 20%). Integer; avoids float money error. */
  vatRate: number;
  listPrice: MoneyView;
  isActive: boolean;
  /** Optional low-stock alert threshold (catalog attribute, not a stock count). */
  criticalStockThreshold: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A page of products. */
export type ProductListView = Paginated<ProductView>;

/**
 * A single per-row validation failure from a product import (Product Import/Export
 * Foundation). `row` is the 1-based data-row number in the uploaded file (the
 * header is row 0); `column` names the offending column when the error is
 * attributable to one, otherwise null.
 */
export interface ProductImportErrorView {
  row: number;
  column: string | null;
  message: string;
}

/**
 * Terminal status of a product import. A synchronous import is COMPLETED (every
 * row applied, all-or-nothing) or VALIDATION_FAILED (no row applied).
 */
export type ProductImportStatus = 'COMPLETED' | 'VALIDATION_FAILED';

/**
 * Whitelisted projection of a product import job. The public identity is the
 * uploaded source file's UUID (`id`); the sequential PK is never exposed. On a
 * COMPLETED import `errors` is empty; on a rejected import the response carries
 * the per-row errors instead (problem+json) and nothing is persisted.
 */
export interface ProductImportResultView {
  /** Public UUID identity of the import (its source file's publicId). */
  id: string;
  status: ProductImportStatus;
  /** SHA-256 hex checksum of the uploaded file (duplicate-file fingerprint). */
  checksum: string;
  /** Total data rows parsed from the file (excludes the header). */
  totalRows: number;
  /** Rows that passed validation. */
  validRows: number;
  /** Rows that failed validation. */
  invalidRows: number;
  /** Rows actually written (equals totalRows on COMPLETED, 0 on failure). */
  appliedRows: number;
  errors: ProductImportErrorView[];
  createdAt: string;
}
