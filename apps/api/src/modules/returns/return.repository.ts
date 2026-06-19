import { Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** Internal joined return-item row (never returned directly — mapped to a view).
 * Carries the internal `productId`/`orderItemId` so the idempotency replay can
 * compare the stored payload and the restock can bind the ledger movement. */
export interface ReturnItemRow {
  id: bigint;
  productId: bigint;
  orderItemId: bigint;
  quantity: bigint;
  reason: string | null;
  product: { publicId: string };
}

/** Internal joined return row (never returned directly — mapped to a view). Carries
 * the internal `orderId`/`warehouseId` (scope + restock) and the raw idempotency
 * keys (replay) which never cross the public contract boundary. */
export interface ReturnRow {
  id: bigint;
  publicId: string;
  returnNo: string;
  status: string;
  reason: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  idempotencyKey: string;
  approveIdempotencyKey: string | null;
  orderId: bigint;
  warehouseId: bigint;
  invoiceId: bigint | null;
  order: { publicId: string };
  customer: { publicId: string };
  warehouse: { publicId: string };
  invoice: { publicId: string } | null;
  items: ReturnItemRow[];
}

/** The canonical return status names (the enum literals in the Prisma schema). */
export type ReturnStatusName = 'DRAFT' | 'APPROVED' | 'RECEIVED' | 'REJECTED' | 'COMPLETED';

/** One return line ready to persist. */
export interface ReturnItemWriteData {
  orderItemId: bigint;
  productId: bigint;
  quantity: bigint;
  reason: string | null;
}

const ITEM_SELECT = {
  id: true,
  productId: true,
  orderItemId: true,
  quantity: true,
  reason: true,
  product: { select: { publicId: true } },
} as const;

const RETURN_SELECT = {
  id: true,
  publicId: true,
  returnNo: true,
  status: true,
  reason: true,
  createdAt: true,
  approvedAt: true,
  idempotencyKey: true,
  approveIdempotencyKey: true,
  orderId: true,
  warehouseId: true,
  invoiceId: true,
  order: { select: { publicId: true } },
  customer: { select: { publicId: true } },
  warehouse: { select: { publicId: true } },
  invoice: { select: { publicId: true } },
  items: { select: ITEM_SELECT, orderBy: { id: 'asc' } },
} as const;

export interface ListReturnsOptions {
  /** Exclusive lower-bound id (rows with id > cursorId), for cursor pagination. */
  cursorId?: bigint;
  /** Number of rows to fetch (callers pass limit+1 to detect a next page). */
  take: number;
  /** Restrict to these warehouse ids (the actor's explicit scope). `undefined`
   * means no id restriction (global scope); an EMPTY set yields no rows. */
  onlyIds?: ReadonlySet<bigint>;
  /** Optional status filter (whitelisted by the query DTO). */
  status?: string;
}

/**
 * Data access for the `returns` + `return_items` + `return_status_history` tables
 * (Return/Refund Foundation, MODULE_BOUNDARIES §2 — returns owns these). Every
 * method takes an explicit executor so it composes inside the caller's transaction,
 * and every read/write is scoped to a `companyId` — tenant isolation is enforced
 * here as well as by the DB composite FKs. Returns are never deleted (CLAUDE rule 6
 * / no_delete_returns trigger); they are managed by status transition.
 */
@Injectable()
export class ReturnRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Find a return by its client CREATE idempotency key within a company (replay
   * lookup — the `(company_id, idempotency_key)` unique). */
  async findByKey(
    companyId: bigint,
    idempotencyKey: string,
    executor?: DbClient,
  ): Promise<ReturnRow | null> {
    return this.db(executor).return.findUnique({
      where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
      select: RETURN_SELECT,
    });
  }

  /** Find a return by its client APPROVE idempotency key within a company (replay
   * lookup — the `(company_id, approve_idempotency_key)` unique). */
  async findByApproveKey(
    companyId: bigint,
    approveIdempotencyKey: string,
    executor?: DbClient,
  ): Promise<ReturnRow | null> {
    return this.db(executor).return.findUnique({
      where: { companyId_approveIdempotencyKey: { companyId, approveIdempotencyKey } },
      select: RETURN_SELECT,
    });
  }

  /** Find a return by public id WITHIN a company (tenant isolation: a cross-tenant
   * id yields null → the service maps that to a 404, hiding existence). */
  async findByPublicId(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<ReturnRow | null> {
    return this.db(executor).return.findFirst({
      where: { publicId, companyId },
      select: RETURN_SELECT,
    });
  }

  /** A page of returns for a company (ordered by id asc; cursor-friendly),
   * intersected with the actor's warehouse scope. */
  async list(
    companyId: bigint,
    opts: ListReturnsOptions,
    executor?: DbClient,
  ): Promise<ReturnRow[]> {
    const where: Prisma.ReturnWhereInput = { companyId };
    if (opts.cursorId !== undefined) where.id = { gt: opts.cursorId };
    if (opts.status !== undefined) {
      where.status = opts.status as Prisma.ReturnWhereInput['status'];
    }
    if (opts.onlyIds !== undefined) {
      where.warehouseId = { in: [...opts.onlyIds] };
    }
    return this.db(executor).return.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
      select: RETURN_SELECT,
    });
  }

  /**
   * Sum the already-claimed return quantity per ORDER LINE for an order, restricted
   * to returns in `statuses` (and optionally excluding one return). Used to enforce
   * "returned ≤ shipped" — at create against DRAFT+APPROVED claims, at approve
   * against the committed APPROVED claims of OTHER returns. Caller's transaction.
   */
  async sumReturnedByOrderItem(
    tx: DbClient,
    companyId: bigint,
    orderId: bigint,
    statuses: ReturnStatusName[],
    excludeReturnId?: bigint,
  ): Promise<Map<bigint, bigint>> {
    const grouped = await tx.returnItem.groupBy({
      by: ['orderItemId'],
      where: {
        companyId,
        return: {
          orderId,
          status: { in: statuses },
          ...(excludeReturnId !== undefined ? { id: { not: excludeReturnId } } : {}),
        },
      },
      _sum: { quantity: true },
    });
    const map = new Map<bigint, bigint>();
    for (const g of grouped) {
      map.set(g.orderItemId, g._sum.quantity ?? 0n);
    }
    return map;
  }

  /** Insert one return header + its line snapshot (caller's transaction). The lines
   * are written in a SEPARATE top-level `createMany`: `return_items.company_id`
   * participates in BOTH the return and product composite FKs, so a top-level create
   * accepts the scalar FKs directly (mirrors orders.createOrder). */
  async createReturn(
    tx: DbClient,
    data: {
      returnNo: string;
      companyId: bigint;
      orderId: bigint;
      customerId: bigint;
      warehouseId: bigint;
      invoiceId: bigint | null;
      reason: string | null;
      idempotencyKey: string;
      createdById: bigint;
      items: ReturnItemWriteData[];
    },
  ): Promise<ReturnRow> {
    const created = await tx.return.create({
      data: {
        returnNo: data.returnNo,
        companyId: data.companyId,
        orderId: data.orderId,
        customerId: data.customerId,
        warehouseId: data.warehouseId,
        invoiceId: data.invoiceId,
        status: 'DRAFT',
        reason: data.reason,
        idempotencyKey: data.idempotencyKey,
        createdById: data.createdById,
      },
      select: { id: true },
    });
    await tx.returnItem.createMany({
      data: data.items.map((i) => ({
        returnId: created.id,
        companyId: data.companyId,
        orderItemId: i.orderItemId,
        productId: i.productId,
        quantity: i.quantity,
        // This foundation restocks every returned line on approval; record the line
        // as RESELLABLE + restock so the stored data matches the stock effect
        // (condition/damage handling is a later task — RETURN_RULES §3).
        condition: 'RESELLABLE' as const,
        restock: true,
        reason: i.reason,
      })),
    });
    return this.findById(tx, created.id);
  }

  /**
   * Lock the return row FOR UPDATE and return its current status (the approve
   * transaction takes this row lock to serialise concurrent approvals on the same
   * return — a duplicate approval is rejected by the conditional transition + the
   * RETURN_IN ledger key unique). Returns null only if the row vanished. MUST run
   * inside the caller's transaction (lock held to commit).
   */
  async lockReturnForUpdate(
    tx: Prisma.TransactionClient,
    id: bigint,
  ): Promise<{ status: string } | null> {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS status FROM "returns" WHERE "id" = ${id} FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Transition a DRAFT return to APPROVED with an expected-status conditional
   * update (status='DRAFT'); sets approved_by/approved_at + the approve idempotency
   * key. Returns the number of affected rows (0 ⇒ a concurrent transition already
   * moved it → caller 409s). Caller's transaction. */
  async approveIfDraft(
    tx: DbClient,
    id: bigint,
    approvedById: bigint,
    approveIdempotencyKey: string,
    at: Date,
  ): Promise<number> {
    const result = await tx.return.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'APPROVED', approvedById, approvedAt: at, approveIdempotencyKey },
    });
    return result.count;
  }

  /** Re-read a return by internal id (post-transition projection). */
  async findById(tx: DbClient, id: bigint): Promise<ReturnRow> {
    return tx.return.findUniqueOrThrow({ where: { id }, select: RETURN_SELECT });
  }

  /** Append an immutable return_status_history row (append-only DB trigger). */
  async insertStatusHistory(
    tx: DbClient,
    data: {
      returnId: bigint;
      fromStatus: 'DRAFT' | 'APPROVED' | 'RECEIVED' | 'REJECTED' | 'COMPLETED' | null;
      toStatus: 'DRAFT' | 'APPROVED' | 'RECEIVED' | 'REJECTED' | 'COMPLETED';
      changedById: bigint;
      reason: string | null;
    },
  ): Promise<void> {
    await tx.returnStatusHistory.create({
      data: {
        returnId: data.returnId,
        fromStatus: data.fromStatus,
        toStatus: data.toStatus,
        changedById: data.changedById,
        reason: data.reason,
      },
    });
  }
}
