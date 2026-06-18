import { Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** Internal joined invoice-item row (never returned directly — mapped to a view). */
export interface InvoiceItemRow {
  description: string;
  quantity: bigint;
  unitPriceAmount: bigint;
  taxRateBp: number;
  lineSubtotalAmount: bigint;
  lineTaxAmount: bigint;
  lineTotalAmount: bigint;
  product: { publicId: string } | null;
}

/** Internal joined invoice row (never returned directly — mapped to a view).
 * Carries the internal `warehouseId` (scope checks) and `idempotencyKey`/`orderId`
 * (idempotency replay) which never cross the public contract boundary. */
export interface InvoiceRow {
  id: bigint;
  publicId: string;
  invoiceNo: string | null;
  invoiceNumber: bigint | null;
  fiscalYear: number | null;
  status: string;
  currency: string;
  subtotalAmount: bigint;
  taxAmount: bigint;
  grandTotalAmount: bigint;
  issuedAt: Date | null;
  createdAt: Date;
  idempotencyKey: string | null;
  orderId: bigint | null;
  warehouseId: bigint | null;
  order: { publicId: string } | null;
  customer: { publicId: string };
  warehouse: { publicId: string } | null;
  series: { seriesCode: string } | null;
  items: InvoiceItemRow[];
}

/** One invoice line ready to persist (a frozen snapshot of an order line). */
export interface InvoiceItemWriteData {
  productId: bigint | null;
  orderItemId: bigint | null;
  description: string;
  quantity: bigint;
  unitPriceAmount: bigint;
  taxRateBp: number;
  lineSubtotalAmount: bigint;
  lineTaxAmount: bigint;
  lineTotalAmount: bigint;
}

/** A locked invoice-series counter row (gapless number allocation). */
export interface LockedSeries {
  id: bigint;
  nextNumber: bigint;
  prefix: string;
}

const ITEM_SELECT = {
  description: true,
  quantity: true,
  unitPriceAmount: true,
  taxRateBp: true,
  lineSubtotalAmount: true,
  lineTaxAmount: true,
  lineTotalAmount: true,
  product: { select: { publicId: true } },
} as const;

const INVOICE_SELECT = {
  id: true,
  publicId: true,
  invoiceNo: true,
  invoiceNumber: true,
  fiscalYear: true,
  status: true,
  currency: true,
  subtotalAmount: true,
  taxAmount: true,
  grandTotalAmount: true,
  issuedAt: true,
  createdAt: true,
  idempotencyKey: true,
  orderId: true,
  warehouseId: true,
  order: { select: { publicId: true } },
  customer: { select: { publicId: true } },
  warehouse: { select: { publicId: true } },
  series: { select: { seriesCode: true } },
  items: { select: ITEM_SELECT, orderBy: { id: 'asc' } },
} as const;

export interface ListInvoicesOptions {
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
 * Data access for the `invoices` + `invoice_items` + `invoice_series` tables
 * (Invoice/Billing Foundation, MODULE_BOUNDARIES §2 — billing owns these). Every
 * method takes an explicit executor so it composes inside the caller's
 * transaction, and every read/write is scoped to a `companyId` — tenant isolation
 * is enforced here as well as by the DB FKs. Invoices are never deleted (CLAUDE
 * rule 6 / no_delete_invoices trigger).
 */
@Injectable()
export class InvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Find an invoice by its client idempotency key within a company (replay
   * lookup — the `(company_id, idempotency_key)` unique). */
  async findByKey(
    companyId: bigint,
    idempotencyKey: string,
    executor?: DbClient,
  ): Promise<InvoiceRow | null> {
    return this.db(executor).invoice.findUnique({
      where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
      select: INVOICE_SELECT,
    });
  }

  /** Find the ACTIVE (non-VOID) invoice for an order within a company, if any —
   * the duplicate-invoice guard (matches the `(company_id, order_id) WHERE
   * status <> 'VOID'` partial unique). */
  async findActiveByOrder(
    companyId: bigint,
    orderId: bigint,
    executor?: DbClient,
  ): Promise<InvoiceRow | null> {
    return this.db(executor).invoice.findFirst({
      where: { companyId, orderId, status: { not: 'VOID' } },
      select: INVOICE_SELECT,
    });
  }

  /** Find an invoice by public id WITHIN a company (tenant isolation: a
   * cross-tenant id yields null → the service maps that to a 404, hiding it). */
  async findByPublicId(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<InvoiceRow | null> {
    return this.db(executor).invoice.findFirst({
      where: { publicId, companyId },
      select: INVOICE_SELECT,
    });
  }

  /** A page of invoices for a company (ordered by id asc; cursor-friendly),
   * intersected with the actor's warehouse scope. */
  async list(
    companyId: bigint,
    opts: ListInvoicesOptions,
    executor?: DbClient,
  ): Promise<InvoiceRow[]> {
    const where: Prisma.InvoiceWhereInput = { companyId };
    if (opts.cursorId !== undefined) where.id = { gt: opts.cursorId };
    if (opts.status !== undefined) {
      where.status = opts.status as Prisma.InvoiceWhereInput['status'];
    }
    if (opts.warehouseId !== undefined) {
      where.warehouseId = opts.warehouseId;
    } else if (opts.onlyIds !== undefined) {
      where.warehouseId = { in: [...opts.onlyIds] };
    }
    return this.db(executor).invoice.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
      select: INVOICE_SELECT,
    });
  }

  /**
   * Ensure the (company, series, fiscal year) counter row exists and lock it FOR
   * UPDATE (ADR-006 / INVOICE_RULES §3). The INSERT … ON CONFLICT DO NOTHING is
   * concurrency-safe (a second tx no-ops), and the FOR UPDATE serialises every
   * concurrent number allocation on this series so numbers are gapless, unique
   * and monotonic. MUST run inside the caller's transaction (lock held to commit).
   */
  async lockSeriesForUpdate(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    seriesCode: string,
    fiscalYear: number,
    prefix: string,
  ): Promise<LockedSeries> {
    await tx.$executeRaw`
      INSERT INTO "invoice_series" ("company_id", "series_code", "fiscal_year", "prefix", "next_number", "version")
      VALUES (${companyId}, ${seriesCode}, ${fiscalYear}, ${prefix}, 1, 0)
      ON CONFLICT ("company_id", "series_code", "fiscal_year") DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ id: bigint; nextNumber: bigint; prefix: string }>>`
      SELECT "id", "next_number" AS "nextNumber", "prefix"
      FROM "invoice_series"
      WHERE "company_id" = ${companyId}
        AND "series_code" = ${seriesCode}
        AND "fiscal_year" = ${fiscalYear}
      FOR UPDATE`;
    const row = rows[0];
    if (!row) {
      // Unreachable: the INSERT … ON CONFLICT guarantees the row exists.
      throw new Error('invoice series row could not be locked');
    }
    return { id: row.id, nextNumber: row.nextNumber, prefix: row.prefix };
  }

  /** Advance the series counter (next_number += 1) AFTER a number is consumed.
   * If the surrounding transaction rolls back, this increment rolls back too, so
   * the number is NOT burned (gapless guarantee — INVOICE_RULES INVC-6). */
  async bumpSeries(tx: Prisma.TransactionClient, seriesId: bigint): Promise<void> {
    await tx.$executeRaw`
      UPDATE "invoice_series"
      SET "next_number" = "next_number" + 1, "version" = "version" + 1
      WHERE "id" = ${seriesId}`;
  }

  /** Insert one invoice header + its frozen line snapshot (caller's transaction). */
  async createInvoice(
    tx: DbClient,
    data: {
      companyId: bigint;
      seriesId: bigint;
      invoiceNumber: bigint;
      invoiceNo: string;
      fiscalYear: number;
      customerId: bigint;
      orderId: bigint;
      warehouseId: bigint;
      currency: string;
      subtotalAmount: bigint;
      taxAmount: bigint;
      grandTotalAmount: bigint;
      idempotencyKey: string;
      issuedAt: Date;
      createdById: bigint;
      items: InvoiceItemWriteData[];
    },
  ): Promise<InvoiceRow> {
    return tx.invoice.create({
      data: {
        companyId: data.companyId,
        seriesId: data.seriesId,
        invoiceNumber: data.invoiceNumber,
        invoiceNo: data.invoiceNo,
        fiscalYear: data.fiscalYear,
        docType: 'INVOICE',
        customerId: data.customerId,
        orderId: data.orderId,
        warehouseId: data.warehouseId,
        status: 'ISSUED',
        currency: data.currency,
        subtotalAmount: data.subtotalAmount,
        taxAmount: data.taxAmount,
        grandTotalAmount: data.grandTotalAmount,
        idempotencyKey: data.idempotencyKey,
        issuedAt: data.issuedAt,
        createdById: data.createdById,
        items: { create: data.items },
      },
      select: INVOICE_SELECT,
    });
  }

  /** Append an immutable invoice_status_history row (append-only DB trigger). */
  async insertStatusHistory(
    tx: DbClient,
    data: {
      invoiceId: bigint;
      fromStatus: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID' | null;
      toStatus: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
      changedById: bigint;
      reason: string | null;
    },
  ): Promise<void> {
    await tx.invoiceStatusHistory.create({
      data: {
        invoiceId: data.invoiceId,
        fromStatus: data.fromStatus,
        toStatus: data.toStatus,
        changedById: data.changedById,
        reason: data.reason,
      },
    });
  }
}
