import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  DashboardSummaryView,
  InventoryReportRowView,
  InventoryReportView,
  MoneyView,
  ReturnsReportView,
  SalesReportView,
} from '@b2b/contracts';
import type { AuthPrincipal } from '../../common/auth/principal';
import { CLOCK, type Clock } from '../../common/time/clock';
import { WarehouseScopeService } from '../authorization/warehouse-scope.service';
import {
  ReportsRepository,
  type CreditNoteCurrencyRow,
  type CurrencyTotalRow,
  type InventoryAggRow,
  type WarehouseScope,
} from './reports.repository';
import type { SalesReportQuery } from './dto/sales-report.query';
import type { InventoryReportQuery } from './dto/inventory-report.query';
import type { ReturnsReportQuery } from './dto/returns-report.query';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MS_PER_DAY = 86_400_000;

/** Resolved warehouse scope, or `NONE` = no warehouse visibility (deny-by-default). */
type ResolvedScope = WarehouseScope | 'NONE';

/**
 * Dashboard / Reports application service (Dashboard / Reports Backend Foundation).
 *
 * Serves four READ-ONLY aggregate endpoints — the management dashboard summary and
 * the sales / inventory / returns reports. It writes nothing (no mutation, no audit)
 * and opens no transaction (each call is a set of independent reads).
 *
 * Two controls guard every figure, both resolved from PostgreSQL (never a JWT
 * claim or the request body):
 *   1. TENANT — every query is filtered by `actor.companyId`, so a forged company
 *      claim can never reach another tenant's rows.
 *   2. WAREHOUSE SCOPE — the order/invoice/return/stock figures are intersected
 *      with the caller's warehouse scope via {@link WarehouseScopeService}: a
 *      `warehouse:scope:all` actor sees the whole company; an explicitly-scoped
 *      actor sees only their warehouses; an actor with NO warehouse scope sees
 *      zero/empty for the warehouse-bound figures (deny-by-default). Catalog and
 *      customer counts are company-wide (master data is not warehouse-bound).
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly scope: WarehouseScopeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- dashboard ------------------------------------------------------------

  async summary(actor: AuthPrincipal): Promise<DashboardSummaryView> {
    // Company-wide master-data counts (not warehouse-bound) always run.
    const [{ total, active }, totalCustomers] = await Promise.all([
      this.repo.countProducts(actor.companyId),
      this.repo.countCustomers(actor.companyId),
    ]);

    const base = {
      totalProducts: total,
      activeProducts: active,
      totalCustomers,
    };

    const scope = await this.resolveScope(actor);
    if (scope === 'NONE') {
      // No warehouse visibility → every warehouse-bound figure is zero/empty.
      return {
        ...base,
        lowStockProducts: 0,
        draftOrders: 0,
        approvedOrders: 0,
        shippedOrders: 0,
        issuedInvoices: 0,
        requestedReturns: 0,
        approvedReturns: 0,
        todaySalesAmount: [],
        monthSalesAmount: [],
      };
    }

    const now = this.clock.now();
    const todayStart = utcMidnight(now);
    const todayExclusive = new Date(todayStart.getTime() + MS_PER_DAY);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [orders, issuedInvoices, returns, lowStockProducts, todaySales, monthSales] =
      await Promise.all([
        this.repo.countOrdersByStatus(actor.companyId, scope),
        this.repo.countIssuedInvoices(actor.companyId, scope),
        this.repo.countReturnsByStatus(actor.companyId, scope),
        this.repo.countLowStock(actor.companyId, scope),
        this.repo.sumIssuedSalesByCurrency(actor.companyId, scope, todayStart, todayExclusive),
        this.repo.sumIssuedSalesByCurrency(actor.companyId, scope, monthStart, monthExclusive),
      ]);

    return {
      ...base,
      lowStockProducts,
      draftOrders: orders.draft,
      approvedOrders: orders.approved,
      shippedOrders: orders.shipped,
      issuedInvoices,
      requestedReturns: returns.requested,
      approvedReturns: returns.approved,
      todaySalesAmount: toMoneyViews(todaySales),
      monthSalesAmount: toMoneyViews(monthSales),
    };
  }

  // --- sales report ---------------------------------------------------------

  async salesReport(actor: AuthPrincipal, query: SalesReportQuery): Promise<SalesReportView> {
    const groupBy = query.groupBy ?? 'day';
    // Validate the range FIRST so an invalid date is a 400 regardless of scope.
    const { fromInclusive, toExclusive } = parseUtcDayRange(query.dateFrom, query.dateTo);

    const empty: SalesReportView = {
      groupBy,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      rows: [],
    };

    const scope = await this.resolveScope(actor);
    if (scope === 'NONE') return empty;
    const effective = await this.narrowToWarehouse(actor, scope, query.warehouseId);
    if (effective === 'NONE') return empty;

    const rows = await this.repo.salesReport(
      actor.companyId,
      effective,
      fromInclusive,
      toExclusive,
      groupBy,
    );
    return { groupBy, dateFrom: query.dateFrom, dateTo: query.dateTo, rows };
  }

  // --- inventory report -----------------------------------------------------

  async inventoryReport(
    actor: AuthPrincipal,
    query: InventoryReportQuery,
  ): Promise<InventoryReportView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor);

    const scope = await this.resolveScope(actor);
    if (scope === 'NONE') return emptyInventory();
    const effective = await this.narrowToWarehouse(actor, scope, query.warehouseId);
    if (effective === 'NONE') return emptyInventory();

    const rows = await this.repo.inventoryReport(actor.companyId, effective, {
      take: limit + 1,
      cursorId,
      lowStockOnly: query.lowStockOnly,
      search: query.search?.trim() || undefined,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? encodeCursor(page[page.length - 1]!.id) : null;
    return { data: page.map(toInventoryRowView), pageInfo: { nextCursor, hasNextPage } };
  }

  // --- returns report -------------------------------------------------------

  async returnsReport(actor: AuthPrincipal, query: ReturnsReportQuery): Promise<ReturnsReportView> {
    // Validate the range FIRST so an invalid date is a 400 regardless of scope.
    const { fromInclusive, toExclusive } = parseUtcDayRange(query.dateFrom, query.dateTo);

    const scope = await this.resolveScope(actor);
    if (scope === 'NONE') return emptyReturns();
    const effective = await this.narrowToWarehouse(actor, scope, query.warehouseId);
    if (effective === 'NONE') return emptyReturns();

    const [{ counts, totalReturnedQuantity }, creditNotes] = await Promise.all([
      this.repo.returnsAggregate(
        actor.companyId,
        effective,
        fromInclusive,
        toExclusive,
        query.status,
      ),
      this.repo.creditNoteTotalsByCurrency(
        actor.companyId,
        effective,
        fromInclusive,
        toExclusive,
        query.status,
      ),
    ]);

    return {
      returnCount: counts.returnCount,
      requestedCount: counts.requestedCount,
      approvedCount: counts.approvedCount,
      totalReturnedQuantity,
      creditNoteCount: creditNotes.reduce((sum, r) => sum + r.cnt, 0),
      creditNoteTotalAmount: toCreditNoteMoneyViews(creditNotes),
    };
  }

  // --- internals ------------------------------------------------------------

  /**
   * Resolve the caller's warehouse-access envelope from PostgreSQL. Returns `NONE`
   * when the actor cannot act (missing/suspended/deleted) OR holds no global scope
   * and no explicit warehouse — both mean "no warehouse visibility" (deny-by-default).
   */
  private async resolveScope(actor: AuthPrincipal): Promise<ResolvedScope> {
    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) return 'NONE';
    if (access.global) return { global: true };
    if (access.scopedWarehouseIds.size === 0) return 'NONE';
    return { global: false, warehouseIds: [...access.scopedWarehouseIds] };
  }

  /**
   * Intersect a resolved scope with an optional `warehouseId` filter (a public id).
   * The filter can never widen access: an unknown/other-tenant warehouse, or one the
   * actor is not scoped to, yields `NONE` (a safe empty result, entity hiding). When
   * the filter is valid and in scope, the effective scope is just that warehouse.
   */
  private async narrowToWarehouse(
    actor: AuthPrincipal,
    scope: WarehouseScope,
    warehousePublicId: string | undefined,
  ): Promise<ResolvedScope> {
    if (!warehousePublicId) return scope;
    const wh = await this.repo.findActiveWarehouse(actor.companyId, warehousePublicId);
    if (!wh) return 'NONE';
    if (!scope.global && !scope.warehouseIds.includes(wh.id)) return 'NONE';
    return { global: false, warehouseIds: [wh.id] };
  }
}

// --- pure helpers -----------------------------------------------------------

function toMoneyViews(rows: CurrencyTotalRow[]): MoneyView[] {
  return rows.map((r) => ({ amount: r.total, currency: r.currency }));
}

function toCreditNoteMoneyViews(rows: CreditNoteCurrencyRow[]): MoneyView[] {
  return rows.map((r) => ({ amount: r.total, currency: r.currency }));
}

function toInventoryRowView(row: InventoryAggRow): InventoryReportRowView {
  return {
    productId: row.productId,
    sku: row.sku,
    name: row.name,
    warehouseId: row.warehouseId,
    onHand: row.onHand,
    reserved: row.reserved,
    available: row.available,
    criticalStockThreshold: row.criticalStockThreshold,
    isLowStock: row.isLowStock,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function emptyInventory(): InventoryReportView {
  return { data: [], pageInfo: { nextCursor: null, hasNextPage: false } };
}

function emptyReturns(): ReturnsReportView {
  return {
    returnCount: 0,
    requestedCount: 0,
    approvedCount: 0,
    totalReturnedQuantity: '0',
    creditNoteCount: 0,
    creditNoteTotalAmount: [],
  };
}

/** UTC midnight of a date's calendar day. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Parse `dateFrom`/`dateTo` as UTC calendar days and return the half-open range
 * `[fromInclusive, toExclusive)` covering both endpoints inclusively (the whole
 * `dateTo` day is included). An unparseable value or `dateFrom` after `dateTo` is
 * a 400 (RFC 7807 problem+json via the global filter).
 */
function parseUtcDayRange(
  dateFrom: string,
  dateTo: string,
): { fromInclusive: Date; toExclusive: Date } {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException('dateFrom and dateTo must be valid ISO-8601 dates');
  }
  const fromInclusive = utcMidnight(from);
  const toExclusive = new Date(utcMidnight(to).getTime() + MS_PER_DAY);
  if (fromInclusive.getTime() >= toExclusive.getTime()) {
    throw new BadRequestException('dateFrom must be on or before dateTo');
  }
  return { fromInclusive, toExclusive };
}

/** Opaque inventory-report cursor = base64url of `ir:<lastBalanceId>`. */
function encodeCursor(id: bigint): string {
  return Buffer.from(`ir:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^ir:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
