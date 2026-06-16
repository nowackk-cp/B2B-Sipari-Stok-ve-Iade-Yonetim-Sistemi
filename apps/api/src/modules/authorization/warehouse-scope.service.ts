import { Injectable } from '@nestjs/common';
import {
  WAREHOUSE_SCOPE_ALL,
  WarehouseScopePolicy,
  type ScopeActor,
  type ScopeWarehouse,
  type WarehouseScopeDecision,
} from '@b2b/domain';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';
import { PermissionRepository } from './permission.repository';

/**
 * Warehouse-scope service (SECURITY_MODEL §3, PERMISSION_MATRIX §3).
 *
 * The DB-backed orchestrator in front of the pure {@link WarehouseScopePolicy}: it
 * resolves the actor, the target warehouse and the actor's explicit warehouse
 * grants from PostgreSQL and delegates the allow/deny decision to the policy. It
 * writes NOTHING and exposes NO HTTP surface — it is the reusable scope-decision
 * core that depot-bound feature modules (stock, transfer, warehouse-bound orders)
 * will call before a single-warehouse action.
 *
 * Trust rules (deny-by-default):
 *   - The actor's company, effective permissions and explicit warehouse grants are
 *     read ONLY from the database (never a JWT claim). Effective permissions come
 *     from {@link PermissionRepository.loadEffectivePermissionCodes} — a direct,
 *     tenant-scoped read — so the decision never rides on a stale authorization
 *     cache entry (matching AuthorizationGrantService).
 *   - An inactive/soft-deleted actor, an inactive/soft-deleted warehouse, a missing
 *     permission, a cross-tenant warehouse or an un-scoped warehouse all DENY.
 *   - `warehouse:scope:all` grants every warehouse WITHIN the actor's own company
 *     only; it never reaches another tenant.
 *
 * Callers may pass a transaction handle so the decision reads the same snapshot as
 * the mutation it guards (DATABASE_DESIGN §18: the top-level service owns the
 * transaction; this service never opens its own).
 */
@Injectable()
export class WarehouseScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionRepository,
  ) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /**
   * Resolve the actor from PostgreSQL. Returns null when the actor cannot act:
   * the user row is missing, suspended/not active, or soft-deleted. Effective
   * permissions are the fresh, tenant-scoped DB set; explicit warehouse grants are
   * the actor's `user_warehouse_scopes` rows in their own company.
   */
  private async resolveActor(actorUserId: bigint, executor?: DbClient): Promise<ScopeActor | null> {
    const db = this.db(executor);
    const user = await db.user.findFirst({
      where: { id: actorUserId, status: 'ACTIVE', deletedAt: null },
      select: { companyId: true },
    });
    if (!user) return null;

    const [codes, scopes] = await Promise.all([
      this.permissions.loadEffectivePermissionCodes(actorUserId, user.companyId, db),
      db.userWarehouseScope.findMany({
        where: { userId: actorUserId, companyId: user.companyId },
        select: { warehouseId: true },
      }),
    ]);

    return {
      companyId: user.companyId,
      permissions: new Set(codes),
      scopedWarehouseIds: new Set(scopes.map((s) => s.warehouseId)),
    };
  }

  /**
   * Resolve an ACTIVE, non-deleted warehouse (an inactive/soft-deleted warehouse
   * can never be a scope target — rule 7).
   */
  private async resolveWarehouse(
    warehouseId: bigint,
    executor?: DbClient,
  ): Promise<ScopeWarehouse | null> {
    const warehouse = await this.db(executor).warehouse.findFirst({
      where: { id: warehouseId, isActive: true, deletedAt: null },
      select: { id: true, companyId: true },
    });
    return warehouse ? { id: warehouse.id, companyId: warehouse.companyId } : null;
  }

  /**
   * May `actorUserId` act on `warehouseId` while exercising `requiredPermission`?
   *
   * Resolves everything from PostgreSQL and defers to {@link WarehouseScopePolicy}.
   * A missing/inactive/deleted actor or warehouse fails closed (never an allow).
   */
  async canAccessWarehouseForPermission(
    actorUserId: bigint,
    warehouseId: bigint,
    requiredPermission: string,
    executor?: DbClient,
  ): Promise<WarehouseScopeDecision> {
    const db = this.db(executor);
    const actor = await this.resolveActor(actorUserId, db);
    if (!actor) return DENY_ACTOR;
    const warehouse = await this.resolveWarehouse(warehouseId, db);
    if (!warehouse) return DENY_WAREHOUSE;
    return WarehouseScopePolicy.canAccessWarehouseForPermission(
      actor,
      warehouse,
      requiredPermission,
    );
  }

  /** Whether the actor has company-wide warehouse access (protected scope:all). */
  async hasGlobalWarehouseScope(actorUserId: bigint, executor?: DbClient): Promise<boolean> {
    const actor = await this.resolveActor(actorUserId, executor);
    return actor?.permissions.has(WAREHOUSE_SCOPE_ALL) ?? false;
  }

  /**
   * Resolve the actor's warehouse-access envelope for a LIST query: their own
   * tenant, whether they hold global scope (`warehouse:scope:all`) and the exact
   * set of explicitly-scoped warehouse ids — all from PostgreSQL (never a JWT
   * claim). Returns null when the actor cannot act (missing/suspended/deleted),
   * which the caller treats as "no accessible warehouses" (deny-by-default).
   *
   * This is the list-shaped companion to {@link canAccessWarehouseForPermission}
   * (which decides a single warehouse): a warehouse-management list endpoint uses
   * it to show ONLY the warehouses the actor may see — every same-company
   * warehouse when global, otherwise just the explicitly-scoped ones.
   */
  async resolveWarehouseAccess(
    actorUserId: bigint,
    executor?: DbClient,
  ): Promise<{
    companyId: bigint;
    global: boolean;
    scopedWarehouseIds: ReadonlySet<bigint>;
  } | null> {
    const actor = await this.resolveActor(actorUserId, executor);
    if (!actor) return null;
    return {
      companyId: actor.companyId,
      global: actor.permissions.has(WAREHOUSE_SCOPE_ALL),
      scopedWarehouseIds: actor.scopedWarehouseIds,
    };
  }
}

// Stable deny results for the "could not resolve a row" cases — denies (never
// allows) so a missing/inactive/soft-deleted subject always fails closed.
const DENY_ACTOR: WarehouseScopeDecision = { allowed: false, reason: 'ACTOR_UNRESOLVED' };
const DENY_WAREHOUSE: WarehouseScopeDecision = { allowed: false, reason: 'WAREHOUSE_UNRESOLVED' };
