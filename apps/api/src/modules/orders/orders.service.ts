import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { OrderListView, OrderView } from '@b2b/contracts';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../common/auth/principal';
import type { RequestMeta } from '../../common/http/request-meta';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PrismaService } from '../../common/database/prisma.service';
import {
  PG_BIGINT_MAX,
  isBigIntStringInRange,
} from '../../common/validation/is-bigint-string.decorator';
import { WarehouseScopeService } from '../authorization/warehouse-scope.service';
import {
  OrderRepository,
  type OrderItemWriteData,
  type OrderRow,
  type ResolvedProduct,
} from './order.repository';
import { toOrderView } from './order-view';
import type { CreateOrderDto, CreateOrderItemDto } from './dto/create-order.dto';
import type { UpdateOrderDto } from './dto/update-order.dto';
import type { CancelOrderDto } from './dto/cancel-order.dto';
import type { ListOrdersQuery } from './dto/list-orders.query';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ORDER_CREATE = 'order:create';
const ORDER_UPDATE = 'order:update';
const ORDER_CANCEL = 'order:cancel';
const ORDER_NO_RETRIES = 5;

/** Server-priced, totalled lines plus the order's shared currency/totals. */
interface ComputedLines {
  currency: string;
  items: OrderItemWriteData[];
  subtotal: bigint;
  tax: bigint;
  total: bigint;
}

/**
 * Order application service (Order Draft Foundation).
 *
 * Covers the DRAFT lifecycle ONLY: create, edit, list, read and cancel a draft —
 * with NO stock effect (no reservation, no ledger, no balance change). Three
 * controls guard every operation, all resolved from PostgreSQL (never a JWT claim
 * or the request body):
 *   1. PERMISSION — the route's `@RequirePermissions` (`order:read/create/update/cancel`).
 *   2. TENANT — the customer, warehouse and every product are resolved WITHIN
 *      `actor.companyId`; a cross-company id is a 404 (entity hiding). Resolving all
 *      of them inside one company also enforces "they share a company" at the API,
 *      backed by the DB composite FKs.
 *   3. WAREHOUSE SCOPE — beyond holding the permission, the actor must be scoped to
 *      the order's warehouse (explicit grant or protected `warehouse:scope:all`,
 *      same company only), decided fresh by {@link WarehouseScopeService}.
 *
 * PRICING IS SERVER-SIDE (ORDER_RULES §2a / CLAUDE rule 16): the line unit price,
 * tax rate and currency come from the product, never the client; totals are always
 * recomputed here. Each mutation runs in ONE transaction together with its
 * order_status_history transition (where applicable) and its business-audit row
 * (ADR-007).
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly repo: OrderRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly scope: WarehouseScopeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- commands -------------------------------------------------------------

  async create(actor: AuthPrincipal, dto: CreateOrderDto, meta: RequestMeta): Promise<OrderView> {
    // Tenant + lifecycle: customer and warehouse must be ACTIVE rows in the actor's
    // own company (a cross-tenant id is a 404 — entity hiding).
    const customer = await this.repo.findActiveCustomer(actor.companyId, dto.customerId);
    if (!customer) throw new NotFoundException('Customer not found');
    const warehouse = await this.repo.findActiveWarehouse(actor.companyId, dto.warehouseId);
    if (!warehouse) throw new NotFoundException('Warehouse not found');

    // Warehouse scope: holding order:create is not enough — the actor must be scoped
    // to THIS warehouse (explicit grant or warehouse:scope:all, same company only).
    await this.assertWarehouseScope(actor, warehouse.id, ORDER_CREATE);

    const resolved = await this.resolveItems(actor.companyId, dto.items);
    const lines = this.buildLines(resolved);
    const note = dto.note ?? null;

    // order_no is unique; generate a high-entropy value and retry on the (astronomically
    // rare) collision so a clash never surfaces as a 500.
    for (let attempt = 0; attempt < ORDER_NO_RETRIES; attempt += 1) {
      const orderNo = this.generateOrderNo(this.clock.now());
      try {
        const created = await this.prisma.transaction(async (tx) => {
          const order = await this.repo.createOrder(tx, {
            orderNo,
            companyId: actor.companyId,
            customerId: customer.id,
            warehouseId: warehouse.id,
            currency: lines.currency,
            subtotalAmount: lines.subtotal,
            taxAmount: lines.tax,
            grandTotalAmount: lines.total,
            notes: note,
            createdById: actor.userId,
            items: lines.items,
          });
          await this.repo.insertStatusHistory(tx, {
            orderId: order.id,
            fromStatus: null,
            toStatus: 'DRAFT',
            changedById: actor.userId,
            reason: null,
          });
          await this.audit.write(tx, {
            action: AUDIT_ACTIONS.ORDER_CREATED,
            actor: this.actorSnapshot(actor),
            entityType: 'order',
            entityId: order.id,
            after: this.auditProjection(order),
            ip: meta.ip,
            userAgent: meta.userAgent,
          });
          return order;
        });
        return toOrderView(created);
      } catch (err) {
        if (this.isOrderNoConflict(err)) continue; // regenerate and retry.
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique order number');
  }

  async update(
    actor: AuthPrincipal,
    publicId: string,
    dto: UpdateOrderDto,
    meta: RequestMeta,
  ): Promise<OrderView> {
    const existing = await this.resolveOrThrow(actor.companyId, publicId);
    // Object-level scope on the order's CURRENT warehouse (out of scope → 404, hiding).
    await this.assertObjectScope(actor, existing.warehouseId);
    if (existing.status !== 'DRAFT') {
      throw new ConflictException('Only DRAFT orders can be updated');
    }

    const data: Parameters<OrderRepository['updateOrder']>[3] = {};

    if (dto.customerId !== undefined) {
      const customer = await this.repo.findActiveCustomer(actor.companyId, dto.customerId);
      if (!customer) throw new NotFoundException('Customer not found');
      data.customerId = customer.id;
    }

    if (dto.warehouseId !== undefined) {
      const warehouse = await this.repo.findActiveWarehouse(actor.companyId, dto.warehouseId);
      if (!warehouse) throw new NotFoundException('Warehouse not found');
      // Moving the order to a new warehouse needs scope on that target warehouse.
      await this.assertWarehouseScope(actor, warehouse.id, ORDER_UPDATE);
      data.warehouseId = warehouse.id;
    }

    if (dto.items !== undefined) {
      const resolved = await this.resolveItems(actor.companyId, dto.items);
      const lines = this.buildLines(resolved);
      data.items = lines.items;
      data.currency = lines.currency;
      data.subtotalAmount = lines.subtotal;
      data.taxAmount = lines.tax;
      data.grandTotalAmount = lines.total;
    }

    if (dto.note !== undefined) data.notes = dto.note;

    const updated = await this.prisma.transaction(async (tx) => {
      const order = await this.repo.updateOrder(tx, existing.id, actor.companyId, data);
      await this.audit.write(tx, {
        action: AUDIT_ACTIONS.ORDER_UPDATED,
        actor: this.actorSnapshot(actor),
        entityType: 'order',
        entityId: order.id,
        before: this.auditProjection(existing),
        after: this.auditProjection(order),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return order;
    });
    return toOrderView(updated);
  }

  async cancel(
    actor: AuthPrincipal,
    publicId: string,
    dto: CancelOrderDto,
    meta: RequestMeta,
  ): Promise<OrderView> {
    const existing = await this.resolveOrThrow(actor.companyId, publicId);
    await this.assertObjectScope(actor, existing.warehouseId);
    if (existing.status !== 'DRAFT') {
      throw new ConflictException('Only DRAFT orders can be cancelled');
    }
    await this.assertWarehouseScope(actor, existing.warehouseId, ORDER_CANCEL);

    const at = this.clock.now();
    const updated = await this.prisma.transaction(async (tx) => {
      // Expected-status conditional transition (DRAFT→CANCELLED): 0 affected rows
      // means a concurrent transition already moved it (ORDER_RULES §1a) → 409. No
      // stock effect — cancellation of a DRAFT touches no reservation/ledger.
      const count = await this.repo.cancelIfDraft(tx, existing.id, at);
      if (count === 0) throw new ConflictException('Order is no longer DRAFT');
      await this.repo.insertStatusHistory(tx, {
        orderId: existing.id,
        fromStatus: 'DRAFT',
        toStatus: 'CANCELLED',
        changedById: actor.userId,
        reason: dto.reason ?? null,
      });
      const order = await this.repo.findById(tx, existing.id);
      await this.audit.write(tx, {
        action: AUDIT_ACTIONS.ORDER_CANCELLED,
        actor: this.actorSnapshot(actor),
        entityType: 'order',
        entityId: order.id,
        before: this.auditProjection(existing),
        after: this.auditProjection(order),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return order;
    });
    return toOrderView(updated);
  }

  // --- reads ----------------------------------------------------------------

  async list(actor: AuthPrincipal, query: ListOrdersQuery): Promise<OrderListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor);

    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) return emptyPage(); // deny-by-default: missing/suspended/deleted actor.
    const onlyIds = access.global ? undefined : access.scopedWarehouseIds;

    let warehouseId: bigint | undefined;
    if (query.warehouseId) {
      const wh = await this.repo.findActiveWarehouse(actor.companyId, query.warehouseId);
      if (!wh) return emptyPage(); // unknown / other tenant → empty (entity hiding).
      if (onlyIds && !onlyIds.has(wh.id)) return emptyPage(); // out of scope → empty.
      warehouseId = wh.id;
    }

    const rows = await this.repo.list(actor.companyId, {
      cursorId,
      take: limit + 1,
      onlyIds,
      warehouseId,
      status: query.status,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? encodeCursor(page[page.length - 1]!.id) : null;
    return { data: page.map(toOrderView), pageInfo: { nextCursor, hasNextPage } };
  }

  async getOne(actor: AuthPrincipal, publicId: string): Promise<OrderView> {
    const order = await this.resolveOrThrow(actor.companyId, publicId);
    await this.assertObjectScope(actor, order.warehouseId);
    return toOrderView(order);
  }

  // --- internals ------------------------------------------------------------

  /** Resolve an order in the actor's company or 404 (also hides another tenant's
   * order behind a 404 — object-level authz, §7b). */
  private async resolveOrThrow(companyId: bigint, publicId: string): Promise<OrderRow> {
    const order = await this.repo.findByPublicId(companyId, publicId);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Resolve every requested line to an ACTIVE product in the actor's company,
   * validating the quantity and rejecting duplicate products. A cross-tenant /
   * inactive / soft-deleted product is a 404 (entity hiding).
   */
  private async resolveItems(
    companyId: bigint,
    itemDtos: CreateOrderItemDto[],
  ): Promise<Array<{ product: ResolvedProduct; quantity: bigint }>> {
    if (itemDtos.length === 0) {
      throw new BadRequestException('An order must have at least one item');
    }
    const seen = new Set<string>();
    const resolved: Array<{ product: ResolvedProduct; quantity: bigint }> = [];
    for (const dto of itemDtos) {
      // Defensive: the DTO already rejects negative/decimal/empty/over-BIGINT; the
      // service additionally rejects 0 (a line must order a positive quantity).
      if (!isBigIntStringInRange(dto.quantity)) {
        throw new BadRequestException('quantity must be a positive integer string');
      }
      const quantity = BigInt(dto.quantity);
      if (quantity <= 0n) {
        throw new BadRequestException('quantity must be greater than zero');
      }
      if (seen.has(dto.productId)) {
        throw new BadRequestException('An order cannot list the same product twice');
      }
      seen.add(dto.productId);
      const product = await this.repo.findActiveProduct(companyId, dto.productId);
      if (!product) throw new NotFoundException('Product not found');
      resolved.push({ product, quantity });
    }
    return resolved;
  }

  /**
   * Compute the server-priced lines + order totals (ORDER_RULES §7). All arithmetic
   * is `bigint` minor units; only the line VAT is rounded (floor), never the totals
   * (kuruş consistency). Currency must be consistent across lines (server currency
   * comes from each product). Any amount exceeding PostgreSQL BIGINT range is a clean
   * 400, never a DB-overflow 500 (task overflow rule).
   */
  private buildLines(
    resolved: Array<{ product: ResolvedProduct; quantity: bigint }>,
  ): ComputedLines {
    let currency: string | null = null;
    let subtotal = 0n;
    let tax = 0n;
    let total = 0n;
    const items: OrderItemWriteData[] = [];

    for (const { product, quantity } of resolved) {
      if (currency === null) {
        currency = product.currency;
      } else if (currency !== product.currency) {
        throw new BadRequestException('All order lines must share a single currency');
      }
      const unit = product.listPriceAmount;
      const lineSubtotal = unit * quantity;
      const lineTax = (lineSubtotal * BigInt(product.taxRateBp)) / 10000n; // floor (non-negative).
      const lineTotal = lineSubtotal + lineTax;
      items.push({
        productId: product.id,
        productSku: product.sku,
        productName: product.name,
        quantity,
        listPriceAmount: unit,
        unitPriceAmount: unit,
        taxRateBp: product.taxRateBp,
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

    // `currency` is always set: resolveItems guarantees at least one line.
    return { currency: currency as string, items, subtotal, tax, total };
  }

  private assertInRange(value: bigint): void {
    if (value > PG_BIGINT_MAX) {
      throw new BadRequestException('Order amount exceeds the maximum supported value');
    }
  }

  /**
   * The warehouse is already known to be an active row in the actor's own tenant.
   * Re-resolve the scope decision fresh from PostgreSQL: the actor must hold the
   * given permission AND be scoped to this warehouse. A same-tenant out-of-scope
   * actor is a 403 (used when the actor TARGETS a warehouse via the request body).
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
   * Object-level scope on an EXISTING order's warehouse: the actor must be global
   * or explicitly scoped to it. Out of scope (or an un-resolvable actor) → 404, so
   * an order the actor may not see is hidden rather than confirmed (§7b).
   */
  private async assertObjectScope(actor: AuthPrincipal, warehouseId: bigint): Promise<void> {
    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) throw new NotFoundException('Order not found');
    if (!(access.global || access.scopedWarehouseIds.has(warehouseId))) {
      throw new NotFoundException('Order not found');
    }
  }

  /** A human-facing, collision-resistant order number: `ORD-YYYYMMDD-<10 hex>`.
   * Not gapless (gapless numbering is reserved for invoices — CLAUDE rule 11). */
  private generateOrderNo(now: Date): string {
    const y = now.getUTCFullYear().toString();
    const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = now.getUTCDate().toString().padStart(2, '0');
    const suffix = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
    return `ORD-${y}${m}${d}-${suffix}`;
  }

  /** Whether an error is a unique violation on the order_no column (retry trigger). */
  private isOrderNoConflict(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      return false;
    }
    const target = err.meta?.target;
    return JSON.stringify(target ?? '').includes('order_no');
  }

  private actorSnapshot(actor: AuthPrincipal) {
    return {
      id: actor.userId,
      email: actor.email,
      name: actor.fullName,
      rolesSnapshot: actor.roles,
    };
  }

  /** Whitelisted domain projection for the audit before/after (public ids, no
   * secrets, amounts as strings). */
  private auditProjection(o: OrderRow): Record<string, unknown> {
    return {
      orderNo: o.orderNo,
      status: o.status,
      customerId: o.customer.publicId,
      warehouseId: o.warehouse.publicId,
      currency: o.currency,
      subtotal: o.subtotalAmount.toString(),
      vat: o.taxAmount.toString(),
      total: o.grandTotalAmount.toString(),
      itemCount: o.items.length,
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function emptyPage(): OrderListView {
  return { data: [], pageInfo: { nextCursor: null, hasNextPage: false } };
}

/** Opaque cursor = base64url of `o:<lastId>`. */
function encodeCursor(id: bigint): string {
  return Buffer.from(`o:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^o:(\d+)$/.exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
