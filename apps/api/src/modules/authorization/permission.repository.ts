import { Injectable } from '@nestjs/common';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/**
 * Read model for a user's EFFECTIVE permissions, resolved entirely from
 * PostgreSQL: `user_roles → role_permissions → permissions`.
 *
 * The query is scoped to the Permission table, so a code reachable through
 * several roles is returned once — duplicate grants and multi-role overlap
 * collapse naturally with no extra de-duplication. Permissions are returned ONLY
 * when EVERY hop is inside the caller's own tenant (TASK-010b / PG-002):
 *   - the user is ACTIVE, not soft-deleted, AND in `companyId`,
 *   - the assignment row (`user_roles`) is in `companyId`, AND
 *   - the role is in `companyId`.
 * A disabled/soft-deleted account, or any relation that straddles tenants,
 * resolves to the empty set — so a role belonging to another company can never
 * contribute permissions, even if a row were forced in by hand. `companyId` is
 * the user's REAL company (verified from PostgreSQL by the auth guard), never a
 * value taken from a JWT claim.
 */
@Injectable()
export class PermissionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Distinct effective permission codes for `userId` within `companyId`. */
  async loadEffectivePermissionCodes(
    userId: bigint,
    companyId: bigint,
    executor?: DbClient,
  ): Promise<string[]> {
    const rows = await this.db(executor).permission.findMany({
      where: {
        roles: {
          some: {
            // Role must belong to the caller's tenant.
            role: {
              companyId,
              users: {
                some: {
                  userId,
                  // Assignment row must belong to the same tenant…
                  companyId,
                  // …and so must the user (active, not soft-deleted).
                  user: { status: 'ACTIVE', deletedAt: null, companyId },
                },
              },
            },
          },
        },
      },
      select: { code: true },
    });
    return rows.map((r) => r.code);
  }
}
