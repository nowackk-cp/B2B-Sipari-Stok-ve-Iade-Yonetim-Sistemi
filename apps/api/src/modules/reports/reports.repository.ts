import { Injectable } from '@nestjs/common';
import { Prisma } from '@b2b/database';
import { PrismaService } from '../../common/database/prisma.service';

/**
 * Caller's warehouse-access envelope, already resolved from PostgreSQL by
 * {@link ReportsService}. `global` means `warehouse:scope:all` (the whole
 * company); otherwise the read is restricted to `warehouseIds` (guaranteed
 * NON-EMPTY by the service — a no-scope actor is short-circuited to zero/empty
 * before any query runs, so the SQL never emits an empty `IN ()`).
 */
export type WarehouseScope = { global: true } | { global: false; warehouseIds: bigint[] };

/** A resolved active warehouse (public id → internal id) within a company. */
export interface ResolvedWarehouseRef {
  id: bigint;
  publicId: string;
}

/** One currency-grouped money aggregate from a raw query. */
export interface CurrencyTotalRow {
  currency: string;
  total: string;
}

/** One credit-note currency bucket (count + total). */
export interface CreditNoteCurrencyRow {
  currency: string;
  cnt: number;
  total: string;
}

/** One raw sales-report bucket (period × currency). */
export interface SalesAggRow {
  period: string;
  invoiceCount: number;
  subtotalAmount: string;
  vatAmount: string;
  totalAmount: string;
  currency: string;
}

/** One raw inventory-report row (carries the internal balance id for the cursor). */
export interface InventoryAggRow {
  id: bigint;
  productId: string;
  sku: string;
  name: string;
  warehouseId: string;
  onHand: string;
  reserved: string;
  available: string;
  criticalStockThreshold: string | null;
  isLowStock: boolean;
}

export interface InventoryReportOptions {
  take: number;
  cursorId?: bigint;
  /** Internal warehouse id (already scope-checked by the caller). */
  warehouseId?: bigint;
  lowStockOnly?: boolean;
  search?: string;
}

/**
 * Read-only aggregate data access for the dashboard / reports surface
 * (MODULE_BOUNDARIES M19 — the dashboard is an "aggregate read" module that owns
 * NO tables). It only ever READS the catalog, customer, order, inventory, invoice,
 * return and credit-note tables and writes nothing. Every query is filtered by the
 * caller's company (tenant isolation, never a JWT claim) and — for the
 * warehouse-bound figures — intersected with the caller's warehouse scope.
 *
 * Cross-column comparisons (`on_hand − reserved ≤ critical_stock_threshold`),
 * period bucketing and multi-currency grouping are not expressible through the
 * Prisma query builder, so they use parameterised raw SQL (`Prisma.sql` —
 * every value is a bound parameter; no string interpolation of user input).
 */
@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db() {
    return this.prisma.client;
  }

  /** Optional `warehouseId IN (...)` Prisma-builder fragment for a scope. */
  private scopeWhere(scope: WarehouseScope): { warehouseId?: { in: bigint[] } } {
    return scope.global ? {} : { warehouseId: { in: scope.warehouseIds } };
  }

  /** Optional `AND <col> IN (...)` raw fragment for a scope (col is a trusted literal). */
  private scopeSql(scope: WarehouseScope, column: Prisma.Sql): Prisma.Sql {
    return scope.global
      ? Prisma.empty
      : Prisma.sql`AND ${column} IN (${Prisma.join(scope.warehouseIds)})`;
  }

  /** Resolve an ACTIVE, non-deleted warehouse public id → internal id in a company. */
  async findActiveWarehouse(
    companyId: bigint,
    publicId: string,
  ): Promise<ResolvedWarehouseRef | null> {
    return this.db.warehouse.findFirst({
      where: { publicId, companyId, isActive: true, deletedAt: null },
      select: { id: true, publicId: true },
    });
  }

  // --- dashboard (company-wide master data) ---------------------------------

  async countProducts(companyId: bigint): Promise<{ total: number; active: number }> {
    const [total, active] = await Promise.all([
      this.db.product.count({ where: { companyId, deletedAt: null } }),
      this.db.product.count({ where: { companyId, deletedAt: null, isActive: true } }),
    ]);
    return { total, active };
  }

  async countCustomers(companyId: bigint): Promise<number> {
    return this.db.customer.count({ where: { companyId, deletedAt: null } });
  }

  // --- dashboard (warehouse-bound figures) ----------------------------------

  async countOrdersByStatus(
    companyId: bigint,
    scope: WarehouseScope,
  ): Promise<{ draft: number; approved: number; shipped: number }> {
    const where = { companyId, ...this.scopeWhere(scope) };
    const [draft, approved, shipped] = await Promise.all([
      this.db.order.count({ where: { ...where, status: 'DRAFT' } }),
      this.db.order.count({ where: { ...where, status: 'APPROVED' } }),
      this.db.order.count({ where: { ...where, status: 'SHIPPED' } }),
    ]);
    return { draft, approved, shipped };
  }

  async countIssuedInvoices(companyId: bigint, scope: WarehouseScope): Promise<number> {
    return this.db.invoice.count({
      where: { companyId, status: 'ISSUED', ...this.scopeWhere(scope) },
    });
  }

  async countReturnsByStatus(
    companyId: bigint,
    scope: WarehouseScope,
  ): Promise<{ requested: number; approved: number }> {
    const where = { companyId, ...this.scopeWhere(scope) };
    const [requested, approved] = await Promise.all([
      this.db.return.count({ where: { ...where, status: 'DRAFT' } }),
      this.db.return.count({ where: { ...where, status: 'APPROVED' } }),
    ]);
    return { requested, approved };
  }

  /** Count stock balances (in scope) at/below their product's critical threshold. */
  async countLowStock(companyId: bigint, scope: WarehouseScope): Promise<number> {
    const scopeSql = this.scopeSql(scope, Prisma.sql`sb."warehouse_id"`);
    const rows = await this.db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM "stock_balances" sb
      JOIN "products" p ON p."id" = sb."product_id"
      JOIN "warehouses" w ON w."id" = sb."warehouse_id"
      WHERE p."company_id" = ${companyId}
        AND w."company_id" = ${companyId}
        AND p."deleted_at" IS NULL
        AND w."deleted_at" IS NULL
        AND p."critical_stock_threshold" IS NOT NULL
        AND (sb."on_hand" - sb."reserved") <= p."critical_stock_threshold"
        ${scopeSql}`);
    return rows[0]?.count ?? 0;
  }

  /** Σ ISSUED-invoice grand totals in [fromInclusive, toExclusive), by currency. */
  async sumIssuedSalesByCurrency(
    companyId: bigint,
    scope: WarehouseScope,
    fromInclusive: Date,
    toExclusive: Date,
  ): Promise<CurrencyTotalRow[]> {
    const scopeSql = this.scopeSql(scope, Prisma.sql`i."warehouse_id"`);
    return this.db.$queryRaw<CurrencyTotalRow[]>(Prisma.sql`
      SELECT i."currency" AS "currency",
             COALESCE(SUM(i."grand_total_amount"), 0)::text AS "total"
      FROM "invoices" i
      WHERE i."company_id" = ${companyId}
        AND i."status" = 'ISSUED'
        AND i."issued_at" >= ${fromInclusive}
        AND i."issued_at" < ${toExclusive}
        ${scopeSql}
      GROUP BY i."currency"
      ORDER BY i."currency" ASC`);
  }

  // --- sales report ---------------------------------------------------------

  async salesReport(
    companyId: bigint,
    scope: WarehouseScope,
    fromInclusive: Date,
    toExclusive: Date,
    groupBy: 'day' | 'month',
  ): Promise<SalesAggRow[]> {
    const trunc = groupBy === 'month' ? 'month' : 'day';
    const fmt = groupBy === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
    const scopeSql = this.scopeSql(scope, Prisma.sql`i."warehouse_id"`);
    return this.db.$queryRaw<SalesAggRow[]>(Prisma.sql`
      SELECT to_char(date_trunc(${trunc}, i."issued_at" AT TIME ZONE 'UTC'), ${fmt}) AS "period",
             COUNT(*)::int AS "invoiceCount",
             COALESCE(SUM(i."subtotal_amount"), 0)::text AS "subtotalAmount",
             COALESCE(SUM(i."tax_amount"), 0)::text AS "vatAmount",
             COALESCE(SUM(i."grand_total_amount"), 0)::text AS "totalAmount",
             i."currency" AS "currency"
      FROM "invoices" i
      WHERE i."company_id" = ${companyId}
        AND i."status" = 'ISSUED'
        AND i."issued_at" >= ${fromInclusive}
        AND i."issued_at" < ${toExclusive}
        ${scopeSql}
      GROUP BY "period", i."currency"
      ORDER BY "period" ASC, i."currency" ASC`);
  }

  // --- inventory report -----------------------------------------------------

  async inventoryReport(
    companyId: bigint,
    scope: WarehouseScope,
    opts: InventoryReportOptions,
  ): Promise<InventoryAggRow[]> {
    const scopeSql = this.scopeSql(scope, Prisma.sql`sb."warehouse_id"`);
    const warehouseSql =
      opts.warehouseId !== undefined
        ? Prisma.sql`AND sb."warehouse_id" = ${opts.warehouseId}`
        : Prisma.empty;
    const searchSql = opts.search
      ? Prisma.sql`AND (p."name" ILIKE ${`%${opts.search}%`} OR p."sku" ILIKE ${`%${opts.search}%`})`
      : Prisma.empty;
    const lowSql = opts.lowStockOnly
      ? Prisma.sql`AND p."critical_stock_threshold" IS NOT NULL AND (sb."on_hand" - sb."reserved") <= p."critical_stock_threshold"`
      : Prisma.empty;
    const cursorSql =
      opts.cursorId !== undefined ? Prisma.sql`AND sb."id" > ${opts.cursorId}` : Prisma.empty;
    return this.db.$queryRaw<InventoryAggRow[]>(Prisma.sql`
      SELECT sb."id" AS "id",
             p."public_id" AS "productId",
             p."sku" AS "sku",
             p."name" AS "name",
             w."public_id" AS "warehouseId",
             sb."on_hand"::text AS "onHand",
             sb."reserved"::text AS "reserved",
             (sb."on_hand" - sb."reserved")::text AS "available",
             p."critical_stock_threshold"::text AS "criticalStockThreshold",
             (p."critical_stock_threshold" IS NOT NULL
               AND (sb."on_hand" - sb."reserved") <= p."critical_stock_threshold") AS "isLowStock"
      FROM "stock_balances" sb
      JOIN "products" p ON p."id" = sb."product_id"
      JOIN "warehouses" w ON w."id" = sb."warehouse_id"
      WHERE p."company_id" = ${companyId}
        AND w."company_id" = ${companyId}
        AND p."deleted_at" IS NULL
        AND w."deleted_at" IS NULL
        ${scopeSql} ${warehouseSql} ${searchSql} ${lowSql} ${cursorSql}
      ORDER BY sb."id" ASC
      LIMIT ${opts.take}`);
  }

  // --- returns report -------------------------------------------------------

  async returnsAggregate(
    companyId: bigint,
    scope: WarehouseScope,
    fromInclusive: Date,
    toExclusive: Date,
    status: string | undefined,
  ): Promise<{
    counts: { returnCount: number; requestedCount: number; approvedCount: number };
    totalReturnedQuantity: string;
  }> {
    const scopeSql = this.scopeSql(scope, Prisma.sql`r."warehouse_id"`);
    const statusSql = status ? Prisma.sql`AND r."status"::text = ${status}` : Prisma.empty;

    const [countRows, qtyRows] = await Promise.all([
      this.db.$queryRaw<
        Array<{ returnCount: number; requestedCount: number; approvedCount: number }>
      >(Prisma.sql`
        SELECT COUNT(*)::int AS "returnCount",
               COUNT(*) FILTER (WHERE r."status"::text = 'DRAFT')::int AS "requestedCount",
               COUNT(*) FILTER (WHERE r."status"::text = 'APPROVED')::int AS "approvedCount"
        FROM "returns" r
        WHERE r."company_id" = ${companyId}
          AND r."created_at" >= ${fromInclusive}
          AND r."created_at" < ${toExclusive}
          ${scopeSql} ${statusSql}`),
      this.db.$queryRaw<Array<{ qty: string }>>(Prisma.sql`
        SELECT COALESCE(SUM(ri."quantity"), 0)::text AS "qty"
        FROM "return_items" ri
        JOIN "returns" r ON r."id" = ri."return_id"
        WHERE r."company_id" = ${companyId}
          AND r."created_at" >= ${fromInclusive}
          AND r."created_at" < ${toExclusive}
          ${scopeSql} ${statusSql}`),
    ]);

    const counts = countRows[0] ?? { returnCount: 0, requestedCount: 0, approvedCount: 0 };
    return { counts, totalReturnedQuantity: qtyRows[0]?.qty ?? '0' };
  }

  /** Credit notes (non-VOID) for in-range/scope returns, grouped by currency. */
  async creditNoteTotalsByCurrency(
    companyId: bigint,
    scope: WarehouseScope,
    fromInclusive: Date,
    toExclusive: Date,
    status: string | undefined,
  ): Promise<CreditNoteCurrencyRow[]> {
    const scopeSql = this.scopeSql(scope, Prisma.sql`r."warehouse_id"`);
    const statusSql = status ? Prisma.sql`AND r."status"::text = ${status}` : Prisma.empty;
    return this.db.$queryRaw<CreditNoteCurrencyRow[]>(Prisma.sql`
      SELECT cn."currency" AS "currency",
             COUNT(*)::int AS "cnt",
             COALESCE(SUM(cn."grand_total_amount"), 0)::text AS "total"
      FROM "credit_notes" cn
      JOIN "returns" r ON r."id" = cn."return_id"
      WHERE cn."company_id" = ${companyId}
        AND cn."status"::text <> 'VOID'
        AND r."created_at" >= ${fromInclusive}
        AND r."created_at" < ${toExclusive}
        ${scopeSql} ${statusSql}
      GROUP BY cn."currency"
      ORDER BY cn."currency" ASC`);
  }
}
