import { Injectable } from '@nestjs/common';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/**
 * Data access for `password_reset_tokens` (owns the table). Only token digests
 * are stored; the plaintext token lives only in the outgoing email payload.
 */
@Injectable()
export class PasswordResetRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Invalidate every still-active reset token for a user (single-active policy). */
  async consumeActiveForUser(userId: bigint, now: Date, executor: DbClient): Promise<void> {
    await executor.passwordResetToken.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    });
  }

  async create(
    input: { userId: bigint; tokenHash: string; expiresAt: Date; requestedByIp: string | null },
    executor: DbClient,
  ): Promise<void> {
    await executor.passwordResetToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        requestedByIp: input.requestedByIp,
      },
    });
  }

  /**
   * Atomically consume a valid (unused, unexpired) reset token by digest.
   * Returns the owning userId, or null if no row was eligible. The conditional
   * updateMany guarantees single-use even under concurrent requests: only one
   * caller flips `consumedAt`.
   */
  async consumeByDigest(tokenHash: string, now: Date, executor: DbClient): Promise<bigint | null> {
    const candidate = await executor.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    });
    if (!candidate) return null;
    const res = await executor.passwordResetToken.updateMany({
      where: { id: candidate.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return res.count === 1 ? candidate.userId : null;
  }
}
