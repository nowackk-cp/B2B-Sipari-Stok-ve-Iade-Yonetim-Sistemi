import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { InvoiceListView, InvoiceView } from '@b2b/contracts';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../common/auth/principal';
import type { RequestMeta } from '../../common/http/request-meta';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PrismaService } from '../../common/database/prisma.service';
import { WarehouseScopeService } from '../authorization/warehouse-scope.service';
import { OrdersService } from '../orders/orders.service';
import type { InvoiceableOrder } from '../orders/order.repository';
import {
  InvoiceRepository,
  type InvoiceItemWriteData,
  type InvoiceRow,
} from './invoice.repository';
import { toInvoiceView } from './invoice-view';
import type { ListInvoicesQuery } from './dto/list-invoices.query';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const INVOICE_CREATE = 'invoice:create';
/** Default invoice series code (matches the seed). One series per company/year. */
const SERIES_CODE = 'INV';
/** Invoice numbers are zero-padded to this width inside `invoiceNo`. */
const NUMBER_PAD = 6;

/**
 * Invoice application service (Invoice/Billing Foundation).
 *
 * Issues exactly ONE invoice for a `SHIPPED` order via `POST /orders/:id/invoice`.
 * The invoice is created directly as `ISSUED`: in ONE transaction the header, its
 * frozen line snapshot (copied from the order's server-priced lines — totals never
 * come from the client), the gapless `invoice_series` number allocation (row lock,
 * NOT a PostgreSQL sequence — ADR-006), the status-history transition and the
 * business audit all commit or all roll back together (ADR-007). A transaction
 * rollback rolls back the `next_number` increment, so a number is never burned
 * (INVOICE_RULES INVC-6).
 *
 * Three controls guard the create, all resolved from PostgreSQL (never a JWT claim
 * or the request body): the route permission (`invoice:create`/`invoice:read`),
 * the tenant (the order is resolved WITHIN `actor.companyId`; a cross-company id is
 * a 404 — entity hiding), and warehouse scope (the actor must be scoped to the
 * order's warehouse). `Idempotency-Key` is MANDATORY: a same-key replay returns the
 * existing invoice and creates nothing twice; the same key reused for a different
 * order is a 409; a second invoice for the same order (different key) is a 409.
 *
 * Billing reads order data ONLY through {@link OrdersService} — it never touches
 * the orders tables directly (MODULE_BOUNDARIES §2/§5).
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly repo: InvoiceRepository,
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly scope: WarehouseScopeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- command --------------------------------------------------------------

  /**
   * Issue an invoice for a SHIPPED order. See the class doc for the full
   * invariant set. `Idempotency-Key` is mandatory (rejected before any side
   * effect). Returns the (possibly replayed) ISSUED invoice.
   */
  async createForOrder(
    actor: AuthPrincipal,
    orderPublicId: string,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<InvoiceView> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required to issue an invoice');
    }

    // Tenant: the order must exist in the actor's own company (cross-tenant → 404).
    const order = await this.orders.getInvoiceableOrder(actor.companyId, orderPublicId);
    if (!order) throw new NotFoundException('Order not found');
    // Object-level scope on the order's warehouse (out of scope → 404, hiding).
    await this.assertObjectScope(actor, order.warehouseId);

    // Idempotency replay (pre-transaction): an invoice already issued under THIS
    // key. Same order → replay it; a different order → 409.
    const byKey = await this.repo.findByKey(actor.companyId, key);
    if (byKey) {
      if (byKey.orderId !== order.id) {
        throw new ConflictException('Idempotency-Key was reused for a different order');
      }
      return toInvoiceView(byKey);
    }

    // Duplicate active invoice for this order under a DIFFERENT key → 409.
    const existing = await this.repo.findActiveByOrder(actor.companyId, order.id);
    if (existing) throw new ConflictException('Order has already been invoiced');

    // Only a SHIPPED order can be invoiced (DRAFT/APPROVED/CANCELLED → 409).
    if (order.status !== 'SHIPPED') {
      throw new ConflictException('Only SHIPPED orders can be invoiced');
    }
    // Beyond object scope, the actor must hold invoice:create scoped to this warehouse.
    await this.assertWarehouseScope(actor, order.warehouseId, INVOICE_CREATE);

    const at = this.clock.now();
    const fiscalYear = at.getUTCFullYear();
    try {
      const created = await this.prisma.transaction(async (tx) => {
        // (1) Lock the order row FOR UPDATE and re-assert SHIPPED under the lock
        //     (serialises against any concurrent order transition / invoice issue).
        const locked = await this.orders.lockOrderForInvoicing(tx, order.id);
        if (!locked) throw new ConflictException('Order is no longer invoiceable');
        // (1b) A concurrent issue committed between the pre-check and this lock.
        //      Same key → replay; a different key → already invoiced (409).
        const raced = await this.repo.findActiveByOrder(actor.companyId, order.id, tx);
        if (raced) {
          if (raced.idempotencyKey === key) return raced;
          throw new ConflictException('Order has already been invoiced');
        }
        if (locked.status !== 'SHIPPED') {
          throw new ConflictException('Only SHIPPED orders can be invoiced');
        }
        // (2) Allocate the gapless number: lock the series counter row, take
        //     next_number, then advance it. Rollback un-burns the number.
        const prefix = `${SERIES_CODE}-${fiscalYear}-`;
        const series = await this.repo.lockSeriesForUpdate(
          tx,
          actor.companyId,
          SERIES_CODE,
          fiscalYear,
          prefix,
        );
        const number = series.nextNumber;
        const invoiceNo = `${series.prefix}${number.toString().padStart(NUMBER_PAD, '0')}`;
        await this.repo.bumpSeries(tx, series.id);
        // (3) Create the invoice header + frozen line snapshot (server amounts).
        const invoice = await this.repo.createInvoice(tx, {
          companyId: actor.companyId,
          seriesId: series.id,
          invoiceNumber: number,
          invoiceNo,
          fiscalYear,
          customerId: order.customerId,
          orderId: order.id,
          warehouseId: order.warehouseId,
          currency: order.currency,
          subtotalAmount: order.subtotalAmount,
          taxAmount: order.taxAmount,
          grandTotalAmount: order.grandTotalAmount,
          idempotencyKey: key,
          issuedAt: at,
          createdById: actor.userId,
          items: this.snapshotLines(order),
        });
        // (4) Status history (null→ISSUED) + business audit, same transaction.
        await this.repo.insertStatusHistory(tx, {
          invoiceId: invoice.id,
          fromStatus: null,
          toStatus: 'ISSUED',
          changedById: actor.userId,
          reason: null,
        });
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.INVOICE_ISSUED,
          actor: this.actorSnapshot(actor),
          entityType: 'invoice',
          entityId: invoice.id,
          after: this.auditProjection(invoice),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return invoice;
      });
      return toInvoiceView(created);
    } catch (err) {
      // A concurrent request won a unique race (same key, or same order's active
      // unique) and rolled this transaction back with no side effects. Replay the
      // winner if it is this order under this key; otherwise surface the conflict.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await this.repo.findByKey(actor.companyId, key);
        if (row && row.orderId === order.id) return toInvoiceView(row);
        throw new ConflictException('Order has already been invoiced');
      }
      throw err;
    }
  }

  // --- reads ----------------------------------------------------------------

  async list(actor: AuthPrincipal, query: ListInvoicesQuery): Promise<InvoiceListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor);

    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) return emptyPage(); // deny-by-default: missing/suspended/deleted actor.
    // No global scope and no explicit warehouses → no accessible invoices.
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
    return { data: page.map(toInvoiceView), pageInfo: { nextCursor, hasNextPage } };
  }

  async getOne(actor: AuthPrincipal, publicId: string): Promise<InvoiceView> {
    const invoice = await this.repo.findByPublicId(actor.companyId, publicId);
    if (!invoice) throw new NotFoundException('Invoice not found');
    await this.assertObjectScope(actor, invoice.warehouseId);
    return toInvoiceView(invoice);
  }

  // --- internals ------------------------------------------------------------

  /** Freeze the order's server-priced lines into invoice-line snapshots. The
   * description is the product-name snapshot; amounts are copied verbatim so the
   * invoice totals equal the order totals (INVOICE_RULES §4). */
  private snapshotLines(order: InvoiceableOrder): InvoiceItemWriteData[] {
    return order.items.map((i) => ({
      productId: i.productId,
      orderItemId: i.orderItemId,
      description: i.productName,
      quantity: i.quantity,
      unitPriceAmount: i.unitPriceAmount,
      taxRateBp: i.taxRateBp,
      lineSubtotalAmount: i.lineSubtotalAmount,
      lineTaxAmount: i.lineTaxAmount,
      lineTotalAmount: i.lineTotalAmount,
    }));
  }

  /**
   * Object-level scope on an invoice/order warehouse: the actor must be global or
   * explicitly scoped to it. Out of scope (or an un-resolvable actor) → 404, so an
   * invoice the actor may not see is hidden rather than confirmed (§7b). A
   * warehouse-less invoice is visible only to a global actor.
   */
  private async assertObjectScope(actor: AuthPrincipal, warehouseId: bigint | null): Promise<void> {
    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) throw new NotFoundException('Order not found');
    if (access.global) return;
    if (warehouseId === null || !access.scopedWarehouseIds.has(warehouseId)) {
      throw new NotFoundException('Order not found');
    }
  }

  /**
   * The warehouse is already known to belong to the actor's tenant. Re-resolve the
   * scope decision fresh from PostgreSQL: the actor must hold the given permission
   * AND be scoped to this warehouse. A warehouse-less invoice can only be acted on
   * with global scope. Out of scope → 403 (the actor TARGETS this warehouse).
   */
  private async assertWarehouseScope(
    actor: AuthPrincipal,
    warehouseId: bigint | null,
    permission: string,
  ): Promise<void> {
    if (warehouseId === null) {
      if (!(await this.scope.hasGlobalWarehouseScope(actor.userId))) {
        throw new ForbiddenException('Out of warehouse scope');
      }
      return;
    }
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
  private auditProjection(inv: InvoiceRow): Record<string, unknown> {
    return {
      invoiceNo: inv.invoiceNo,
      status: inv.status,
      orderId: inv.order?.publicId ?? null,
      customerId: inv.customer.publicId,
      warehouseId: inv.warehouse?.publicId ?? null,
      currency: inv.currency,
      subtotal: inv.subtotalAmount.toString(),
      vat: inv.taxAmount.toString(),
      total: inv.grandTotalAmount.toString(),
      itemCount: inv.items.length,
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function emptyPage(): InvoiceListView {
  return { data: [], pageInfo: { nextCursor: null, hasNextPage: false } };
}

/** Opaque cursor = base64url of `i:<lastId>`. */
function encodeCursor(id: bigint): string {
  return Buffer.from(`i:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^i:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
