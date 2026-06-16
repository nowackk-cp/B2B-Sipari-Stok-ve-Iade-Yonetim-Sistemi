import { Injectable } from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** A product resolved as an ACTIVE row inside a company (tenant + lifecycle). */
export interface ResolvedProduct {
  id: bigint;
  publicId: string;
  sku: string;
  name: string;
}

/** A warehouse resolved as an ACTIVE row inside a company. */
export interface ResolvedWarehouse {
  id: bigint;
  publicId: string;
}

/** Internal joined balance row (never returned directly — mapped to a view). */
export interface BalanceRow {
  id: bigint;
  onHand: bigint;
  reserved: bigint;
  updatedAt: Date;
  product: { publicId: string; sku: string; name: string };
  warehouse: { publicId: string };
}

/** Internal joined movement (ledger) row. Carries the internal product/warehouse
 * ids too so the idempotency replay can compare the stored payload. */
export interface MovementRow {
  id: bigint;
  productId: bigint;
  warehouseId: bigint;
  changeType: string;
  quantity: bigint;
  balanceAfter: bigint;
  reason: string | null;
  createdAt: Date;
  product: { publicId: string; sku: string; name: string };
  warehouse: { publicId: string };
}

export interface ListBalancesOptions {
  cursorId?: bigint;
  take: number;
  /** Restrict to these warehouse ids (the actor's explicit scope). `undefined`
   * means no id restriction (global scope); an EMPTY set yields no rows. */
  onlyIds?: ReadonlySet<bigint>;
  /** Optional single-warehouse filter (already scope-checked by the caller). */
  warehouseId?: bigint;
  /** Optional single-product filter. */
  productId?: bigint;
}

export type ListMovementsOptions = ListBalancesOptions;

const MOVEMENT_INCLUDE = {
  product: { select: { publicId: true, sku: true, name: true } },
  warehouse: { select: { publicId: true } },
} as const;

/**
 * Data access for the inventory core tables `stock_balances` (mutable derived
 * state) and `stock_ledger` (immutable append-only movements). Every method
 * takes an explicit executor so it composes inside the caller's transaction
 * (MODULE_BOUNDARIES §1, DATABASE_DESIGN §18 — repositories never open their own
 * transaction). Tenant isolation is enforced by resolving product/warehouse
 * WITHIN a company and by filtering every read through both relations' company.
 */
@Injectable()
export class StockRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Resolve an ACTIVE (is_active, not soft-deleted) product within a company. */
  async findActiveProduct(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<ResolvedProduct | null> {
    return this.db(executor).product.findFirst({
      where: { publicId, companyId, isActive: true, deletedAt: null },
      select: { id: true, publicId: true, sku: true, name: true },
    });
  }

  /** Resolve an ACTIVE (is_active, not soft-deleted) warehouse within a company. */
  async findActiveWarehouse(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<ResolvedWarehouse | null> {
    return this.db(executor).warehouse.findFirst({
      where: { publicId, companyId, isActive: true, deletedAt: null },
      select: { id: true, publicId: true },
    });
  }

  /** Find an existing movement by its ledger idempotency key (replay lookup). */
  async findMovementByKey(
    idempotencyKey: string,
    executor?: DbClient,
  ): Promise<MovementRow | null> {
    return this.db(executor).stockLedger.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        productId: true,
        warehouseId: true,
        changeType: true,
        quantity: true,
        balanceAfter: true,
        reason: true,
        createdAt: true,
        ...MOVEMENT_INCLUDE,
      },
    });
  }

  /**
   * Ensure the (product, warehouse) balance row exists and LOCK it FOR UPDATE,
   * returning the current on_hand. The lazy upsert (`ON CONFLICT DO NOTHING`)
   * makes two concurrent first-adjustments converge on a single balance row
   * (A-13); the row lock then serialises every concurrent adjustment so reads of
   * on_hand can never interleave — no lost update, no negative race.
   *
   * MUST run inside the caller's transaction (the lock is held until commit).
   */
  async lockBalanceOnHand(
    tx: Prisma.TransactionClient,
    productId: bigint,
    warehouseId: bigint,
  ): Promise<bigint> {
    await tx.$executeRaw`
      INSERT INTO "stock_balances" ("product_id", "warehouse_id", "on_hand", "reserved", "updated_at")
      VALUES (${productId}, ${warehouseId}, 0, 0, now())
      ON CONFLICT ("product_id", "warehouse_id") DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ on_hand: bigint }>>`
      SELECT "on_hand" FROM "stock_balances"
      WHERE "product_id" = ${productId} AND "warehouse_id" = ${warehouseId}
      FOR UPDATE`;
    // The upsert guarantees exactly one row exists before the locking select.
    return rows[0]!.on_hand;
  }

  /** Set the locked balance's on_hand to its new value (row already FOR UPDATE).
   * `updated_at` is maintained by the DB trigger; `version` bumps for the
   * optional optimistic-control column. */
  async setBalanceOnHand(
    tx: Prisma.TransactionClient,
    productId: bigint,
    warehouseId: bigint,
    onHand: bigint,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "stock_balances"
      SET "on_hand" = ${onHand}, "version" = "version" + 1
      WHERE "product_id" = ${productId} AND "warehouse_id" = ${warehouseId}`;
  }

  /** Append one immutable ADJUSTMENT movement to the ledger. The unique
   * idempotency key is the row-level safety net against a duplicate movement. */
  async insertAdjustmentMovement(
    tx: Prisma.TransactionClient,
    data: {
      productId: bigint;
      warehouseId: bigint;
      quantitySigned: bigint;
      balanceAfter: bigint;
      idempotencyKey: string;
      reason: string;
      createdById: bigint;
    },
  ): Promise<MovementRow> {
    return tx.stockLedger.create({
      data: {
        productId: data.productId,
        warehouseId: data.warehouseId,
        changeType: 'ADJUSTMENT',
        quantity: data.quantitySigned,
        balanceAfter: data.balanceAfter,
        referenceType: 'ADJUSTMENT',
        idempotencyKey: data.idempotencyKey,
        reason: data.reason,
        createdById: data.createdById,
      },
      select: {
        id: true,
        productId: true,
        warehouseId: true,
        changeType: true,
        quantity: true,
        balanceAfter: true,
        reason: true,
        createdAt: true,
        ...MOVEMENT_INCLUDE,
      },
    });
  }

  /** A page of balances for a company (ordered by id asc; cursor-friendly).
   * Both relations are filtered to the company and to non-deleted rows. */
  async listBalances(
    companyId: bigint,
    opts: ListBalancesOptions,
    executor?: DbClient,
  ): Promise<BalanceRow[]> {
    const scope = this.scopeFilters(companyId, opts);
    return this.db(executor).stockBalance.findMany({
      where: {
        product: scope.product,
        warehouse: scope.warehouse,
        ...(scope.id ? { id: scope.id } : {}),
        ...(scope.warehouseId !== undefined ? { warehouseId: scope.warehouseId } : {}),
        ...(scope.productId !== undefined ? { productId: scope.productId } : {}),
      },
      orderBy: { id: 'asc' },
      take: opts.take,
      select: {
        id: true,
        onHand: true,
        reserved: true,
        updatedAt: true,
        ...MOVEMENT_INCLUDE,
      },
    });
  }

  /** A page of movements for a company (ordered by id asc; cursor needs a stable
   * ascending key). */
  async listMovements(
    companyId: bigint,
    opts: ListMovementsOptions,
    executor?: DbClient,
  ): Promise<MovementRow[]> {
    const scope = this.scopeFilters(companyId, opts);
    return this.db(executor).stockLedger.findMany({
      where: {
        product: scope.product,
        warehouse: scope.warehouse,
        ...(scope.id ? { id: scope.id } : {}),
        ...(scope.warehouseId !== undefined ? { warehouseId: scope.warehouseId } : {}),
        ...(scope.productId !== undefined ? { productId: scope.productId } : {}),
      },
      orderBy: { id: 'asc' },
      take: opts.take,
      select: {
        id: true,
        productId: true,
        warehouseId: true,
        changeType: true,
        quantity: true,
        balanceAfter: true,
        reason: true,
        createdAt: true,
        ...MOVEMENT_INCLUDE,
      },
    });
  }

  /**
   * Tenant-isolated + scope-intersected filter pieces shared by the balances and
   * movements lists (both `stock_balances` and `stock_ledger` carry `product_id`,
   * `warehouse_id` columns and the product/warehouse relations).
   */
  private scopeFilters(
    companyId: bigint,
    opts: ListBalancesOptions,
  ): {
    product: { companyId: bigint; deletedAt: null };
    warehouse: { companyId: bigint; deletedAt: null };
    id?: Prisma.BigIntFilter;
    warehouseId?: bigint | Prisma.BigIntFilter;
    productId?: bigint;
  } {
    // Warehouse-scope intersection: a single-warehouse filter takes precedence
    // (already scope-checked); otherwise restrict to the explicit scope set when
    // the actor is not global. An empty set yields `IN ()` → no rows.
    let warehouseId: bigint | Prisma.BigIntFilter | undefined;
    if (opts.warehouseId !== undefined) {
      warehouseId = opts.warehouseId;
    } else if (opts.onlyIds !== undefined) {
      warehouseId = { in: [...opts.onlyIds] };
    }
    return {
      // Tenant isolation: both ends must belong to the actor's company and must
      // not be soft-deleted. A forged company claim cannot widen this.
      product: { companyId, deletedAt: null },
      warehouse: { companyId, deletedAt: null },
      ...(opts.cursorId !== undefined ? { id: { gt: opts.cursorId } } : {}),
      ...(warehouseId !== undefined ? { warehouseId } : {}),
      ...(opts.productId !== undefined ? { productId: opts.productId } : {}),
    };
  }
}
