/**
 * Public inventory view-models (read DTOs) — Stock Ledger Foundation.
 *
 * These are the ONLY shapes the API returns for stock resources. They are
 * hand-written contracts, never derived from Prisma models, so internal fields
 * (sequential PK, raw counters) never leak (API_CONVENTIONS §7a/§7b). Warehouse
 * and product identity is always the UUID `publicId`; the sequential PKs of the
 * balance/ledger rows are never exposed.
 *
 * Quantities are integer minor units serialised as STRINGS (BIGINT, never a JS
 * number — precision safety, mirrors the money convention in §5).
 */

import type { Paginated } from './pagination';

/** Direction of a manual stock adjustment (raises or lowers on-hand). */
export type StockAdjustmentDirection = 'INCREASE' | 'DECREASE';

/** Current on-hand balance of one product in one warehouse. */
export interface StockBalanceView {
  /** Public UUID of the warehouse the balance belongs to. */
  warehouseId: string;
  /** Public UUID of the product the balance is for. */
  productId: string;
  /** Product SKU snapshot (for display). */
  sku: string;
  /** Product name snapshot (for display). */
  name: string;
  /** Physical on-hand quantity, as a BIGINT string. */
  quantity: string;
  /** Available quantity = on_hand − reserved, as a BIGINT string. */
  availableQuantity: string;
  updatedAt: string;
}

/** A page of stock balances. */
export type StockBalanceListView = Paginated<StockBalanceView>;

/** A single append-only stock movement (ledger entry). */
export interface StockMovementView {
  /** Public UUID of the warehouse the movement touched. */
  warehouseId: string;
  /** Public UUID of the product the movement touched. */
  productId: string;
  /** Product SKU snapshot (for display). */
  sku: string;
  /** Product name snapshot (for display). */
  name: string;
  /** Ledger change type, e.g. "ADJUSTMENT". */
  type: string;
  /** Whether the movement raised or lowered on-hand. */
  direction: StockAdjustmentDirection;
  /** Absolute magnitude of the change, as a BIGINT string (always positive). */
  quantity: string;
  /** On-hand before the movement, as a BIGINT string. */
  balanceBefore: string;
  /** On-hand after the movement, as a BIGINT string. */
  balanceAfter: string;
  /** Free-text reason (required for manual adjustments). */
  reason: string | null;
  createdAt: string;
}

/** A page of stock movements. */
export type StockMovementListView = Paginated<StockMovementView>;
