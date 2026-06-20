import { Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** Internal joined credit-note-item row (never returned directly — mapped to a view). */
export interface CreditNoteItemRow {
  description: string;
  quantity: bigint;
  unitPriceAmount: bigint;
  taxRateBp: number;
  lineSubtotalAmount: bigint;
  lineTaxAmount: bigint;
  lineTotalAmount: bigint;
  product: { publicId: string };
}

/** Internal joined credit-note row (never returned directly — mapped to a view).
 * Carries the internal `warehouseId` (scope checks) and `idempotencyKey`/`returnId`
 * (idempotency replay) which never cross the public contract boundary. */
export interface CreditNoteRow {
  id: bigint;
  publicId: string;
  creditNoteNo: string;
  creditNoteNumber: bigint;
  fiscalYear: number;
  status: string;
  currency: string;
  subtotalAmount: bigint;
  taxAmount: bigint;
  grandTotalAmount: bigint;
  issuedAt: Date;
  createdAt: Date;
  idempotencyKey: string;
  returnId: bigint;
  warehouseId: bigint;
  return: { publicId: string };
  order: { publicId: string };
  originalInvoice: { publicId: string };
  customer: { publicId: string };
  warehouse: { publicId: string };
  series: { seriesCode: string };
  items: CreditNoteItemRow[];
}

/** One credit-note line ready to persist (a frozen snapshot of a returned line). */
export interface CreditNoteItemWriteData {
  returnItemId: bigint;
  orderItemId: bigint;
  productId: bigint;
  description: string;
  quantity: bigint;
  unitPriceAmount: bigint;
  taxRateBp: number;
  lineSubtotalAmount: bigint;
  lineTaxAmount: bigint;
  lineTotalAmount: bigint;
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

const CREDIT_NOTE_SELECT = {
  id: true,
  publicId: true,
  creditNoteNo: true,
  creditNoteNumber: true,
  fiscalYear: true,
  status: true,
  currency: true,
  subtotalAmount: true,
  taxAmount: true,
  grandTotalAmount: true,
  issuedAt: true,
  createdAt: true,
  idempotencyKey: true,
  returnId: true,
  warehouseId: true,
  return: { select: { publicId: true } },
  order: { select: { publicId: true } },
  originalInvoice: { select: { publicId: true } },
  customer: { select: { publicId: true } },
  warehouse: { select: { publicId: true } },
  series: { select: { seriesCode: true } },
  items: { select: ITEM_SELECT, orderBy: { id: 'asc' } },
} as const;

export interface ListCreditNotesOptions {
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
 * Data access for the `credit_notes` + `credit_note_items` tables (Return Invoice /
 * Credit Note Foundation, MODULE_BOUNDARIES §2 — billing owns these). Every method
 * takes an explicit executor so it composes inside the caller's transaction, and
 * every read/write is scoped to a `companyId` — tenant isolation is enforced here as
 * well as by the DB composite FKs. Credit notes are never deleted (CLAUDE rule 6 /
 * no_delete_credit_notes trigger). The gapless number is allocated from the shared
 * `invoice_series` (series_code 'CRN') via {@link InvoiceRepository}.
 */
@Injectable()
export class CreditNoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Find a credit note by its client idempotency key within a company (replay
   * lookup — the `(company_id, idempotency_key)` unique). */
  async findByKey(
    companyId: bigint,
    idempotencyKey: string,
    executor?: DbClient,
  ): Promise<CreditNoteRow | null> {
    return this.db(executor).creditNote.findUnique({
      where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
      select: CREDIT_NOTE_SELECT,
    });
  }

  /** Find the ACTIVE (non-VOID) credit note for a return within a company, if any —
   * the duplicate-credit-note guard (matches the `(company_id, return_id) WHERE
   * status <> 'VOID'` partial unique). */
  async findActiveByReturn(
    companyId: bigint,
    returnId: bigint,
    executor?: DbClient,
  ): Promise<CreditNoteRow | null> {
    return this.db(executor).creditNote.findFirst({
      where: { companyId, returnId, status: { not: 'VOID' } },
      select: CREDIT_NOTE_SELECT,
    });
  }

  /** Find a credit note by public id WITHIN a company (tenant isolation: a
   * cross-tenant id yields null → the service maps that to a 404, hiding it). */
  async findByPublicId(
    companyId: bigint,
    publicId: string,
    executor?: DbClient,
  ): Promise<CreditNoteRow | null> {
    return this.db(executor).creditNote.findFirst({
      where: { publicId, companyId },
      select: CREDIT_NOTE_SELECT,
    });
  }

  /** A page of credit notes for a company (ordered by id asc; cursor-friendly),
   * intersected with the actor's warehouse scope. */
  async list(
    companyId: bigint,
    opts: ListCreditNotesOptions,
    executor?: DbClient,
  ): Promise<CreditNoteRow[]> {
    const where: Prisma.CreditNoteWhereInput = { companyId };
    if (opts.cursorId !== undefined) where.id = { gt: opts.cursorId };
    if (opts.status !== undefined) {
      where.status = opts.status as Prisma.CreditNoteWhereInput['status'];
    }
    if (opts.onlyIds !== undefined) {
      where.warehouseId = { in: [...opts.onlyIds] };
    }
    return this.db(executor).creditNote.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.take,
      select: CREDIT_NOTE_SELECT,
    });
  }

  /**
   * Insert one credit-note header + its frozen line snapshot (caller's transaction).
   * The lines are written in a SEPARATE top-level `createMany`: `credit_note_items.
   * company_id` participates in BOTH the credit-note and product composite FKs, so a
   * top-level create accepts the scalar FKs directly (mirrors returns.createReturn).
   */
  async createCreditNote(
    tx: DbClient,
    data: {
      companyId: bigint;
      seriesId: bigint;
      creditNoteNumber: bigint;
      creditNoteNo: string;
      fiscalYear: number;
      returnId: bigint;
      orderId: bigint;
      originalInvoiceId: bigint;
      customerId: bigint;
      warehouseId: bigint;
      currency: string;
      subtotalAmount: bigint;
      taxAmount: bigint;
      grandTotalAmount: bigint;
      idempotencyKey: string;
      issuedAt: Date;
      createdById: bigint;
      items: CreditNoteItemWriteData[];
    },
  ): Promise<CreditNoteRow> {
    const created = await tx.creditNote.create({
      data: {
        companyId: data.companyId,
        seriesId: data.seriesId,
        creditNoteNumber: data.creditNoteNumber,
        creditNoteNo: data.creditNoteNo,
        fiscalYear: data.fiscalYear,
        returnId: data.returnId,
        orderId: data.orderId,
        originalInvoiceId: data.originalInvoiceId,
        customerId: data.customerId,
        warehouseId: data.warehouseId,
        status: 'ISSUED',
        currency: data.currency,
        subtotalAmount: data.subtotalAmount,
        taxAmount: data.taxAmount,
        grandTotalAmount: data.grandTotalAmount,
        idempotencyKey: data.idempotencyKey,
        issuedAt: data.issuedAt,
        createdById: data.createdById,
      },
      select: { id: true },
    });
    await tx.creditNoteItem.createMany({
      data: data.items.map((i) => ({
        creditNoteId: created.id,
        companyId: data.companyId,
        returnItemId: i.returnItemId,
        orderItemId: i.orderItemId,
        productId: i.productId,
        description: i.description,
        quantity: i.quantity,
        unitPriceAmount: i.unitPriceAmount,
        taxRateBp: i.taxRateBp,
        lineSubtotalAmount: i.lineSubtotalAmount,
        lineTaxAmount: i.lineTaxAmount,
        lineTotalAmount: i.lineTotalAmount,
      })),
    });
    return this.findById(tx, created.id);
  }

  /** Re-read a credit note by internal id (post-create projection). */
  async findById(tx: DbClient, id: bigint): Promise<CreditNoteRow> {
    return tx.creditNote.findUniqueOrThrow({ where: { id }, select: CREDIT_NOTE_SELECT });
  }
}
