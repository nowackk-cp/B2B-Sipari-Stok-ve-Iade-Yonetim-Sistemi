import { randomUUID } from 'node:crypto';
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
import type { ReturnListView, ReturnView } from '@b2b/contracts';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../common/auth/principal';
import type { RequestMeta } from '../../common/http/request-meta';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PrismaService } from '../../common/database/prisma.service';
import { isBigIntStringInRange } from '../../common/validation/is-bigint-string.decorator';
import { WarehouseScopeService } from '../authorization/warehouse-scope.service';
import { OrdersService } from '../orders/orders.service';
import { StockService } from '../inventory/stock.service';
import type { InvoiceableOrder } from '../orders/order.repository';
import { ReturnRepository, type ReturnItemWriteData, type ReturnRow } from './return.repository';
import { toReturnView } from './return-view';
import type { CreateReturnDto } from './dto/create-return.dto';
import type { ListReturnsQuery } from './dto/list-returns.query';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RETURN_CREATE = 'return:create';
const RETURN_APPROVE = 'return:approve';
const RETURN_NO_RETRIES = 5;

/** A return line resolved against an order line: the internal ids + the shipped
 * quantity the returnable amount is computed against. */
interface ResolvedReturnLine extends ReturnItemWriteData {
  shipped: bigint;
}

/** One returned line projected for credit-note issuance: the internal ids billing
 * needs to bind each credit-note line back to its return/order line + product. */
export interface CreditNotableReturnItem {
  returnItemId: bigint;
  orderItemId: bigint;
  productId: bigint;
  productPublicId: string;
  quantity: bigint;
}

/** A snapshot of a return for credit-note issuance (Return Invoice / Credit Note
 * Foundation). Read through the returns service so billing never touches the returns
 * tables directly (MODULE_BOUNDARIES §5). The customer/warehouse internal ids and the
 * line price+VAT snapshot come from the order projection (OrdersService). */
export interface CreditNotableReturn {
  id: bigint;
  publicId: string;
  status: string;
  orderId: bigint;
  orderPublicId: string;
  warehouseId: bigint;
  items: CreditNotableReturnItem[];
}

/**
 * Return / Refund application service (Return/Refund Foundation).
 *
 * Raises a customer return for a SHIPPED order (`POST /orders/:id/returns`, status
 * `DRAFT`, NO stock effect) and approves it (`POST /returns/:id/approve`), which
 * RESTOCKS the resellable quantity into the order's source warehouse in ONE
 * transaction: `on_hand += qty` on each (product, warehouse) balance, one positive
 * `RETURN_IN` `stock_ledger` movement per line (`reserved` untouched), the return
 * DRAFT→APPROVED transition, its status history and the business audit all commit
 * or roll back together (ADR-007, RETURN_RULES §3, INVENTORY_RULES §3/§5).
 *
 * Three controls guard every operation, all resolved from PostgreSQL (never a JWT
 * claim or the request body): the route permission (`return:create`/`read`/
 * `approve`), the tenant (the order/return is resolved WITHIN `actor.companyId`; a
 * cross-company id is a 404 — entity hiding), and warehouse scope (the actor must
 * be scoped to the order's warehouse). `Idempotency-Key` is MANDATORY on both
 * mutations: a same-key replay returns the existing return and creates nothing
 * twice; the same key reused for a different order/return/payload is a 409.
 *
 * The returns module reads order data ONLY through {@link OrdersService} and writes
 * stock ONLY through {@link StockService} — it never touches the orders or stock
 * tables directly (MODULE_BOUNDARIES §2/§3.1/§5).
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly repo: ReturnRepository,
    private readonly orders: OrdersService,
    private readonly stock: StockService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly scope: WarehouseScopeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- commands -------------------------------------------------------------

  /**
   * Raise a return for a SHIPPED order. `Idempotency-Key` is mandatory (rejected
   * before any side effect). Creates a DRAFT return with NO stock effect. Returns
   * the (possibly replayed) return.
   */
  async create(
    actor: AuthPrincipal,
    orderPublicId: string,
    dto: CreateReturnDto,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<ReturnView> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required to create a return');
    }

    // Tenant: the order must exist in the actor's own company (cross-tenant → 404).
    const order = await this.orders.getReturnableOrder(actor.companyId, orderPublicId);
    if (!order) throw new NotFoundException('Order not found');
    // Object-level scope on the order's warehouse (out of scope → 404, hiding).
    await this.assertObjectScope(actor, order.warehouseId);

    // Idempotency replay (pre-transaction): a return already exists under THIS key.
    const byKey = await this.repo.findByKey(actor.companyId, key);
    if (byKey) return this.replayOrConflict(byKey, order, dto);

    // Only a SHIPPED order can be returned. An invoiced order is necessarily SHIPPED
    // (invoices are issued only for SHIPPED orders), so the SHIPPED check covers both
    // "SHIPPED" and "invoiced" (RETURN_RULES §1). DRAFT/APPROVED/CANCELLED → 409.
    if (order.status !== 'SHIPPED') {
      throw new ConflictException('Only SHIPPED orders can be returned');
    }
    // Beyond object scope, the actor must hold return:create scoped to this warehouse.
    await this.assertWarehouseScope(actor, order.warehouseId, RETURN_CREATE);

    // Validate + resolve every line against the order's shipped lines.
    const resolved = this.resolveItems(order, dto.items);
    const reason = dto.reason ?? null;

    for (let attempt = 0; attempt < RETURN_NO_RETRIES; attempt += 1) {
      const returnNo = this.generateReturnNo(this.clock.now());
      try {
        const created = await this.prisma.transaction(async (tx) => {
          // Lock the order row FOR UPDATE: serialises the returned-vs-shipped
          // accounting against any concurrent order transition / sibling return, and
          // re-asserts SHIPPED under the lock.
          const locked = await this.orders.lockOrderForReturn(tx, order.id);
          if (!locked || locked.status !== 'SHIPPED') {
            throw new ConflictException('Order is no longer returnable');
          }
          // Re-check the returnable quantity under the lock: a return cannot return
          // more than was shipped, counting every prior non-rejected (DRAFT/APPROVED)
          // claim for the same order line (RETURN_RULES §1 / RET-2).
          const claimed = await this.repo.sumReturnedByOrderItem(tx, actor.companyId, order.id, [
            'DRAFT',
            'APPROVED',
          ]);
          for (const line of resolved) {
            const already = claimed.get(line.orderItemId) ?? 0n;
            if (already + line.quantity > line.shipped) {
              throw new ConflictException('Return quantity exceeds the returnable quantity');
            }
          }
          const ret = await this.repo.createReturn(tx, {
            returnNo,
            companyId: actor.companyId,
            orderId: order.id,
            customerId: order.customerId,
            warehouseId: order.warehouseId,
            invoiceId: null,
            reason,
            idempotencyKey: key,
            createdById: actor.userId,
            items: resolved.map((l) => ({
              orderItemId: l.orderItemId,
              productId: l.productId,
              quantity: l.quantity,
              reason: l.reason,
            })),
          });
          await this.repo.insertStatusHistory(tx, {
            returnId: ret.id,
            fromStatus: null,
            toStatus: 'DRAFT',
            changedById: actor.userId,
            reason: null,
          });
          await this.audit.write(tx, {
            action: AUDIT_ACTIONS.RETURN_CREATED,
            actor: this.actorSnapshot(actor),
            entityType: 'return',
            entityId: ret.id,
            after: this.auditProjection(ret),
            ip: meta.ip,
            userAgent: meta.userAgent,
          });
          return ret;
        });
        return toReturnView(created);
      } catch (err) {
        if (this.isReturnNoConflict(err)) continue; // regenerate and retry.
        // A concurrent request with the SAME key won the (company, idempotency_key)
        // race: the whole transaction rolled back with no side effects. Replay it.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const row = await this.repo.findByKey(actor.companyId, key);
          if (row) return this.replayOrConflict(row, order, dto);
        }
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique return number');
  }

  /**
   * Approve a DRAFT return: transition it to APPROVED and atomically RESTOCK every
   * line into the order's source warehouse. `Idempotency-Key` is mandatory. A
   * same-key replay returns the same APPROVED return; the same key reused for a
   * DIFFERENT return is a 409; an already-APPROVED return is a same-key replay or a
   * 409. All-or-nothing: any failure rolls back the whole transaction (the return
   * stays DRAFT, no stock/ledger/audit). The physical restock is delegated to
   * {@link StockService.receiveReturn} (returns never writes stock tables directly).
   */
  async approve(
    actor: AuthPrincipal,
    returnPublicId: string,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<ReturnView> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required to approve a return');
    }

    // Tenant: the return must exist in the actor's own company (cross-tenant → 404).
    const ret = await this.repo.findByPublicId(actor.companyId, returnPublicId);
    if (!ret) throw new NotFoundException('Return not found');
    // Object-level scope on the return's warehouse (out of scope → 404, hiding).
    await this.assertObjectScope(actor, ret.warehouseId);

    // Idempotency replay (pre-transaction): an approval already ran under THIS key.
    const byKey = await this.repo.findByApproveKey(actor.companyId, key);
    if (byKey) {
      if (byKey.id !== ret.id) {
        throw new ConflictException('Idempotency-Key was reused for a different return');
      }
      return toReturnView(byKey);
    }

    // An already-APPROVED return with a DIFFERENT key cannot be approved again.
    if (ret.status === 'APPROVED') {
      throw new ConflictException('Return has already been approved');
    }
    if (ret.status !== 'DRAFT') {
      throw new ConflictException('Only DRAFT returns can be approved');
    }
    // Beyond object scope, the actor must hold return:approve scoped to this
    // warehouse. An inactive/soft-deleted warehouse fails closed here (the scope
    // service resolves only ACTIVE warehouses) → 403, so approve cannot restock into
    // a dead warehouse (task rule 28).
    await this.assertWarehouseScope(actor, ret.warehouseId, RETURN_APPROVE);

    // The order (read through the orders service) supplies the shipped quantity each
    // line's returnable amount is bounded by.
    const order = await this.orders.getReturnableOrder(actor.companyId, ret.order.publicId);
    if (!order) throw new NotFoundException('Order not found');
    const shippedByOrderItem = new Map(order.items.map((i) => [i.orderItemId, i.quantity]));

    const at = this.clock.now();
    try {
      const approved = await this.prisma.transaction(async (tx) => {
        // (1) Lock the order row (serialise sibling return approvals) + re-assert
        //     SHIPPED. Lock order: orders → returns → balances.
        const lockedOrder = await this.orders.lockOrderForReturn(tx, order.id);
        if (!lockedOrder || lockedOrder.status !== 'SHIPPED') {
          throw new ConflictException('Order is no longer returnable');
        }
        // (2) Lock the return row + re-check status under the lock.
        const lockedRet = await this.repo.lockReturnForUpdate(tx, ret.id);
        if (!lockedRet) throw new ConflictException('Return is no longer approvable');
        if (lockedRet.status === 'APPROVED') {
          // A concurrent same-key approval committed first → replay; else 409.
          const fresh = await this.repo.findById(tx, ret.id);
          if (fresh.approveIdempotencyKey === key) return fresh;
          throw new ConflictException('Return has already been approved');
        }
        if (lockedRet.status !== 'DRAFT') {
          throw new ConflictException('Only DRAFT returns can be approved');
        }
        // (3) Re-read the lines under the lock and enforce returned ≤ shipped against
        //     the committed APPROVED quantity of OTHER returns (this return's own
        //     lines are not yet APPROVED). Over-return on any line → 409, full rollback.
        const fresh = await this.repo.findById(tx, ret.id);
        const approvedElsewhere = await this.repo.sumReturnedByOrderItem(
          tx,
          actor.companyId,
          order.id,
          ['APPROVED'],
          ret.id,
        );
        for (const line of fresh.items) {
          const shipped = shippedByOrderItem.get(line.orderItemId) ?? 0n;
          const other = approvedElsewhere.get(line.orderItemId) ?? 0n;
          if (other + line.quantity > shipped) {
            throw new ConflictException('Return quantity exceeds the returnable quantity');
          }
        }
        // (3b) Revalidate the warehouse lifecycle UNDER a row lock BEFORE any restock:
        //      the pre-transaction scope check resolves only ACTIVE warehouses, but a
        //      warehouse made inactive/soft-deleted AFTER that check (while this approve
        //      waited on the order/return lock) must still block the restock. The
        //      FOR SHARE lock serialises against a concurrent deactivate/soft-delete —
        //      if that commits first the row is read inactive/deleted here and approve
        //      fails (422); if approve locks first, the deactivate waits until commit
        //      and the restock is into a still-active warehouse. Runs before the balance
        //      update and the ledger insert (task rule 9).
        await this.assertWarehouseStillActive(tx, ret.warehouseId, actor.companyId);
        // (4) Restock: lock each (product, warehouse) balance FOR UPDATE in
        //     deterministic product-id order, on_hand += qty, one positive RETURN_IN
        //     ledger movement per line (reserved untouched). A duplicate movement is
        //     blocked by the per-line ledger key unique.
        await this.stock.receiveReturn(tx, {
          returnId: ret.id,
          warehouseId: ret.warehouseId,
          createdById: actor.userId,
          items: fresh.items.map((i) => ({
            returnItemId: i.id,
            productId: i.productId,
            quantity: i.quantity,
          })),
        });
        // (5) Expected-status conditional transition DRAFT→APPROVED (stamps the
        //     approve idempotency key). 0 rows ⇒ a concurrent transition moved it → 409.
        const count = await this.repo.approveIfDraft(tx, ret.id, actor.userId, key, at);
        if (count === 0) throw new ConflictException('Return is no longer DRAFT');
        await this.repo.insertStatusHistory(tx, {
          returnId: ret.id,
          fromStatus: 'DRAFT',
          toStatus: 'APPROVED',
          changedById: actor.userId,
          reason: null,
        });
        const updated = await this.repo.findById(tx, ret.id);
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.RETURN_APPROVED,
          actor: this.actorSnapshot(actor),
          entityType: 'return',
          entityId: updated.id,
          before: this.auditProjection(ret),
          after: this.auditProjection(updated),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return updated;
      });
      return toReturnView(approved);
    } catch (err) {
      // A concurrent SAME-key approval won the (company, approve_key) / RETURN_IN
      // ledger-key race: the whole transaction rolled back with no side effects.
      // Replay the winner if it is this return; otherwise surface the conflict.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await this.repo.findByApproveKey(actor.companyId, key);
        if (row && row.id === ret.id) return toReturnView(row);
        throw new ConflictException('Return has already been approved');
      }
      throw err;
    }
  }

  // --- reads ----------------------------------------------------------------

  async list(actor: AuthPrincipal, query: ListReturnsQuery): Promise<ReturnListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor);

    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) return emptyPage(); // deny-by-default: missing/suspended/deleted actor.
    // No global scope and no explicit warehouses → no accessible returns.
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
    return { data: page.map(toReturnView), pageInfo: { nextCursor, hasNextPage } };
  }

  async getOne(actor: AuthPrincipal, publicId: string): Promise<ReturnView> {
    const ret = await this.repo.findByPublicId(actor.companyId, publicId);
    if (!ret) throw new NotFoundException('Return not found');
    await this.assertObjectScope(actor, ret.warehouseId);
    return toReturnView(ret);
  }

  // --- cross-module read API (billing / credit notes) -----------------------

  /**
   * Project a return in `companyId` as a credit-note snapshot, or null if it does
   * not exist in that tenant (Return Invoice / Credit Note Foundation). The billing
   * module calls this instead of reading the returns tables directly — returns owns
   * those tables (MODULE_BOUNDARIES §2/§5). Read-only; no scope/permission decision
   * is made here (the caller enforces credit-note permission + warehouse scope). The
   * projection carries each line's return-item id, order-item id, product and the
   * returned quantity the credit amount is computed against.
   */
  async getCreditNotableReturn(
    companyId: bigint,
    publicId: string,
  ): Promise<CreditNotableReturn | null> {
    const ret = await this.repo.findByPublicId(companyId, publicId);
    if (!ret) return null;
    return {
      id: ret.id,
      publicId: ret.publicId,
      status: ret.status,
      orderId: ret.orderId,
      orderPublicId: ret.order.publicId,
      warehouseId: ret.warehouseId,
      items: ret.items.map((i) => ({
        returnItemId: i.id,
        orderItemId: i.orderItemId,
        productId: i.productId,
        productPublicId: i.product.publicId,
        quantity: i.quantity,
      })),
    };
  }

  /**
   * Lock a return row FOR UPDATE inside the CALLER's transaction and return its
   * current status (Return Invoice / Credit Note Foundation). The credit-note issue
   * transaction calls this to re-assert `APPROVED` under the row lock and serialise
   * against a concurrent same-return credit note before allocating a number. Returns
   * owns the row lock on its own table; it never opens a new transaction here — the
   * billing service passes its `tx` down (MODULE_BOUNDARIES §3.1).
   */
  lockReturnForCreditNote(
    tx: Prisma.TransactionClient,
    returnId: bigint,
  ): Promise<{ status: string } | null> {
    return this.repo.lockReturnForUpdate(tx, returnId);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Resolve every requested line against the order's SHIPPED lines (matched by
   * product public id — an order has at most one line per product). Validates the
   * quantity (positive BIGINT in range), rejects duplicate products and a product
   * not on the order (404 — entity hiding), and per line rejects a quantity already
   * exceeding the shipped quantity (a cheap 409 before the transaction; the prior-
   * returns check is re-done under the order lock).
   */
  private resolveItems(
    order: InvoiceableOrder,
    itemDtos: CreateReturnDto['items'],
  ): ResolvedReturnLine[] {
    const byProduct = new Map(
      order.items.map((i) => [
        i.productPublicId,
        { orderItemId: i.orderItemId, productId: i.productId, shipped: i.quantity },
      ]),
    );
    const seen = new Set<string>();
    const resolved: ResolvedReturnLine[] = [];
    for (const dto of itemDtos) {
      if (!isBigIntStringInRange(dto.quantity)) {
        throw new BadRequestException('quantity must be a positive integer string');
      }
      const quantity = BigInt(dto.quantity);
      if (quantity <= 0n) {
        throw new BadRequestException('quantity must be greater than zero');
      }
      if (seen.has(dto.productId)) {
        throw new BadRequestException('A return cannot list the same product twice');
      }
      seen.add(dto.productId);
      const line = byProduct.get(dto.productId);
      if (!line) throw new NotFoundException('Order line not found for the requested product');
      if (quantity > line.shipped) {
        throw new ConflictException('Return quantity exceeds the returnable quantity');
      }
      resolved.push({
        orderItemId: line.orderItemId,
        productId: line.productId,
        quantity,
        reason: dto.reason ?? null,
        shipped: line.shipped,
      });
    }
    return resolved;
  }

  /**
   * Decide whether an existing return found under the create key is an idempotent
   * replay (same order + same line payload) or a key reuse with a different payload
   * (409). The comparison is by order public id and the multiset of
   * (productPublicId, quantity, line reason) plus the return-level reason.
   */
  private replayOrConflict(
    existing: ReturnRow,
    order: InvoiceableOrder,
    dto: CreateReturnDto,
  ): ReturnView {
    const sameOrder = existing.order.publicId === order.publicId;
    const sameReason = (existing.reason ?? '') === (dto.reason ?? '');
    const actual = existing.items
      .map((i) => `${i.product.publicId}|${i.quantity.toString()}|${i.reason ?? ''}`)
      .sort();
    const requested = dto.items.map((i) => `${i.productId}|${i.quantity}|${i.reason ?? ''}`).sort();
    const sameLines =
      actual.length === requested.length && actual.every((v, i) => v === requested[i]);
    if (!sameOrder || !sameReason || !sameLines) {
      throw new ConflictException('Idempotency-Key was reused with a different return');
    }
    return toReturnView(existing);
  }

  /**
   * Object-level scope on a return/order warehouse: the actor must be global or
   * explicitly scoped to it. Out of scope (or an un-resolvable actor) → 404, so a
   * return the actor may not see is hidden rather than confirmed (§7b).
   */
  private async assertObjectScope(actor: AuthPrincipal, warehouseId: bigint): Promise<void> {
    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) throw new NotFoundException('Order not found');
    if (!(access.global || access.scopedWarehouseIds.has(warehouseId))) {
      throw new NotFoundException('Order not found');
    }
  }

  /**
   * The warehouse is already known to belong to the actor's tenant. Re-resolve the
   * scope decision fresh from PostgreSQL: the actor must hold the given permission
   * AND be scoped to this warehouse (and the warehouse must be ACTIVE). Out of scope
   * → 403 (the actor TARGETS this warehouse).
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

  /**
   * Re-validate at APPROVE time that the return's warehouse is still operable: a
   * same-tenant, ACTIVE (`is_active = true`), non-soft-deleted (`deleted_at IS NULL`)
   * row. Runs inside the approve transaction, locking the warehouse row FOR SHARE
   * (see {@link OrdersService.lockWarehouseForReturn}) so a concurrent deactivate/
   * soft-delete is serialised. A stale (missing/cross-company/inactive/deleted)
   * warehouse throws 422 BUSINESS_RULE, rolling the whole transaction back so the
   * return stays DRAFT with no restock/ledger — distinct from the 409 used for status
   * conflicts and the pre-transaction 403 used when the warehouse is ALREADY inactive
   * before approve starts (the scope service resolves only ACTIVE warehouses). This
   * mirrors the order-shipment warehouse revalidation exactly. */
  private async assertWarehouseStillActive(
    tx: Prisma.TransactionClient,
    warehouseId: bigint,
    companyId: bigint,
  ): Promise<void> {
    const warehouse = await this.orders.lockWarehouseForReturn(tx, warehouseId);
    if (
      !warehouse ||
      warehouse.companyId !== companyId ||
      !warehouse.isActive ||
      warehouse.deletedAt !== null
    ) {
      throw new UnprocessableEntityException(
        'The return warehouse is no longer active and cannot be approved',
      );
    }
  }

  /** A human-facing, collision-resistant return number: `RET-YYYYMMDD-<10 hex>`.
   * Not gapless (gapless numbering is reserved for invoices — CLAUDE rule 11). */
  private generateReturnNo(now: Date): string {
    const y = now.getUTCFullYear().toString();
    const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = now.getUTCDate().toString().padStart(2, '0');
    const suffix = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
    return `RET-${y}${m}${d}-${suffix}`;
  }

  /** Whether an error is a unique violation on the return_no column (retry trigger). */
  private isReturnNoConflict(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      return false;
    }
    return JSON.stringify(err.meta?.target ?? '').includes('return_no');
  }

  private actorSnapshot(actor: AuthPrincipal) {
    return {
      id: actor.userId,
      email: actor.email,
      name: actor.fullName,
      rolesSnapshot: actor.roles,
    };
  }

  /** Whitelisted domain projection for the audit (public ids, quantities as strings). */
  private auditProjection(ret: ReturnRow): Record<string, unknown> {
    return {
      returnNo: ret.returnNo,
      status: ret.status,
      orderId: ret.order.publicId,
      customerId: ret.customer.publicId,
      warehouseId: ret.warehouse.publicId,
      itemCount: ret.items.length,
      totalQuantity: ret.items.reduce((sum, i) => sum + i.quantity, 0n).toString(),
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function emptyPage(): ReturnListView {
  return { data: [], pageInfo: { nextCursor: null, hasNextPage: false } };
}

/** Opaque cursor = base64url of `r:<lastId>`. */
function encodeCursor(id: bigint): string {
  return Buffer.from(`r:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^r:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
