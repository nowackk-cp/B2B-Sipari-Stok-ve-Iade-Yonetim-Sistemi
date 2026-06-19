/**
 * Public return / refund view-models (read DTOs) — Return/Refund Foundation.
 *
 * These are the ONLY shapes the API returns for return resources. They are
 * hand-written contracts, never derived from Prisma models, so internal fields
 * (sequential PK, `companyId`, `createdById`, the raw `idempotencyKey`/
 * `approveIdempotencyKey` and the internal `warehouseId`/`orderItemId`) never leak
 * (API_CONVENTIONS §7a/§7b). Public identity is the UUID `id`; the sequential PK is
 * never exposed. Quantities are BIGINT strings (never a JS number).
 *
 * A return is raised against a SHIPPED order (status `DRAFT`) and restocks the
 * goods on approval (status `APPROVED`).
 */

import type { Paginated } from './pagination';

/** One requested return line (bound to an order line by its product). */
export interface ReturnItemView {
  /** Public UUID of the product being returned (never the sequential PK). */
  productId: string;
  /** Quantity returned for this line, as a positive BIGINT string. */
  quantity: string;
  /** Optional per-line reason/note, or null. */
  reason: string | null;
}

/** Safe, whitelisted projection of a return (with its lines). */
export interface ReturnView {
  /** Public UUID identity (never the sequential PK). */
  id: string;
  /** Human-facing return number (e.g. "RET-20260618-AB12CD34EF"). */
  returnNo: string;
  /** Lifecycle status — `DRAFT` (requested) or `APPROVED` (restocked). */
  status: string;
  /** Public UUID of the source order. */
  orderId: string;
  /** Public UUID of the customer the order belongs to. */
  customerId: string;
  /** Public UUID of the warehouse the goods return to. */
  warehouseId: string;
  /** Optional public UUID of the linked invoice, or null. */
  invoiceId: string | null;
  /** Optional return-level reason, or null. */
  reason: string | null;
  /** The return lines. */
  items: ReturnItemView[];
  createdAt: string;
  /** When the return was approved (restocked), or null while DRAFT. */
  approvedAt: string | null;
}

/** A page of returns. */
export type ReturnListView = Paginated<ReturnView>;
