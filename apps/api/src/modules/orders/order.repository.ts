import { Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** A customer resolved as an ACTIVE (not soft-deleted) row inside a company. */
export interface ResolvedCustomer {
  id: bigint;
  publicId: string;
}

/** A warehouse resolved as an ACTIVE row inside a company. */
export interface ResolvedWarehouse {
  id: bigint;
  publicId: string;
}

/**
 * A product resolved as an ACTIVE row inside a company, carrying the SERVER price
 * inputs (Order Draft Foundation / ORDER_RULES §2a): the line unit price, tax rate
 * and currency are taken from here — never from the client.
 */
export interface ResolvedProduct {
  id: bigint;
  publicId: string;
  sku: string;
  name: string;
  listPriceAmount: bigint;
  currency: string;
  taxRateBp: number;
}

/** Internal joined order-item row (never returned directly — mapped to a view). */
export interface OrderItemRow {
  productSku: string;
  productName: string;
  quantity: bigint;
  unitPriceAmount: bigint;
  taxRateBp: number;
  lineSubtotalAmount: bigint;
  lineTaxAmount: bigint;
  lineTotalAmount: bigint;
  product: { publicId: string };
}

/** Internal joined order row (never returned directly — mapped to a view). Carries
 * the internal `warehouseId` so the service can re-check warehouse scope. */
export interface OrderRow {
  id: bigint;
  publicId: string;
  orderNo: string;
  warehouseId: bigint;
  status: string;
  currency: string;
  subtotalAmount: bigint;
  taxAmount: bigint;
  grandTotalAmount: bigint;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  customer: { publicId: string };
  warehouse: { publicId: string };
  items: OrderItemRow[];
}

/** A computed order line ready to persist (totals already calculated server-side). */
export interface OrderItemWriteData {
  productId: bigint;
  productSku: string;
  productName: string;
  quantity: bigint;
  listPriceAmount: bigint;
  unitPriceAmount: bigint;
  taxRateBp: number;
  lineSubtotalAmount: bigint;
  lineTaxAmount: bigint;
  lineTotalAmount: bigint;
}

const ITEM_SELECT = {
  productSku: true,
  productName: true,
  quantity: true,
  unitPriceAmount: true,
  taxRateBp: true,
  lineSubtotalAmount: true,
  lineTaxAmount: true,
  lineTotalAmount: true,
  product: { select: { publicId: true } },
} as const;

const ORDER_SELECT = {
  id: true,
  publicId: true,
  orderNo: true,
  warehouseId: true,
  status: true,
  currency: true,
  subtotalAmount: true,
  taxAmount: true,
  grandTotalAmount: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  cancelledAt: true,
  customer: { select: { publicId: true } },
  warehouse: { select: { publicId: true } },
  items: { select: ITEM_SELECT, orderBy: { id: 'asc' } },
} as const;

export interface ListOrdersOptions {
  /** Exclusive lower-bound id (rows with id > cursorId), for cursor pagination. */
  cursorId?: bigint;
  /** Number of rows to fetch (callers pass limit+1 to detect a next page). */
  take: number;
  /** Restrict to these warehouse ids (the actor's explicit scope). `undefined`
   * means no id restriction (global scope); an EMPTY set yields no rows. */
  onlyIds?: ReadonlySet<bigint>;
  /** Optional single-warehouse filter (already scope-checked by the caller). */
  warehouseId?: bigint;
  /** Optional status filter (whitelisted by the query DTO). */
  status?: string;
}

/**
 * Data access for the `orders` + `order_items` tables (Order Draft Foundation,
 * MODULE_BOUNDARIES §2). Every method takes an explicit executor so it composes
 * inside the caller's transaction, and every read/write is scoped to a `companyId`
 * — tenant isolation is enforced here as well as by the DB composite FKs, so one
 * company can never read or mutate another's orders. Orders are never soft-deleted
 * (CLAUDE rule 6): cancellation is a status transition, so reads do NOT filter on
 * a `deleted_at`.
 */
@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Resolve an ACTIVE (not soft-deleted) customer by public id WITHIN a company. */
  async findActiveCustomer(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<ResolvedCustomer | null> {
    return this.db(executor).customer.findFirst({
      where: { publicId, companyId, deletedAt: null },
      select: { id: true, publicId: true },
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

  /** Resolve an ACTIVE (is_active, not soft-deleted) product within a company,
   * including the server price inputs (list price, currency, tax rate). */
  async findActiveProduct(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<ResolvedProduct | null> {
    return this.db(executor).product.findFirst({
      where: { publicId, companyId, isActive: true, deletedAt: null },
      select: {
        id: true,
        publicId: true,
        sku: true,
        name: true,
        listPriceAmount: true,
        currency: true,
        taxRateBp: true,
      },
    });
  }

  /** Find an order by public id WITHIN a company (tenant isolation: a cross-tenant
   * id yields null → the service maps that to a 404, hiding existence). */
  async findByPublicId(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<OrderRow | null> {
    return this.db(executor).order.findFirst({
      where: { publicId, companyId },
      select: ORDER_SELECT,
    });
  }

  /** A page of orders for a company (ordered by id asc; cursor-friendly),
   * intersected with the actor's warehouse scope. */
  async list(companyId: bigint, opts: ListOrdersOptions, executor?: DbClient): Promise<OrderRow[]> {
    const where: Prisma.OrderWhereInput = { companyId };
    if (opts.cursorId !== undefined) where.id = { gt: opts.cursorId };
    if (opts.status !== undefined) where.status = opts.status as Prisma.OrderWhereInput['status'];
    if (opts.warehouseId !== undefined) {
      where.warehouseId = opts.warehouseId;
    } else if (opts.onlyIds !== undefined) {
      where.warehouseId = { in: [...opts.onlyIds] };
    }
    return this.db(executor).order.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
      select: ORDER_SELECT,
    });
  }

  /**
   * Insert one order with its lines + computed totals (caller's transaction). The
   * lines are written in a SEPARATE top-level `createMany` rather than a nested
   * create: `order_items.company_id` participates in BOTH the order and product
   * composite FKs, so Prisma excludes it from the nested-item input (the parent
   * would own it). A top-level create accepts the scalar FKs directly.
   */
  async createOrder(
    tx: DbClient,
    data: {
      orderNo: string;
      companyId: bigint;
      customerId: bigint;
      warehouseId: bigint;
      currency: string;
      subtotalAmount: bigint;
      taxAmount: bigint;
      grandTotalAmount: bigint;
      notes: string | null;
      createdById: bigint;
      items: OrderItemWriteData[];
    },
  ): Promise<OrderRow> {
    const order = await tx.order.create({
      data: {
        orderNo: data.orderNo,
        companyId: data.companyId,
        customerId: data.customerId,
        warehouseId: data.warehouseId,
        status: 'DRAFT',
        currency: data.currency,
        subtotalAmount: data.subtotalAmount,
        taxAmount: data.taxAmount,
        grandTotalAmount: data.grandTotalAmount,
        notes: data.notes,
        createdById: data.createdById,
      },
      select: { id: true },
    });
    await this.insertItems(tx, order.id, data.companyId, data.items);
    return this.findById(tx, order.id);
  }

  /**
   * Update a DRAFT order's scalar fields and (optionally) REPLACE all of its lines.
   * When `items` is provided the existing lines are deleted and the new computed
   * lines inserted (the PATCH replaces the whole draft content — task rule 21).
   * Runs in the caller's transaction.
   *
   * The scalar write is an EXPECTED-STATUS conditional update (`updateMany` keyed by
   * `{ id, status: 'DRAFT' }`), exactly like {@link cancelIfDraft}. The matching
   * `UPDATE` takes a row lock, so a concurrent cancel cannot slip a DRAFT→CANCELLED
   * transition in between a pre-check and this write: if the row is no longer DRAFT
   * (e.g. a concurrent cancel committed first) the update affects 0 rows and we
   * return `null` WITHOUT deleting/replacing any lines — the caller maps that to a
   * 409 and the transaction rolls back. This keeps the DRAFT-only update invariant
   * atomic with the line replacement (CLAUDE rule 15 / ORDER_RULES §1a).
   */
  async updateOrder(
    tx: DbClient,
    id: bigint,
    companyId: bigint,
    data: {
      customerId?: bigint;
      warehouseId?: bigint;
      currency?: string;
      subtotalAmount?: bigint;
      taxAmount?: bigint;
      grandTotalAmount?: bigint;
      notes?: string | null;
      items?: OrderItemWriteData[];
    },
  ): Promise<OrderRow | null> {
    const result = await tx.order.updateMany({
      where: { id, status: 'DRAFT' },
      data: {
        customerId: data.customerId,
        warehouseId: data.warehouseId,
        currency: data.currency,
        subtotalAmount: data.subtotalAmount,
        taxAmount: data.taxAmount,
        grandTotalAmount: data.grandTotalAmount,
        notes: data.notes,
      },
    });
    if (result.count === 0) return null; // no longer DRAFT (concurrent transition) → caller 409s.
    if (data.items !== undefined) {
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      await this.insertItems(tx, id, companyId, data.items);
    }
    return this.findById(tx, id);
  }

  /** Insert the computed lines for an order (top-level createMany; see createOrder). */
  private async insertItems(
    tx: DbClient,
    orderId: bigint,
    companyId: bigint,
    items: OrderItemWriteData[],
  ): Promise<void> {
    await tx.orderItem.createMany({
      data: items.map((i) => ({ orderId, companyId, ...i })),
    });
  }

  /** Transition a DRAFT order to CANCELLED with an expected-status conditional
   * update (status='DRAFT'); returns the number of affected rows (0 ⇒ a concurrent
   * transition already moved it). Caller's transaction. */
  async cancelIfDraft(tx: DbClient, id: bigint, at: Date): Promise<number> {
    const result = await tx.order.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'CANCELLED', cancelledAt: at },
    });
    return result.count;
  }

  /** Re-read an order by internal id (post-transition projection). */
  async findById(tx: DbClient, id: bigint): Promise<OrderRow> {
    return tx.order.findUniqueOrThrow({ where: { id }, select: ORDER_SELECT });
  }

  /** Append an immutable order_status_history row (append-only DB trigger). */
  async insertStatusHistory(
    tx: DbClient,
    data: {
      orderId: bigint;
      fromStatus: 'DRAFT' | 'CANCELLED' | null;
      toStatus: 'DRAFT' | 'CANCELLED';
      changedById: bigint;
      reason: string | null;
    },
  ): Promise<void> {
    await tx.orderStatusHistory.create({
      data: {
        orderId: data.orderId,
        fromStatus: data.fromStatus,
        toStatus: data.toStatus,
        changedById: data.changedById,
        reason: data.reason,
      },
    });
  }
}
