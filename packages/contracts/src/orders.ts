/**
 * Public order view-models (read DTOs) — Order Draft Foundation.
 *
 * These are the ONLY shapes the API returns for order resources. They are
 * hand-written contracts, never derived from Prisma models, so internal fields
 * (sequential PK, `companyId`, `createdById`, raw reservation counters) never
 * leak (API_CONVENTIONS §7a/§7b). Public identity is the UUID `id`; the
 * sequential PK is never exposed. Money is `{ amount, currency }` with `amount`
 * a minor-unit STRING (never a JS number — precision safety, §5); quantities are
 * BIGINT strings; VAT is basis points (integer).
 *
 * This slice covers the DRAFT lifecycle plus approval: an order is created,
 * edited, cancelled and (Order Approval + Stock Reservation Foundation) approved.
 * `status` is therefore one of `DRAFT` | `APPROVED` | `CANCELLED` here (the
 * prepare/ship transitions are a later slice).
 */

import type { MoneyView } from './products';
import type { Paginated } from './pagination';

/** One line of an order: a product, a quantity and the server-derived money. */
export interface OrderItemView {
  /** Public UUID of the product (never the sequential PK). */
  productId: string;
  /** Product SKU snapshot (frozen at create/update time). */
  sku: string;
  /** Product name snapshot (frozen at create/update time). */
  name: string;
  /** Quantity ordered, as a positive BIGINT string. */
  quantity: string;
  /** Unit price taken from the product's list price (server-priced). */
  unitPrice: MoneyView;
  /** VAT rate in basis points (2000 = 20%). Integer. */
  vatRate: number;
  /** Line net = unitPrice × quantity. */
  lineSubtotal: MoneyView;
  /** Line VAT = floor(lineSubtotal × vatRate / 10000). */
  lineVat: MoneyView;
  /** Line total = lineSubtotal + lineVat. */
  lineTotal: MoneyView;
}

/** Safe, whitelisted projection of an order (with its lines). */
export interface OrderView {
  /** Public UUID identity (never the sequential PK). */
  id: string;
  /** Human-facing order number (unique). */
  orderNo: string;
  /** Public UUID of the customer. */
  customerId: string;
  /** Public UUID of the source warehouse. */
  warehouseId: string;
  /** Lifecycle status — `DRAFT`, `APPROVED` or `CANCELLED` in this slice. */
  status: string;
  /** ISO 4217 currency shared by every line. */
  currency: string;
  /** Σ line net. */
  subtotal: MoneyView;
  /** Σ line VAT. */
  vat: MoneyView;
  /** subtotal + vat. */
  total: MoneyView;
  /** Optional free-text note. */
  note: string | null;
  /** The order lines. */
  items: OrderItemView[];
  createdAt: string;
  updatedAt: string;
  /** When the order was approved (stock reserved), or null if not yet approved. */
  approvedAt: string | null;
  /** When the order was cancelled, or null while it is still DRAFT. */
  cancelledAt: string | null;
}

/** A page of orders. */
export type OrderListView = Paginated<OrderView>;
