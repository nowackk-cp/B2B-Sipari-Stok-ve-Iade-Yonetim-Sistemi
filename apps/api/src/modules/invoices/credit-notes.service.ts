import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { CreditNoteListView, CreditNoteView } from '@b2b/contracts';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../common/auth/principal';
import type { RequestMeta } from '../../common/http/request-meta';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PrismaService } from '../../common/database/prisma.service';
import { PG_BIGINT_MAX } from '../../common/validation/is-bigint-string.decorator';
import { WarehouseScopeService } from '../authorization/warehouse-scope.service';
import { OrdersService } from '../orders/orders.service';
import { ReturnsService, type CreditNotableReturn } from '../returns/returns.service';
import type { InvoiceableOrder } from '../orders/order.repository';
import { InvoiceRepository } from './invoice.repository';
import {
  CreditNoteRepository,
  type CreditNoteItemWriteData,
  type CreditNoteRow,
} from './credit-note.repository';
import { toCreditNoteView } from './credit-note-view';
import type { ListCreditNotesQuery } from './dto/list-credit-notes.query';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CREDIT_NOTE_CREATE = 'credit-note:create';
/** Credit note series code (distinct from the invoice 'INV' series). */
const SERIES_CODE = 'CRN';
/** Credit note numbers are zero-padded to this width inside `creditNoteNo`. */
const NUMBER_PAD = 6;

/** A credit-note line resolved against the original order line: write data + totals. */
interface ComputedCreditLines {
  currency: string;
  items: CreditNoteItemWriteData[];
  subtotal: bigint;
  tax: bigint;
  total: bigint;
}

/**
 * Credit note application service (Return Invoice / Credit Note Foundation).
 *
 * Issues exactly ONE credit note for an APPROVED return of an invoiced order via
 * `POST /returns/:id/credit-note`. The credit note is created directly as `ISSUED`:
 * in ONE transaction the header, its frozen line snapshot (computed from the return
 * quantities × the ORIGINAL order/invoice line price+VAT — amounts never come from
 * the client), the gapless `invoice_series` number allocation (series code 'CRN',
 * row lock, NOT a PostgreSQL sequence — ADR-006) and the business audit all commit
 * or all roll back together (ADR-007). A transaction rollback rolls back the
 * `next_number` increment, so a number is never burned.
 *
 * Three controls guard the create, all resolved from PostgreSQL (never a JWT claim
 * or the request body): the route permission (`credit-note:create`/`credit-note:read`),
 * the tenant (the return is resolved WITHIN `actor.companyId`; a cross-company id is
 * a 404 — entity hiding), and warehouse scope (the actor must be scoped to the
 * return's warehouse). `Idempotency-Key` is MANDATORY: a same-key replay returns the
 * existing credit note and creates nothing twice; the same key reused for a different
 * return is a 409; a second credit note for the same return (different key) is a 409.
 *
 * Billing reads return data ONLY through {@link ReturnsService} and order data ONLY
 * through {@link OrdersService} — it never touches those tables directly
 * (MODULE_BOUNDARIES §2/§5). The credit note requires an active original invoice for
 * the order (RETURN_RULES §4: an un-invoiced order's return produces no credit note).
 */
@Injectable()
export class CreditNotesService {
  constructor(
    private readonly repo: CreditNoteRepository,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly returns: ReturnsService,
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly scope: WarehouseScopeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- command --------------------------------------------------------------

  /**
   * Issue a credit note for an APPROVED return. See the class doc for the full
   * invariant set. `Idempotency-Key` is mandatory (rejected before any side
   * effect). Returns the (possibly replayed) ISSUED credit note.
   */
  async createForReturn(
    actor: AuthPrincipal,
    returnPublicId: string,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<CreditNoteView> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required to issue a credit note');
    }

    // Tenant: the return must exist in the actor's own company (cross-tenant → 404).
    const ret = await this.returns.getCreditNotableReturn(actor.companyId, returnPublicId);
    if (!ret) throw new NotFoundException('Return not found');
    // Object-level scope on the return's warehouse (out of scope → 404, hiding).
    await this.assertObjectScope(actor, ret.warehouseId);

    // Idempotency replay (pre-transaction): a credit note already issued under THIS
    // key. Same return → replay it; a different return → 409.
    const byKey = await this.repo.findByKey(actor.companyId, key);
    if (byKey) {
      if (byKey.returnId !== ret.id) {
        throw new ConflictException('Idempotency-Key was reused for a different return');
      }
      return toCreditNoteView(byKey);
    }

    // Duplicate active credit note for this return under a DIFFERENT key → 409.
    const existing = await this.repo.findActiveByReturn(actor.companyId, ret.id);
    if (existing) throw new ConflictException('Return has already been credited');

    // Only an APPROVED return can be credited. A still-requested (DRAFT) return → 409.
    if (ret.status !== 'APPROVED') {
      throw new ConflictException('Only APPROVED returns can be credited');
    }
    // Beyond object scope, the actor must hold credit-note:create scoped to this warehouse.
    await this.assertWarehouseScope(actor, ret.warehouseId, CREDIT_NOTE_CREATE);

    // The order (read through the orders service) supplies the customer + the frozen
    // line price/VAT the credit amounts are computed from.
    const order = await this.orders.getReturnableOrder(actor.companyId, ret.orderPublicId);
    if (!order) throw new NotFoundException('Order not found');

    // RETURN_RULES §4: a credit note is only issued for an INVOICED order. The order
    // must have an ACTIVE (non-VOID) invoice; otherwise there is nothing to credit
    // against → 422 BUSINESS_RULE (un-invoiced return is stock-only).
    const originalInvoice = await this.invoiceRepo.findActiveByOrder(actor.companyId, order.id);
    if (!originalInvoice) {
      throw new UnprocessableEntityException(
        'The return order has no invoice; a credit note cannot be issued',
      );
    }

    const lines = this.computeLines(ret, order);

    const at = this.clock.now();
    const fiscalYear = at.getUTCFullYear();
    try {
      const created = await this.prisma.transaction(async (tx) => {
        // (1) Lock the return row FOR UPDATE and re-assert APPROVED under the lock
        //     (serialises against any concurrent same-return credit note).
        const locked = await this.returns.lockReturnForCreditNote(tx, ret.id);
        if (!locked) throw new ConflictException('Return is no longer creditable');
        // (1b) A concurrent credit note committed between the pre-check and this lock.
        //      Same key → replay; a different key → already credited (409).
        const raced = await this.repo.findActiveByReturn(actor.companyId, ret.id, tx);
        if (raced) {
          if (raced.idempotencyKey === key) return raced;
          throw new ConflictException('Return has already been credited');
        }
        if (locked.status !== 'APPROVED') {
          throw new ConflictException('Only APPROVED returns can be credited');
        }
        // (2) Allocate the gapless number: lock the CRN series counter row, take
        //     next_number, then advance it. Rollback un-burns the number.
        const prefix = `${SERIES_CODE}-${fiscalYear}-`;
        const series = await this.invoiceRepo.lockSeriesForUpdate(
          tx,
          actor.companyId,
          SERIES_CODE,
          fiscalYear,
          prefix,
        );
        const number = series.nextNumber;
        const creditNoteNo = `${series.prefix}${number.toString().padStart(NUMBER_PAD, '0')}`;
        await this.invoiceRepo.bumpSeries(tx, series.id);
        // (3) Create the credit note header + frozen line snapshot (server amounts).
        const creditNote = await this.repo.createCreditNote(tx, {
          companyId: actor.companyId,
          seriesId: series.id,
          creditNoteNumber: number,
          creditNoteNo,
          fiscalYear,
          returnId: ret.id,
          orderId: order.id,
          originalInvoiceId: originalInvoice.id,
          customerId: order.customerId,
          warehouseId: ret.warehouseId,
          currency: lines.currency,
          subtotalAmount: lines.subtotal,
          taxAmount: lines.tax,
          grandTotalAmount: lines.total,
          idempotencyKey: key,
          issuedAt: at,
          createdById: actor.userId,
          items: lines.items,
        });
        // (4) Business audit, same transaction.
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.CREDIT_NOTE_ISSUED,
          actor: this.actorSnapshot(actor),
          entityType: 'credit_note',
          entityId: creditNote.id,
          after: this.auditProjection(creditNote),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return creditNote;
      });
      return toCreditNoteView(created);
    } catch (err) {
      // A concurrent request won a unique race (same key, or the same return's active
      // unique) and rolled this transaction back with no side effects. Replay the
      // winner if it is this return under this key; otherwise surface the conflict.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await this.repo.findByKey(actor.companyId, key);
        if (row && row.returnId === ret.id) return toCreditNoteView(row);
        throw new ConflictException('Return has already been credited');
      }
      throw err;
    }
  }

  // --- reads ----------------------------------------------------------------

  async list(actor: AuthPrincipal, query: ListCreditNotesQuery): Promise<CreditNoteListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor);

    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) return emptyPage(); // deny-by-default: missing/suspended/deleted actor.
    // No global scope and no explicit warehouses → no accessible credit notes.
    if (!access.global && access.scopedWarehouseIds.size === 0) return emptyPage();
    const onlyIds = access.global ? undefined : access.scopedWarehouseIds;

    const rows = await this.repo.list(actor.companyId, {
      cursorId,
      take: limit + 1,
      onlyIds,
      status: query.status,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? encodeCursor(page[page.length - 1]!.id) : null;
    return { data: page.map(toCreditNoteView), pageInfo: { nextCursor, hasNextPage } };
  }

  async getOne(actor: AuthPrincipal, publicId: string): Promise<CreditNoteView> {
    const creditNote = await this.repo.findByPublicId(actor.companyId, publicId);
    if (!creditNote) throw new NotFoundException('Credit note not found');
    await this.assertObjectScope(actor, creditNote.warehouseId);
    return toCreditNoteView(creditNote);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Compute the credit note lines + totals from the return quantities and the
   * original order line price/VAT snapshot (RETURN_RULES §4, INVOICE_RULES §4). All
   * arithmetic is `bigint` minor units; the line VAT is floored exactly like the
   * order/invoice line VAT (kuruş consistency), so a full return reproduces the
   * invoice line VAT and a partial return credits the quantity-proportional amount.
   * Currency = the order currency. Any amount exceeding PostgreSQL BIGINT range is a
   * clean 400, never a DB-overflow 500.
   */
  private computeLines(ret: CreditNotableReturn, order: InvoiceableOrder): ComputedCreditLines {
    const orderItemById = new Map(order.items.map((i) => [i.orderItemId, i]));
    const items: CreditNoteItemWriteData[] = [];
    let subtotal = 0n;
    let tax = 0n;
    let total = 0n;

    for (const line of ret.items) {
      const oi = orderItemById.get(line.orderItemId);
      if (!oi) {
        // The return line is not on the order — impossible via the API (return lines
        // derive from order lines), but fail closed rather than mis-credit.
        throw new UnprocessableEntityException('A return line does not match an order line');
      }
      const quantity = line.quantity;
      const unit = oi.unitPriceAmount;
      const lineSubtotal = unit * quantity;
      const lineTax = (lineSubtotal * BigInt(oi.taxRateBp)) / 10000n; // floor (non-negative).
      const lineTotal = lineSubtotal + lineTax;
      items.push({
        returnItemId: line.returnItemId,
        orderItemId: line.orderItemId,
        productId: line.productId,
        description: oi.productName,
        quantity,
        unitPriceAmount: unit,
        taxRateBp: oi.taxRateBp,
        lineSubtotalAmount: lineSubtotal,
        lineTaxAmount: lineTax,
        lineTotalAmount: lineTotal,
      });
      subtotal += lineSubtotal;
      tax += lineTax;
      total += lineTotal;
    }

    for (const item of items) {
      this.assertInRange(item.lineSubtotalAmount);
      this.assertInRange(item.lineTaxAmount);
      this.assertInRange(item.lineTotalAmount);
    }
    this.assertInRange(subtotal);
    this.assertInRange(tax);
    this.assertInRange(total);

    return { currency: order.currency, items, subtotal, tax, total };
  }

  private assertInRange(value: bigint): void {
    if (value > PG_BIGINT_MAX) {
      throw new BadRequestException('Credit note amount exceeds the maximum supported value');
    }
  }

  /**
   * Object-level scope on a credit note / return warehouse: the actor must be global
   * or explicitly scoped to it. Out of scope (or an un-resolvable actor) → 404, so a
   * credit note the actor may not see is hidden rather than confirmed (§7b).
   */
  private async assertObjectScope(actor: AuthPrincipal, warehouseId: bigint): Promise<void> {
    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) throw new NotFoundException('Return not found');
    if (!(access.global || access.scopedWarehouseIds.has(warehouseId))) {
      throw new NotFoundException('Return not found');
    }
  }

  /**
   * The warehouse is already known to belong to the actor's tenant. Re-resolve the
   * scope decision fresh from PostgreSQL: the actor must hold the given permission
   * AND be scoped to this warehouse. Out of scope → 403 (the actor TARGETS this
   * warehouse).
   */
  private async assertWarehouseScope(
    actor: AuthPrincipal,
    warehouseId: bigint,
    permission: string,
  ): Promise<void> {
    const decision = await this.scope.canAccessWarehouseForPermission(
      actor.userId,
      warehouseId,
      permission,
    );
    if (!decision.allowed) throw new ForbiddenException('Out of warehouse scope');
  }

  private actorSnapshot(actor: AuthPrincipal) {
    return {
      id: actor.userId,
      email: actor.email,
      name: actor.fullName,
      rolesSnapshot: actor.roles,
    };
  }

  /** Whitelisted domain projection for the audit (public ids, amounts as strings). */
  private auditProjection(cn: CreditNoteRow): Record<string, unknown> {
    return {
      creditNoteNo: cn.creditNoteNo,
      status: cn.status,
      returnId: cn.return.publicId,
      orderId: cn.order.publicId,
      originalInvoiceId: cn.originalInvoice.publicId,
      customerId: cn.customer.publicId,
      warehouseId: cn.warehouse.publicId,
      currency: cn.currency,
      subtotal: cn.subtotalAmount.toString(),
      vat: cn.taxAmount.toString(),
      total: cn.grandTotalAmount.toString(),
      itemCount: cn.items.length,
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function emptyPage(): CreditNoteListView {
  return { data: [], pageInfo: { nextCursor: null, hasNextPage: false } };
}

/** Opaque cursor = base64url of `c:<lastId>`. */
function encodeCursor(id: bigint): string {
  return Buffer.from(`c:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^c:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
