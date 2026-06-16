import { Injectable } from '@nestjs/common';
import {
  GrantCeilingPolicy,
  type GrantActor,
  type GrantDecision,
  type GrantTargetPermission,
  type GrantTargetRole,
  type GrantTargetUser,
} from '@b2b/domain';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';
import { PermissionRepository } from './permission.repository';

/**
 * Grant-ceiling service (SECURITY_MODEL §2a/§2b, PERMISSION_MATRIX §4).
 *
 * The DB-backed orchestrator in front of the pure {@link GrantCeilingPolicy}: it
 * resolves the actor and target rows from PostgreSQL and delegates the actual
 * allow/deny decision to the policy. It writes NOTHING and exposes NO HTTP
 * surface — it is the reusable authorization core a later role/user-role/
 * permission management module will call before performing a privileged mutation.
 *
 * Trust rules:
 *   - The actor's company, effective permissions and privilege level are read
 *     ONLY from the database (never a JWT claim). Effective permissions come from
 *     {@link PermissionRepository.loadEffectivePermissionCodes}, a direct,
 *     uncached, tenant-scoped read — so a grant decision can never ride on a stale
 *     authorization-cache entry (PG-004 / rule 11).
 *   - Every "not resolvable" case (inactive/deleted/cross-tenant actor or target,
 *     missing role/permission) returns a DENY, never an allow — deny-by-default.
 *
 * Callers may pass a transaction handle so the decision reads the same snapshot
 * as the mutation it guards (DATABASE_DESIGN §18: the top-level service owns the
 * transaction; this service never opens its own).
 */
@Injectable()
export class AuthorizationGrantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionRepository,
  ) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /**
   * Resolve the actor from PostgreSQL. Returns null when the actor cannot act:
   * the user row is missing, suspended/not active, or soft-deleted. Privilege
   * level is the max over the actor's OWN-company role assignments; effective
   * permissions are the fresh, tenant-scoped DB set.
   */
  private async resolveActor(actorUserId: bigint, executor?: DbClient): Promise<GrantActor | null> {
    const db = this.db(executor);
    const user = await db.user.findFirst({
      where: { id: actorUserId, status: 'ACTIVE', deletedAt: null },
      select: {
        companyId: true,
        roles: { select: { role: { select: { companyId: true, privilegeLevel: true } } } },
      },
    });
    if (!user) return null;
    // Composite FKs already pin assignments to the user's company; filter defensively.
    const levels = user.roles
      .filter((r) => r.role.companyId === user.companyId)
      .map((r) => r.role.privilegeLevel);
    const maxPrivilegeLevel = levels.length > 0 ? Math.max(...levels) : -1;
    const codes = await this.permissions.loadEffectivePermissionCodes(
      actorUserId,
      user.companyId,
      db,
    );
    return { companyId: user.companyId, permissions: new Set(codes), maxPrivilegeLevel };
  }

  /** Resolve an ACTIVE, non-deleted target user (an inactive/deleted user can't be a target). */
  private async resolveTargetUser(
    userId: bigint,
    executor?: DbClient,
  ): Promise<GrantTargetUser | null> {
    const user = await this.db(executor).user.findFirst({
      where: { id: userId, status: 'ACTIVE', deletedAt: null },
      select: { companyId: true },
    });
    return user ? { companyId: user.companyId } : null;
  }

  /** Resolve a role with the permission codes it confers (a missing/deleted role can't be a target). */
  private async resolveRole(roleId: bigint, executor?: DbClient): Promise<GrantTargetRole | null> {
    const role = await this.db(executor).role.findUnique({
      where: { id: roleId },
      select: {
        companyId: true,
        privilegeLevel: true,
        isProtected: true,
        permissions: { select: { permission: { select: { code: true } } } },
      },
    });
    if (!role) return null;
    return {
      companyId: role.companyId,
      privilegeLevel: role.privilegeLevel,
      isProtected: role.isProtected,
      permissions: new Set(role.permissions.map((rp) => rp.permission.code)),
    };
  }

  /** Resolve a catalog permission (global, not tenant-scoped). */
  private async resolvePermission(
    permissionId: bigint,
    executor?: DbClient,
  ): Promise<GrantTargetPermission | null> {
    const perm = await this.db(executor).permission.findUnique({
      where: { id: permissionId },
      select: { code: true, isProtected: true },
    });
    return perm ? { code: perm.code, isProtected: perm.isProtected } : null;
  }

  /** May `actorUserId` assign `roleId` to `targetUserId`? */
  async canAssignRoleToUser(
    actorUserId: bigint,
    targetUserId: bigint,
    roleId: bigint,
    executor?: DbClient,
  ): Promise<GrantDecision> {
    const db = this.db(executor);
    const actor = await this.resolveActor(actorUserId, db);
    if (!actor) return DENY_ACTOR;
    const user = await this.resolveTargetUser(targetUserId, db);
    if (!user) return DENY_TARGET_USER;
    const role = await this.resolveRole(roleId, db);
    if (!role) return DENY_TARGET_ROLE;
    return GrantCeilingPolicy.canAssignRoleToUser(actor, user, role);
  }

  /** May `actorUserId` remove `roleId` from `targetUserId`? */
  async canRemoveRoleFromUser(
    actorUserId: bigint,
    targetUserId: bigint,
    roleId: bigint,
    executor?: DbClient,
  ): Promise<GrantDecision> {
    const db = this.db(executor);
    const actor = await this.resolveActor(actorUserId, db);
    if (!actor) return DENY_ACTOR;
    const user = await this.resolveTargetUser(targetUserId, db);
    if (!user) return DENY_TARGET_USER;
    const role = await this.resolveRole(roleId, db);
    if (!role) return DENY_TARGET_ROLE;
    return GrantCeilingPolicy.canRemoveRoleFromUser(actor, user, role);
  }

  /** May `actorUserId` add `permissionId` to `roleId`? */
  async canAddPermissionToRole(
    actorUserId: bigint,
    roleId: bigint,
    permissionId: bigint,
    executor?: DbClient,
  ): Promise<GrantDecision> {
    const db = this.db(executor);
    const actor = await this.resolveActor(actorUserId, db);
    if (!actor) return DENY_ACTOR;
    const role = await this.resolveRole(roleId, db);
    if (!role) return DENY_TARGET_ROLE;
    const permission = await this.resolvePermission(permissionId, db);
    if (!permission) return DENY_TARGET_PERMISSION;
    return GrantCeilingPolicy.canAddPermissionToRole(actor, role, permission);
  }

  /** May `actorUserId` remove `permissionId` from `roleId`? */
  async canRemovePermissionFromRole(
    actorUserId: bigint,
    roleId: bigint,
    permissionId: bigint,
    executor?: DbClient,
  ): Promise<GrantDecision> {
    const db = this.db(executor);
    const actor = await this.resolveActor(actorUserId, db);
    if (!actor) return DENY_ACTOR;
    const role = await this.resolveRole(roleId, db);
    if (!role) return DENY_TARGET_ROLE;
    const permission = await this.resolvePermission(permissionId, db);
    if (!permission) return DENY_TARGET_PERMISSION;
    return GrantCeilingPolicy.canRemovePermissionFromRole(actor, role, permission);
  }
}

// Stable deny results for the "could not resolve a row" cases. They are denies
// (never allows) so a missing/inactive/soft-deleted subject always fails closed.
const DENY_ACTOR: GrantDecision = { allowed: false, reason: 'ACTOR_UNRESOLVED' };
const DENY_TARGET_USER: GrantDecision = { allowed: false, reason: 'TARGET_USER_UNRESOLVED' };
const DENY_TARGET_ROLE: GrantDecision = { allowed: false, reason: 'TARGET_ROLE_UNRESOLVED' };
const DENY_TARGET_PERMISSION: GrantDecision = {
  allowed: false,
  reason: 'TARGET_PERMISSION_UNRESOLVED',
};
