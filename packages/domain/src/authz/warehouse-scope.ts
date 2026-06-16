/**
 * Warehouse-scope policy (SECURITY_MODEL §3, PERMISSION_MATRIX §3, CLAUDE rule 12).
 *
 * Pure, framework-independent decision for "may this actor act on this warehouse
 * with this permission?". A permission says WHAT may be done; a scope says on
 * WHICH warehouse. Both are required — holding `stock:read` does not, by itself,
 * grant access to any warehouse.
 *
 * This module makes the DECISION only; it never reads the database. The caller
 * (the API `WarehouseScopeService`) resolves the actor's REAL company, effective
 * permissions, explicit warehouse grants and the target warehouse STRICTLY from
 * PostgreSQL (never a JWT claim), and hands fully-materialised inputs here.
 *
 * Invariants (deny-by-default — anything not explicitly allowed is denied):
 *   - Required permission: the actor must hold `requiredPermission`, else deny.
 *   - Tenant: actor.company must equal warehouse.company. Being a protected/system
 *     principal NEVER crosses the tenant boundary, and `warehouse:scope:all` is
 *     scoped to the actor's OWN company only — it never reaches another tenant.
 *   - Global scope: the protected `warehouse:scope:all` permission grants every
 *     warehouse WITHIN the actor's company (checked after the tenant gate).
 *   - Explicit scope: an explicit grant for exactly this warehouse id allows it.
 *   - No role name ever confers implicit scope; the actor's `scopedWarehouseIds`
 *     come only from real `user_warehouse_scopes` rows.
 */

import { WAREHOUSE_SCOPE_ALL } from '../rbac';

/** Why a warehouse-scope decision was denied (stable codes; map to 403 at the edge). */
export type WarehouseScopeDenyReason =
  | 'ACTOR_UNRESOLVED'
  | 'WAREHOUSE_UNRESOLVED'
  | 'MISSING_PERMISSION'
  | 'CROSS_TENANT'
  | 'OUT_OF_SCOPE';

export type WarehouseScopeDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: WarehouseScopeDenyReason };

const ALLOW: WarehouseScopeDecision = { allowed: true } as const;
const deny = (reason: WarehouseScopeDenyReason): WarehouseScopeDecision => ({
  allowed: false,
  reason,
});

/** Actor requesting warehouse access — resolved fresh from PostgreSQL, never a JWT claim. */
export interface ScopeActor {
  /** The actor's REAL owning company id (from the DB user row). */
  readonly companyId: bigint;
  /** The actor's effective permission codes (DB-resolved). */
  readonly permissions: ReadonlySet<string>;
  /** Warehouse ids the actor is EXPLICITLY scoped to (from user_warehouse_scopes). */
  readonly scopedWarehouseIds: ReadonlySet<bigint>;
}

/** Target warehouse — resolved active/non-deleted, with its owning tenant. */
export interface ScopeWarehouse {
  readonly id: bigint;
  readonly companyId: bigint;
}

/**
 * Warehouse-scope decisions. Total, side-effect-free function over already-
 * resolved inputs; returns an explicit allow/deny with a reason.
 */
export const WarehouseScopePolicy = {
  /**
   * May `actor` act on `warehouse` while exercising `requiredPermission`?
   *
   * Evaluation order is deliberate:
   *   1. permission gate (WHAT) — missing → MISSING_PERMISSION;
   *   2. tenant gate — different company → CROSS_TENANT (so `warehouse:scope:all`
   *      never leaks across tenants);
   *   3. global scope — `warehouse:scope:all` allows any same-company warehouse;
   *   4. explicit scope — an exact warehouse grant allows it;
   *   5. otherwise OUT_OF_SCOPE.
   */
  canAccessWarehouseForPermission(
    actor: ScopeActor,
    warehouse: ScopeWarehouse,
    requiredPermission: string,
  ): WarehouseScopeDecision {
    if (!actor.permissions.has(requiredPermission)) {
      return deny('MISSING_PERMISSION');
    }
    if (actor.companyId !== warehouse.companyId) {
      return deny('CROSS_TENANT');
    }
    if (actor.permissions.has(WAREHOUSE_SCOPE_ALL)) {
      return ALLOW;
    }
    if (actor.scopedWarehouseIds.has(warehouse.id)) {
      return ALLOW;
    }
    return deny('OUT_OF_SCOPE');
  },
} as const;
