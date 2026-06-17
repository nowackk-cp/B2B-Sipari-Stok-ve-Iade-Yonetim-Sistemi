import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type {
  StockBalanceListView,
  StockMovementListView,
  StockMovementView,
  StockTransferListView,
  StockTransferView,
} from '@b2b/contracts';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { AuthPrincipal } from '../../common/auth/principal';
import type { RequestMeta } from '../../common/http/request-meta';
import { isBigIntStringInRange } from '../../common/validation/is-bigint-string.decorator';
import { PrismaService } from '../../common/database/prisma.service';
import { WarehouseScopeService } from '../authorization/warehouse-scope.service';
import {
  StockRepository,
  type MovementRow,
  type ResolvedProduct,
  type ResolvedWarehouse,
  type TransferRow,
} from './stock.repository';
import { toBalanceView, toMovementView } from './stock-view';
import { toTransferView } from './transfer-view';
import type { CreateStockAdjustmentDto } from './dto/create-adjustment.dto';
import type { CreateStockTransferDto } from './dto/create-transfer.dto';
import type { ListStockBalancesQuery } from './dto/list-balances.query';
import type { ListStockMovementsQuery } from './dto/list-movements.query';
import type { ListStockTransfersQuery } from './dto/list-transfers.query';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STOCK_ADJUST = 'stock:adjust';
const STOCK_TRANSFER = 'stock:transfer';

/**
 * Inventory application service (Stock Ledger Foundation).
 *
 * Builds the append-only stock ledger + the derived current balance on top of
 * the canonical `stock_ledger`/`stock_balances` tables (DATABASE_DESIGN §6). The
 * task's `direction`+`quantity` command is mapped onto the canonical SIGNED
 * ledger quantity and `change_type = ADJUSTMENT`.
 *
 * Three controls guard every operation, all resolved from PostgreSQL (never a
 * JWT claim or the request body):
 *   1. PERMISSION — the route's `@RequirePermissions` (`stock:read`/`stock:adjust`).
 *   2. TENANT — the warehouse AND product are resolved WITHIN `actor.companyId`;
 *      a cross-company id is a 404 (entity hiding). Resolving both inside one
 *      company also enforces "product and warehouse share a company" (rule 9).
 *   3. WAREHOUSE SCOPE — beyond holding the permission, the actor must be scoped
 *      to the specific warehouse (explicit grant or protected `warehouse:scope:all`),
 *      decided fresh by {@link WarehouseScopeService}. No role name confers scope.
 *
 * The adjustment runs in ONE transaction: lock the balance row, compute the new
 * on-hand, reject a negative result (409), append the ledger movement, write the
 * business audit — all atomic (ADR-007, DATABASE_DESIGN §18 "Stok düzeltme").
 */
@Injectable()
export class StockService {
  constructor(
    private readonly repo: StockRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly scope: WarehouseScopeService,
  ) {}

  // --- reservation (order approval; cross-module API) -----------------------

  /**
   * Reserve stock for an order being APPROVED, INSIDE the caller's transaction
   * (orders → inventory; MODULE_BOUNDARIES §3.1 — orders never writes stock tables
   * directly, it calls this service). The caller (OrdersService) owns the
   * transaction, the order row lock and the expected-status transition; this method
   * only touches inventory-owned tables (`stock_balances`, `stock_reservations`).
   *
   * For EVERY line, in a deterministic product-id order (ADR-003 §6 — the order has
   * a single warehouse, so ordering by product id is a total, deadlock-safe lock
   * order), it locks the (product, warehouse) balance FOR UPDATE and checks
   * `available = on_hand - reserved >= quantity`. The check is ALL-OR-NOTHING: a
   * single shortfall throws {@link ConflictException} (409), which rolls the whole
   * transaction back, so the order stays DRAFT and NOTHING is reserved (ORDER_RULES
   * §3). On success it increments `reserved` (NOT `on_hand`) and writes one ACTIVE
   * `stock_reservations` row per line. No `stock_ledger` movement is written — a
   * reservation never changes on_hand, so it is not a ledger event (INVENTORY_RULES
   * §5, STK-3). The DB CHECK `reserved <= on_hand` is the last-line safety net.
   */
  async reserve(
    tx: Prisma.TransactionClient,
    params: {
      orderId: bigint;
      warehouseId: bigint;
      items: ReadonlyArray<{ orderItemId: bigint; productId: bigint; quantity: bigint }>;
    },
  ): Promise<void> {
    // Deterministic lock order (product id ascending; warehouse is constant for an
    // order) — prevents deadlocks against concurrent reservations on the same rows.
    const items = [...params.items].sort((a, b) =>
      a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
    );

    // Pass 1: lock EVERY balance row and verify availability under the locks. Doing
    // all checks before any write makes the all-or-nothing guarantee explicit; the
    // FOR UPDATE locks acquired here are held until commit, so the values cannot
    // change before pass 2 applies them.
    for (const item of items) {
      const bal = await this.repo.lockBalanceForReserve(tx, item.productId, params.warehouseId);
      const available = bal.onHand - bal.reserved;
      if (available < item.quantity) {
        throw new ConflictException('Insufficient available stock to approve the order');
      }
    }

    // Pass 2: apply — every line passed, so reserve all (reserved += qty) and write
    // the ACTIVE reservation rows. on_hand is untouched; no ledger movement.
    for (const item of items) {
      await this.repo.addReserved(tx, item.productId, params.warehouseId, item.quantity);
      await this.repo.insertReservation(tx, {
        orderId: params.orderId,
        orderItemId: item.orderItemId,
        productId: item.productId,
        warehouseId: params.warehouseId,
        quantity: item.quantity,
        idempotencyKey: `ORDER_RESERVATION:${params.orderId.toString()}:${item.orderItemId.toString()}`,
      });
    }
  }

  // --- command --------------------------------------------------------------

  async adjust(
    actor: AuthPrincipal,
    dto: CreateStockAdjustmentDto,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<StockMovementView> {
    // Idempotency-Key is mandatory for this stock mutation (API_CONVENTIONS §6 /
    // task rule 17): a missing/blank header is rejected before any side effect.
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required for stock adjustments');
    }
    // `quantity` is a validated BIGINT string; an adjustment must MOVE stock, so
    // reject 0 here (negative/decimal/over-range are already rejected by the DTO).
    if (!isBigIntStringInRange(dto.quantity)) {
      throw new BadRequestException('quantity must be a positive integer string');
    }
    const magnitude = BigInt(dto.quantity);
    if (magnitude <= 0n) {
      throw new BadRequestException('quantity must be greater than zero');
    }
    const signed = dto.direction === 'INCREASE' ? magnitude : -magnitude;

    // Tenant + lifecycle: both must be ACTIVE rows in the actor's own company.
    const warehouse = await this.repo.findActiveWarehouse(actor.companyId, dto.warehouseId);
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    const product = await this.repo.findActiveProduct(actor.companyId, dto.productId);
    if (!product) throw new NotFoundException('Product not found');

    // Warehouse scope: holding stock:adjust is not enough — the actor must be
    // scoped to THIS warehouse (explicit grant or warehouse:scope:all).
    await this.assertWarehouseScope(actor, warehouse.id, STOCK_ADJUST);

    // Idempotency: the ledger key is deterministic per (company, client key). A
    // replay returns the SAME movement and creates no duplicate; the same key
    // with a DIFFERENT payload is a conflict (409).
    const ledgerKey = `ADJUSTMENT:${actor.companyId.toString()}:${key}`;
    const existing = await this.repo.findMovementByKey(ledgerKey);
    if (existing) {
      return this.replayOrConflict(existing, warehouse.id, product.id, signed, dto.reason);
    }

    try {
      const movement = await this.prisma.transaction(async (tx) => {
        // Serialise on this product+warehouse balance (FOR UPDATE), so concurrent
        // adjustments cannot lose an update or race past the negative check.
        const before = await this.repo.lockBalanceOnHand(tx, product.id, warehouse.id);
        const after = before + signed;
        if (after < 0n) {
          throw new ConflictException('Adjustment would drive on-hand stock negative');
        }
        await this.repo.setBalanceOnHand(tx, product.id, warehouse.id, after);
        const row = await this.repo.insertAdjustmentMovement(tx, {
          productId: product.id,
          warehouseId: warehouse.id,
          quantitySigned: signed,
          balanceAfter: after,
          idempotencyKey: ledgerKey,
          reason: dto.reason,
          createdById: actor.userId,
        });
        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.STOCK_ADJUSTED,
          actor: this.actorSnapshot(actor),
          entityType: 'stock_movement',
          entityId: row.id,
          before: { onHand: before.toString() },
          after: this.auditProjection(
            product,
            warehouse,
            dto.direction,
            magnitude,
            after,
            dto.reason,
          ),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return row;
      });
      return toMovementView(movement);
    } catch (err) {
      // A concurrent request with the SAME idempotency key won the ledger-unique
      // race: the whole transaction rolled back with no side effects. Re-read and
      // replay the winner's movement (or surface a payload mismatch).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await this.repo.findMovementByKey(ledgerKey);
        if (row) return this.replayOrConflict(row, warehouse.id, product.id, signed, dto.reason);
      }
      throw err;
    }
  }

  /**
   * Atomically transfer one product from a source warehouse to a destination
   * warehouse WITHIN the actor's company (Stock Transfer Foundation).
   *
   * In ONE transaction: insert the immutable transfer record, lock BOTH balance
   * rows in a deterministic order (by warehouse id — same product, so this avoids
   * AB/BA deadlocks under opposite-direction concurrency), reject a negative
   * source result (409), decrement source / increment destination, append the two
   * correlated append-only ledger movements (TRANSFER_OUT + TRANSFER_IN, sharing
   * `reference_id = transfer.id`), and write the business audit — all atomic.
   *
   * The same three PostgreSQL-resolved controls as `adjust` apply, extended to
   * BOTH warehouses: permission (`stock:transfer`), tenant (product + both
   * warehouses resolved inside `actor.companyId`; cross-tenant → 404), and
   * warehouse SCOPE (the actor must be scoped to BOTH the source AND the
   * destination). `Idempotency-Key` makes a client retry a no-op replay.
   */
  async transfer(
    actor: AuthPrincipal,
    dto: CreateStockTransferDto,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<StockTransferView> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required for stock transfers');
    }
    if (!isBigIntStringInRange(dto.quantity)) {
      throw new BadRequestException('quantity must be a positive integer string');
    }
    const quantity = BigInt(dto.quantity);
    if (quantity <= 0n) {
      throw new BadRequestException('quantity must be greater than zero');
    }
    // Source and destination must differ (also a DB CHECK — last-line safety).
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BadRequestException('source and destination warehouse must differ');
    }

    // Tenant + lifecycle: product and BOTH warehouses must be ACTIVE rows in the
    // actor's own company (resolving inside one company also enforces "all three
    // share a company" — rules 8/9/10/11).
    const from = await this.repo.findActiveWarehouse(actor.companyId, dto.fromWarehouseId);
    if (!from) throw new NotFoundException('Source warehouse not found');
    const to = await this.repo.findActiveWarehouse(actor.companyId, dto.toWarehouseId);
    if (!to) throw new NotFoundException('Destination warehouse not found');
    const product = await this.repo.findActiveProduct(actor.companyId, dto.productId);
    if (!product) throw new NotFoundException('Product not found');

    // Warehouse scope: holding stock:transfer is not enough — the actor must be
    // scoped to BOTH the source AND the destination (rule 12). `scope:all` is only
    // honoured within the same company (rule 13), enforced by WarehouseScopeService.
    await this.assertWarehouseScope(actor, from.id, STOCK_TRANSFER);
    await this.assertWarehouseScope(actor, to.id, STOCK_TRANSFER);

    // Idempotency: a replay returns the SAME transfer and creates no duplicate; the
    // same key with a DIFFERENT payload is a conflict (409).
    const existing = await this.repo.findTransferByKey(actor.companyId, key);
    if (existing) {
      return this.replayOrConflictTransfer(
        existing,
        from.id,
        to.id,
        product.id,
        quantity,
        dto.reason,
      );
    }

    try {
      const record = await this.prisma.transaction(async (tx) => {
        // The transfer record is inserted first: the (company, key) unique is the
        // concurrency guard for same-key requests (the loser hits P2002 below and
        // rolls back its whole transaction, leaving balances untouched).
        const rec = await this.repo.insertTransferRecord(tx, {
          companyId: actor.companyId,
          productId: product.id,
          fromWarehouseId: from.id,
          toWarehouseId: to.id,
          quantity,
          reason: dto.reason,
          idempotencyKey: key,
          createdById: actor.userId,
        });

        // Lock BOTH balance rows in a deterministic order (lowest warehouse id
        // first). Same product, so ordering by warehouse id is total and identical
        // for A→B and B→A — concurrent opposite transfers can never deadlock.
        const [firstWh, secondWh] = from.id < to.id ? [from.id, to.id] : [to.id, from.id];
        const firstBefore = await this.repo.lockBalanceOnHand(tx, product.id, firstWh);
        const secondBefore = await this.repo.lockBalanceOnHand(tx, product.id, secondWh);
        const beforeByWh = new Map<bigint, bigint>([
          [firstWh, firstBefore],
          [secondWh, secondBefore],
        ]);
        const fromBefore = beforeByWh.get(from.id)!;
        const toBefore = beforeByWh.get(to.id)!;

        // Negative check UNDER the lock (rule: source balance can never go < 0).
        const fromAfter = fromBefore - quantity;
        if (fromAfter < 0n) {
          throw new ConflictException('Insufficient stock in the source warehouse');
        }
        const toAfter = toBefore + quantity;

        await this.repo.setBalanceOnHand(tx, product.id, from.id, fromAfter);
        await this.repo.setBalanceOnHand(tx, product.id, to.id, toAfter);

        // Two correlated append-only movements, bound by reference_id = rec.id.
        await this.repo.insertTransferMovement(tx, {
          productId: product.id,
          warehouseId: from.id,
          changeType: 'TRANSFER_OUT',
          quantitySigned: -quantity,
          balanceAfter: fromAfter,
          transferId: rec.id,
          idempotencyKey: `TRANSFER_OUT:${rec.id.toString()}`,
          reason: dto.reason,
          createdById: actor.userId,
        });
        await this.repo.insertTransferMovement(tx, {
          productId: product.id,
          warehouseId: to.id,
          changeType: 'TRANSFER_IN',
          quantitySigned: quantity,
          balanceAfter: toAfter,
          transferId: rec.id,
          idempotencyKey: `TRANSFER_IN:${rec.id.toString()}`,
          reason: dto.reason,
          createdById: actor.userId,
        });

        await this.audit.write(tx, {
          action: AUDIT_ACTIONS.STOCK_TRANSFERRED,
          actor: this.actorSnapshot(actor),
          entityType: 'stock_transfer',
          entityId: rec.id,
          before: {
            from: { onHand: fromBefore.toString() },
            to: { onHand: toBefore.toString() },
          },
          after: this.transferAuditProjection(
            product,
            from,
            to,
            quantity,
            fromAfter,
            toAfter,
            dto.reason,
          ),
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return rec;
      });
      return toTransferView(record);
    } catch (err) {
      // A concurrent request with the SAME key won the (company, key) race: the
      // whole transaction rolled back with no side effects. Re-read and replay.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await this.repo.findTransferByKey(actor.companyId, key);
        if (row) {
          return this.replayOrConflictTransfer(
            row,
            from.id,
            to.id,
            product.id,
            quantity,
            dto.reason,
          );
        }
      }
      throw err;
    }
  }

  // --- reads ----------------------------------------------------------------

  async listBalances(
    actor: AuthPrincipal,
    query: ListStockBalancesQuery,
  ): Promise<StockBalanceListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor, 'sb');

    const scoped = await this.resolveScope(actor, query.warehouseId, query.productId);
    if (!scoped) return emptyPage();

    const rows = await this.repo.listBalances(actor.companyId, {
      cursorId,
      take: limit + 1,
      onlyIds: scoped.onlyIds,
      warehouseId: scoped.warehouseId,
      productId: scoped.productId,
    });
    return paginate(rows, limit, toBalanceView, (last) => encodeCursor(last.id, 'sb'));
  }

  async listMovements(
    actor: AuthPrincipal,
    query: ListStockMovementsQuery,
  ): Promise<StockMovementListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor, 'sm');

    const scoped = await this.resolveScope(actor, query.warehouseId, query.productId);
    if (!scoped) return emptyPage();

    const rows = await this.repo.listMovements(actor.companyId, {
      cursorId,
      take: limit + 1,
      onlyIds: scoped.onlyIds,
      warehouseId: scoped.warehouseId,
      productId: scoped.productId,
    });
    return paginate(rows, limit, toMovementView, (last) => encodeCursor(last.id, 'sm'));
  }

  /**
   * List the transfers the caller may see (paginated). Scope-filtered: a global
   * actor sees every same-company transfer; an explicitly-scoped actor sees only
   * transfers whose SOURCE or DESTINATION is one of their scoped warehouses; an
   * actor with no scope sees nothing (deny-by-default). Optional warehouse/product
   * filters are intersected with that scope and can never widen it.
   */
  async listTransfers(
    actor: AuthPrincipal,
    query: ListStockTransfersQuery,
  ): Promise<StockTransferListView> {
    const limit = clampLimit(query.limit);
    const cursorId = decodeCursor(query.cursor, 'st');

    const scoped = await this.resolveScope(actor, query.warehouseId, query.productId);
    if (!scoped) return emptyPage();

    const rows = await this.repo.listTransfers(actor.companyId, {
      cursorId,
      take: limit + 1,
      onlyIds: scoped.onlyIds,
      warehouseId: scoped.warehouseId,
      productId: scoped.productId,
    });
    return paginate(rows, limit, toTransferView, (last) => encodeCursor(last.id, 'st'));
  }

  /**
   * Get one transfer by public id. The caller must hold `stock:read` (route guard)
   * and be scoped to the transfer's SOURCE or DESTINATION warehouse. A transfer in
   * another tenant, or one the actor has no scope to, is hidden as a 404 (entity
   * hiding — API_CONVENTIONS §7b), never an information-leaking 403.
   */
  async getTransfer(actor: AuthPrincipal, publicId: string): Promise<StockTransferView> {
    const row = await this.repo.findTransferByPublicId(actor.companyId, publicId);
    if (!row) throw new NotFoundException('Transfer not found');

    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) throw new NotFoundException('Transfer not found');
    const inScope =
      access.global ||
      access.scopedWarehouseIds.has(row.fromWarehouseId) ||
      access.scopedWarehouseIds.has(row.toWarehouseId);
    if (!inScope) throw new NotFoundException('Transfer not found');

    return toTransferView(row);
  }

  // --- internals ------------------------------------------------------------

  /**
   * Resolve the warehouse-access envelope for a list read and translate the
   * optional public-id filters into internal ids, INTERSECTED with scope. Returns
   * null when the read must yield nothing (actor cannot act, or a filter targets
   * a warehouse/product that is out of scope / not in the tenant) — a filter can
   * never widen access. `onlyIds` is undefined for a global actor.
   */
  private async resolveScope(
    actor: AuthPrincipal,
    warehousePublicId: string | undefined,
    productPublicId: string | undefined,
  ): Promise<{
    onlyIds?: ReadonlySet<bigint>;
    warehouseId?: bigint;
    productId?: bigint;
  } | null> {
    const access = await this.scope.resolveWarehouseAccess(actor.userId);
    if (!access) return null; // deny-by-default: missing/suspended/deleted actor.
    const onlyIds = access.global ? undefined : access.scopedWarehouseIds;

    let warehouseId: bigint | undefined;
    if (warehousePublicId) {
      const wh = await this.repo.findActiveWarehouse(actor.companyId, warehousePublicId);
      if (!wh) return null; // unknown / other tenant → empty (entity hiding).
      if (onlyIds && !onlyIds.has(wh.id)) return null; // out of scope → empty.
      warehouseId = wh.id;
    }

    let productId: bigint | undefined;
    if (productPublicId) {
      const product = await this.repo.findActiveProduct(actor.companyId, productPublicId);
      if (!product) return null;
      productId = product.id;
    }

    return { onlyIds, warehouseId, productId };
  }

  /**
   * The warehouse is already known to be an active row in the actor's own tenant.
   * Re-resolve the scope decision fresh from PostgreSQL: the actor must hold the
   * given permission AND be scoped to this warehouse. A same-tenant out-of-scope
   * actor is a 403 — never a silent allow.
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

  /** Decide whether a found movement is an idempotent replay (same payload) or a
   * key reuse with a different payload (409). The ledger row carries the full
   * adjustment payload (product, warehouse, signed quantity, reason). */
  private replayOrConflict(
    existing: MovementRow,
    warehouseId: bigint,
    productId: bigint,
    signed: bigint,
    reason: string,
  ): StockMovementView {
    const samePayload =
      existing.warehouseId === warehouseId &&
      existing.productId === productId &&
      existing.quantity === signed &&
      (existing.reason ?? '') === reason;
    if (!samePayload) {
      throw new ConflictException('Idempotency-Key was reused with a different payload');
    }
    return toMovementView(existing);
  }

  /** Decide whether a found transfer is an idempotent replay (same payload) or a
   * key reuse with a different payload (409). The record carries the full transfer
   * payload (product, source, destination, quantity, reason). */
  private replayOrConflictTransfer(
    existing: TransferRow,
    fromWarehouseId: bigint,
    toWarehouseId: bigint,
    productId: bigint,
    quantity: bigint,
    reason: string,
  ): StockTransferView {
    const samePayload =
      existing.fromWarehouseId === fromWarehouseId &&
      existing.toWarehouseId === toWarehouseId &&
      existing.productId === productId &&
      existing.quantity === quantity &&
      (existing.reason ?? '') === reason;
    if (!samePayload) {
      throw new ConflictException('Idempotency-Key was reused with a different payload');
    }
    return toTransferView(existing);
  }

  private actorSnapshot(actor: AuthPrincipal) {
    return {
      id: actor.userId,
      email: actor.email,
      name: actor.fullName,
      rolesSnapshot: actor.roles,
    };
  }

  /** Whitelisted domain projection for the audit `after` (public ids, no secrets). */
  private auditProjection(
    product: ResolvedProduct,
    warehouse: ResolvedWarehouse,
    direction: string,
    magnitude: bigint,
    balanceAfter: bigint,
    reason: string,
  ): Record<string, unknown> {
    return {
      warehouseId: warehouse.publicId,
      productId: product.publicId,
      direction,
      quantity: magnitude.toString(),
      balanceAfter: balanceAfter.toString(),
      reason,
    };
  }

  /** Whitelisted domain projection for the transfer audit `after` (public ids, no
   * secrets): both endpoints, the quantity and the resulting balances. */
  private transferAuditProjection(
    product: ResolvedProduct,
    from: ResolvedWarehouse,
    to: ResolvedWarehouse,
    quantity: bigint,
    fromBalanceAfter: bigint,
    toBalanceAfter: bigint,
    reason: string,
  ): Record<string, unknown> {
    return {
      productId: product.publicId,
      fromWarehouseId: from.publicId,
      toWarehouseId: to.publicId,
      quantity: quantity.toString(),
      fromBalanceAfter: fromBalanceAfter.toString(),
      toBalanceAfter: toBalanceAfter.toString(),
      reason,
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function emptyPage<T>(): { data: T[]; pageInfo: { nextCursor: null; hasNextPage: false } } {
  return { data: [], pageInfo: { nextCursor: null, hasNextPage: false } };
}

/** Slice a `take = limit + 1` result into a page + next cursor. */
function paginate<TRow extends { id: bigint }, TView>(
  rows: TRow[],
  limit: number,
  toView: (row: TRow) => TView,
  cursorOf: (last: TRow) => string,
): { data: TView[]; pageInfo: { nextCursor: string | null; hasNextPage: boolean } } {
  const hasNextPage = rows.length > limit;
  const page = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor = hasNextPage ? cursorOf(page[page.length - 1]!) : null;
  return { data: page.map(toView), pageInfo: { nextCursor, hasNextPage } };
}

/** Opaque cursor = base64url of `<prefix>:<lastId>`. */
function encodeCursor(id: bigint, prefix: string): string {
  return Buffer.from(`${prefix}:${id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, prefix: string): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = new RegExp(`^${prefix}:(\\d+)$`).exec(decoded);
    if (!match) throw new Error('bad cursor');
    return BigInt(match[1]!);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }
}
