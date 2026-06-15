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
 * for an ACTIVE, non-deleted user; a disabled/soft-deleted account resolves to
 * the empty set (defense in depth on top of the authentication guard).
 */
@Injectable()
export class PermissionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Distinct effective permission codes for `userId` (empty if disabled/none). */
  async loadEffectivePermissionCodes(userId: bigint, executor?: DbClient): Promise<string[]> {
    const rows = await this.db(executor).permission.findMany({
      where: {
        roles: {
          some: {
            role: {
              users: {
                some: {
                  userId,
                  user: { status: 'ACTIVE', deletedAt: null },
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
