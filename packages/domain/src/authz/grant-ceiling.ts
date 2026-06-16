/**
 * Grant-ceiling policy (SECURITY_MODEL §2a/§2b, PERMISSION_MATRIX §4).
 *
 * Pure, framework-independent authorization decisions for the four privileged
 * RBAC mutations a future role/user-role/permission management surface will
 * perform:
 *   1. assign a role to a user,
 *   2. remove a role from a user,
 *   3. add a permission to a role,
 *   4. remove a permission from a role.
 *
 * This module makes the DECISION only; it never reads the database. The caller
 * (the API `AuthorizationGrantService`) resolves the actor's company, effective
 * permissions and privilege level STRICTLY from PostgreSQL (never a JWT claim),
 * resolves the target user/role/permission, and hands fully-materialised inputs
 * to these functions. Keeping the rule pure means it is exhaustively unit- and
 * integration-testable and cannot be accidentally coupled to request state.
 *
 * Invariants enforced (deny-by-default — anything not explicitly allowed is
 * denied):
 *   - Tenant: actor, target user and target role must share one company. Being a
 *     protected/system principal NEVER crosses the tenant boundary, so even a
 *     SYSTEM_ADMIN cannot grant into another company.
 *   - Base capability: the actor must hold the relevant non-protected management
 *     permission (`role:manage` for role↔permission edits, `user:assign-role`
 *     for user↔role edits).
 *   - Protected grant: touching a protected role or a protected permission
 *     additionally requires the protected-grant permission
 *     (`role:manage:protected`). It is necessary but not sufficient — the ceiling
 *     and privilege checks below still apply.
 *   - Privilege ceiling: the actor's highest privilege level must be ≥ the target
 *     role's privilege level (an actor cannot reach a role above their own rank).
 *   - Cannot-grant-above-self: the actor may only grant permissions they
 *     themselves already hold. A role can only be assigned if every permission it
 *     confers is within the actor's own effective set. This single rule also
 *     blocks self-escalation: assigning a role to oneself, or adding a permission
 *     to a role one belongs to, can never introduce a permission the actor did
 *     not already have.
 *   - Removal symmetry: removing a role/permission is gated by the SAME checks as
 *     adding it, so a privileged/protected object an actor could not grant also
 *     cannot be stripped by them (removal is not a privilege-escalation channel).
 */

import {
  PROTECTED_GRANT_PERMISSION,
  ROLE_MANAGE_PERMISSION,
  USER_ASSIGN_ROLE_PERMISSION,
} from '../rbac';

/**
 * Why a grant decision was denied (stable codes; map to 403 at the edge).
 *
 * The `*_UNRESOLVED` reasons are produced by the DB-backed service when an
 * actor/target row cannot be loaded (missing, inactive, soft-deleted); the pure
 * policy functions below only ever emit the rule-based reasons.
 */
export type GrantDenyReason =
  | 'ACTOR_UNRESOLVED'
  | 'TARGET_USER_UNRESOLVED'
  | 'TARGET_ROLE_UNRESOLVED'
  | 'TARGET_PERMISSION_UNRESOLVED'
  | 'CROSS_TENANT'
  | 'MISSING_MANAGE_PERMISSION'
  | 'PROTECTED_GRANT_REQUIRED'
  | 'PRIVILEGE_LEVEL_EXCEEDED'
  | 'CEILING_EXCEEDED';

export type GrantDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: GrantDenyReason };

const ALLOW: GrantDecision = { allowed: true } as const;
const deny = (reason: GrantDenyReason): GrantDecision => ({ allowed: false, reason });

/** Actor performing the grant — resolved fresh from PostgreSQL, never a JWT claim. */
export interface GrantActor {
  /** The actor's REAL owning company id (from the DB user row). */
  readonly companyId: bigint;
  /** The actor's effective permission codes (DB-resolved, version-safe). */
  readonly permissions: ReadonlySet<string>;
  /** Highest privilege level among the actor's assigned roles. */
  readonly maxPrivilegeLevel: number;
}

/** Target user a role is being assigned to / removed from. */
export interface GrantTargetUser {
  readonly companyId: bigint;
}

/** Target role being assigned/removed, or edited. */
export interface GrantTargetRole {
  readonly companyId: bigint;
  readonly privilegeLevel: number;
  /** `roles.is_protected` — keys the protected-grant gate (NOT `is_system`: a
   * non-protected system role such as ADMIN is normally manageable). */
  readonly isProtected: boolean;
  /** Effective permission codes this role confers. */
  readonly permissions: ReadonlySet<string>;
}

/** Target permission being added to / removed from a role. */
export interface GrantTargetPermission {
  readonly code: string;
  /** `permissions.is_protected` — keys the protected-grant gate. */
  readonly isProtected: boolean;
}

/** Whether the actor holds every code in `codes` (the cannot-grant-above-self ceiling). */
function ceilingCovers(actor: GrantActor, codes: Iterable<string>): boolean {
  for (const code of codes) {
    if (!actor.permissions.has(code)) return false;
  }
  return true;
}

/**
 * Grant-ceiling decisions. Each method is a total, side-effect-free function over
 * already-resolved inputs and returns an explicit allow/deny with a reason.
 */
export const GrantCeilingPolicy = {
  /** May `actor` assign `role` to `user`? */
  canAssignRoleToUser(
    actor: GrantActor,
    user: GrantTargetUser,
    role: GrantTargetRole,
  ): GrantDecision {
    if (actor.companyId !== user.companyId || actor.companyId !== role.companyId) {
      return deny('CROSS_TENANT');
    }
    if (!actor.permissions.has(USER_ASSIGN_ROLE_PERMISSION)) {
      return deny('MISSING_MANAGE_PERMISSION');
    }
    if (role.isProtected && !actor.permissions.has(PROTECTED_GRANT_PERMISSION)) {
      return deny('PROTECTED_GRANT_REQUIRED');
    }
    if (actor.maxPrivilegeLevel < role.privilegeLevel) {
      return deny('PRIVILEGE_LEVEL_EXCEEDED');
    }
    if (!ceilingCovers(actor, role.permissions)) {
      return deny('CEILING_EXCEEDED');
    }
    return ALLOW;
  },

  /**
   * May `actor` remove `role` from `user`? Gated identically to assignment:
   * stripping a protected/above-ceiling role is itself a privileged act and must
   * not become a back door around the ceiling.
   */
  canRemoveRoleFromUser(
    actor: GrantActor,
    user: GrantTargetUser,
    role: GrantTargetRole,
  ): GrantDecision {
    return this.canAssignRoleToUser(actor, user, role);
  },

  /** May `actor` add `permission` to `role`? */
  canAddPermissionToRole(
    actor: GrantActor,
    role: GrantTargetRole,
    permission: GrantTargetPermission,
  ): GrantDecision {
    if (actor.companyId !== role.companyId) {
      return deny('CROSS_TENANT');
    }
    if (!actor.permissions.has(ROLE_MANAGE_PERMISSION)) {
      return deny('MISSING_MANAGE_PERMISSION');
    }
    if (
      (permission.isProtected || role.isProtected) &&
      !actor.permissions.has(PROTECTED_GRANT_PERMISSION)
    ) {
      return deny('PROTECTED_GRANT_REQUIRED');
    }
    if (actor.maxPrivilegeLevel < role.privilegeLevel) {
      return deny('PRIVILEGE_LEVEL_EXCEEDED');
    }
    if (!actor.permissions.has(permission.code)) {
      return deny('CEILING_EXCEEDED');
    }
    return ALLOW;
  },

  /**
   * May `actor` remove `permission` from `role`? Gated identically to adding it,
   * so an actor cannot edit a protected/higher role they could not otherwise
   * grant into (removal is not a privilege-escalation channel).
   */
  canRemovePermissionFromRole(
    actor: GrantActor,
    role: GrantTargetRole,
    permission: GrantTargetPermission,
  ): GrantDecision {
    return this.canAddPermissionToRole(actor, role, permission);
  },
} as const;
