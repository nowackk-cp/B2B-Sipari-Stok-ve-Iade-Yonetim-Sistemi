/**
 * Public invoice view-models (read DTOs) — Invoice/Billing Foundation.
 *
 * These are the ONLY shapes the API returns for invoice resources. They are
 * hand-written contracts, never derived from Prisma models, so internal fields
 * (sequential PK, `companyId`, `createdById`, the raw `idempotencyKey` and the
 * internal `warehouseId`/`orderItemId`) never leak (API_CONVENTIONS §7a/§7b).
 * Public identity is the UUID `id`; the sequential PK is never exposed. Money is
 * `{ amount, currency }` with `amount` a minor-unit STRING (never a JS number —
 * precision safety, §5); quantities are BIGINT strings; VAT is basis points.
 *
 * This slice issues an invoice for a SHIPPED order: the invoice is created
 * directly as `ISSUED` with a gapless `invoiceNo` and a line snapshot copied from
 * the order's frozen prices. `status` is `ISSUED` here.
 */

import type { MoneyView } from './products';
import type { Paginated } from './pagination';

/** One frozen line of an invoice (snapshot of an order line). */
export interface InvoiceItemView {
  /** Public UUID of the product (never the sequential PK), or null if cleared. */
  productId: string | null;
  /** Line description (product name snapshot at issue time). */
  description: string;
  /** Quantity invoiced, as a positive BIGINT string. */
  quantity: string;
  /** Unit price (frozen from the order line). */
  unitPrice: MoneyView;
  /** VAT rate in basis points (2000 = 20%). Integer. */
  vatRate: number;
  /** Line net = unitPrice × quantity. */
  lineSubtotal: MoneyView;
  /** Line VAT. */
  lineVat: MoneyView;
  /** Line total = lineSubtotal + lineVat. */
  lineTotal: MoneyView;
}

/** Safe, whitelisted projection of an invoice (with its lines). */
export interface InvoiceView {
  /** Public UUID identity (never the sequential PK). */
  id: string;
  /** Gapless, human-facing invoice number (e.g. "INV-2026-000001"), or null. */
  invoiceNo: string | null;
  /** Numeric invoice number within the series, as a BIGINT string, or null. */
  invoiceNumber: string | null;
  /** Series code (e.g. "INV"), or null. */
  seriesCode: string | null;
  /** Fiscal year the number was allocated in, or null. */
  fiscalYear: number | null;
  /** Lifecycle status — `ISSUED` in this slice. */
  status: string;
  /** Public UUID of the source order, or null. */
  orderId: string | null;
  /** Public UUID of the billed customer. */
  customerId: string;
  /** Public UUID of the source warehouse, or null. */
  warehouseId: string | null;
  /** ISO 4217 currency shared by every line. */
  currency: string;
  /** Σ line net. */
  subtotal: MoneyView;
  /** Σ line VAT. */
  vat: MoneyView;
  /** subtotal + vat. */
  total: MoneyView;
  /** The invoice lines. */
  items: InvoiceItemView[];
  /** When the invoice was issued (number allocated), or null while DRAFT. */
  issuedAt: string | null;
  createdAt: string;
}

/** A page of invoices. */
export type InvoiceListView = Paginated<InvoiceView>;
