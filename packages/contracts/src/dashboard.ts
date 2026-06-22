/**
 * Public dashboard / reports view-models (read DTOs) — Dashboard / Reports
 * Backend Foundation.
 *
 * These are the ONLY shapes the API returns for the management dashboard and the
 * sales / inventory / returns reports. They are hand-written contracts, never
 * derived from Prisma models, so internal fields (sequential PKs, `companyId`,
 * the internal warehouse ids) never leak (API_CONVENTIONS §7a/§7b). Public
 * identity is always the UUID `publicId`. Money is `{ amount, currency }` with
 * `amount` a minor-unit STRING (never a JS number — precision safety, §5);
 * quantities are BIGINT strings.
 *
 * Every endpoint is READ-ONLY: it counts/aggregates existing rows and writes
 * nothing. All figures are scoped to the caller's own company and intersected
 * with their warehouse scope (resolved from PostgreSQL, never a JWT claim).
 */

import type { MoneyView } from './products';
import type { PageInfo } from './pagination';

/**
 * Management dashboard summary (`GET /dashboard/summary`).
 *
 * Catalog/customer counts are company-wide (master data is not warehouse-bound).
 * Order/invoice/return/stock figures are intersected with the caller's warehouse
 * scope: a `warehouse:scope:all` actor sees the whole company; an explicitly
 * scoped actor sees only their warehouses; an actor with no scope sees zero for
 * the warehouse-bound figures (deny-by-default).
 */
export interface DashboardSummaryView {
  /** Active + soft-deleted-excluded product cards in the company. */
  totalProducts: number;
  /** Products that are active (`isActive = true`, not soft-deleted). */
  activeProducts: number;
  /** Customer cards in the company (soft-deleted excluded). */
  totalCustomers: number;
  /** Stock balances (in scope) whose available ≤ the product's critical threshold. */
  lowStockProducts: number;
  /** Orders in `DRAFT` (in scope). */
  draftOrders: number;
  /** Orders in `APPROVED` (in scope). */
  approvedOrders: number;
  /** Orders in `SHIPPED` (in scope). */
  shippedOrders: number;
  /** Invoices in `ISSUED` (in scope). */
  issuedInvoices: number;
  /** Returns in `DRAFT` — the "requested" state of this foundation (in scope). */
  requestedReturns: number;
  /** Returns in `APPROVED` (in scope). */
  approvedReturns: number;
  /** Today's (UTC) ISSUED-invoice sales totals, grouped by currency. */
  todaySalesAmount: MoneyView[];
  /** This month's (UTC) ISSUED-invoice sales totals, grouped by currency. */
  monthSalesAmount: MoneyView[];
}

/** Grouping granularity of the sales report. */
export type SalesReportGroupBy = 'day' | 'month';

/** One aggregated sales bucket (a period × currency). */
export interface SalesReportRowView {
  /** `YYYY-MM-DD` for `day`, `YYYY-MM` for `month` (UTC). */
  period: string;
  /** ISSUED invoices counted in this bucket. */
  invoiceCount: number;
  /** Σ line net (minor-unit BIGINT string). */
  subtotalAmount: string;
  /** Σ line VAT (minor-unit BIGINT string). */
  vatAmount: string;
  /** Σ grand total (minor-unit BIGINT string). */
  totalAmount: string;
  /** ISO 4217 currency of this bucket. */
  currency: string;
}

/** Gross-sales report over ISSUED invoices (`GET /reports/sales`). */
export interface SalesReportView {
  groupBy: SalesReportGroupBy;
  /** Inclusive UTC range start (echoes the request, ISO 8601). */
  dateFrom: string;
  /** Inclusive UTC range end (echoes the request, ISO 8601). */
  dateTo: string;
  rows: SalesReportRowView[];
}

/** One inventory report row (a product × warehouse stock balance). */
export interface InventoryReportRowView {
  /** Public UUID of the product. */
  productId: string;
  sku: string;
  name: string;
  /** Public UUID of the warehouse the balance belongs to. */
  warehouseId: string;
  /** On-hand quantity (BIGINT string). */
  onHand: string;
  /** Reserved quantity (BIGINT string). */
  reserved: string;
  /** available = onHand − reserved (BIGINT string). */
  available: string;
  /** The product's critical-stock threshold (BIGINT string), or null if unset. */
  criticalStockThreshold: string | null;
  /** Whether available ≤ criticalStockThreshold (always false when threshold unset). */
  isLowStock: boolean;
}

/** A page of inventory report rows (`GET /reports/inventory`). */
export interface InventoryReportView {
  data: InventoryReportRowView[];
  pageInfo: PageInfo;
}

/** Aggregated returns report (`GET /reports/returns`). */
export interface ReturnsReportView {
  /** Total returns in range/scope (after the optional status filter). */
  returnCount: number;
  /** Returns in `DRAFT` (requested). */
  requestedCount: number;
  /** Returns in `APPROVED`. */
  approvedCount: number;
  /** Σ returned line quantities (BIGINT string). */
  totalReturnedQuantity: string;
  /** Credit notes issued for the in-range/scope returns. */
  creditNoteCount: number;
  /** Σ credit-note grand totals, grouped by currency. */
  creditNoteTotalAmount: MoneyView[];
}
