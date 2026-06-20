/**
 * Public credit note view-models (read DTOs) — Return Invoice / Credit Note Foundation.
 *
 * These are the ONLY shapes the API returns for credit note resources. They are
 * hand-written contracts, never derived from Prisma models, so internal fields
 * (sequential PK, `companyId`, `createdById`, the raw `idempotencyKey` and internal
 * `warehouseId`/`returnItemId`/`orderItemId`) never leak (API_CONVENTIONS §7a/§7b).
 * Public identity is the UUID `id`; the sequential PK is never exposed. Money is
 * `{ amount, currency }` with `amount` a minor-unit STRING (never a JS number —
 * precision safety, §5); quantities are BIGINT strings; VAT is basis points.
 *
 * A credit note is issued for an APPROVED return of an invoiced order: it is created
 * directly as `ISSUED` with a gapless `creditNoteNo` and a line snapshot computed
 * from the return quantities × the original order/invoice line price+VAT.
 */

import type { MoneyView } from './products';
import type { Paginated } from './pagination';

/** One frozen line of a credit note (snapshot of a returned order line). */
export interface CreditNoteItemView {
  /** Public UUID of the product being credited (never the sequential PK). */
  productId: string;
  /** Line description (product-name snapshot at issue time). */
  description: string;
  /** Quantity credited, as a positive BIGINT string. */
  quantity: string;
  /** Unit price (frozen from the original order/invoice line). */
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

/** Safe, whitelisted projection of a credit note (with its lines). */
export interface CreditNoteView {
  /** Public UUID identity (never the sequential PK). */
  id: string;
  /** Gapless, human-facing credit note number (e.g. "CRN-2026-000001"). */
  creditNoteNo: string;
  /** Numeric credit note number within the series, as a BIGINT string. */
  creditNoteNumber: string;
  /** Series code (e.g. "CRN"). */
  seriesCode: string;
  /** Fiscal year the number was allocated in. */
  fiscalYear: number;
  /** Lifecycle status — `ISSUED` in this slice. */
  status: string;
  /** Public UUID of the source return. */
  returnId: string;
  /** Public UUID of the source order. */
  orderId: string;
  /** Public UUID of the original invoice this credit reverses. */
  originalInvoiceId: string;
  /** Public UUID of the credited customer. */
  customerId: string;
  /** Public UUID of the source warehouse. */
  warehouseId: string;
  /** ISO 4217 currency shared by every line. */
  currency: string;
  /** Σ line net. */
  subtotal: MoneyView;
  /** Σ line VAT. */
  vat: MoneyView;
  /** subtotal + vat. */
  total: MoneyView;
  /** The credit note lines. */
  items: CreditNoteItemView[];
  /** When the credit note was issued (number allocated). */
  issuedAt: string;
  createdAt: string;
}

/** A page of credit notes. */
export type CreditNoteListView = Paginated<CreditNoteView>;
