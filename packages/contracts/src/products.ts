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
