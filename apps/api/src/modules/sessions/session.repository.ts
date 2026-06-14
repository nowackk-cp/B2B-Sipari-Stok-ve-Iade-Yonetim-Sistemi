import { Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** Persisted refresh-token row fields the session logic reasons about. */
export interface RefreshTokenRecord {
  id: bigint;
  sessionId: string;
  userId: bigint;
  tokenFamilyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** One active session, as projected for listing. */
export interface ActiveSessionRow {
  sessionId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface CreateRefreshTokenInput {
  userId: bigint;
  tokenHash: string;
  tokenFamilyId: string;
  /** Stable public session id (omit on first login → DB generates it; pass the
   * parent's value on rotation so the session id is stable across the chain). */
  sessionId?: string;
  expiresAt: Date;
  lastUsedAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Data access for `refresh_tokens` (owns the table). Plaintext tokens never
 * touch this layer — only their SHA-256 digests.
 */
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  async create(
    input: CreateRefreshTokenInput,
    executor: DbClient,
  ): Promise<{ id: bigint; sessionId: string }> {
    const row = await executor.refreshToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        tokenFamilyId: input.tokenFamilyId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        expiresAt: input.expiresAt,
        lastUsedAt: input.lastUsedAt,
        ip: input.ip,
        userAgent: input.userAgent,
      },
      select: { id: true, sessionId: true },
    });
    return row;
  }

  /**
   * Locking read (`SELECT ... FOR UPDATE`) by token digest, used by rotation so
   * two concurrent refreshes with the same token serialize: the second waits for
   * the first to commit and then observes the row as already revoked.
   */
  async findByTokenHashForUpdate(
    tokenHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<RefreshTokenRecord | null> {
    const rows = await tx.$queryRaw<
      Array<{
        id: bigint;
        sessionId: string;
        userId: bigint;
        tokenFamilyId: string;
        expiresAt: Date;
        revokedAt: Date | null;
      }>
    >`SELECT "id", "session_id" AS "sessionId", "user_id" AS "userId",
             "token_family_id" AS "tokenFamilyId", "expires_at" AS "expiresAt",
             "revoked_at" AS "revokedAt"
        FROM "refresh_tokens" WHERE "token_hash" = ${tokenHash} FOR UPDATE`;
    return rows[0] ?? null;
  }

  async findByTokenHash(
    tokenHash: string,
    executor?: DbClient,
  ): Promise<RefreshTokenRecord | null> {
    return this.db(executor).refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        sessionId: true,
        userId: true,
        tokenFamilyId: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
  }

  /** Mark a token as rotated: revoked + pointing at its successor. */
  async markRotated(
    id: bigint,
    replacedById: bigint,
    now: Date,
    executor: DbClient,
  ): Promise<void> {
    await executor.refreshToken.update({
      where: { id },
      data: { revokedAt: now, replacedById, revokeReason: 'rotated' },
    });
  }

  /** Revoke every still-active token in a family. Returns the number revoked. */
  async revokeFamily(
    tokenFamilyId: string,
    reason: string,
    now: Date,
    executor: DbClient,
  ): Promise<number> {
    const res = await executor.refreshToken.updateMany({
      where: { tokenFamilyId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason },
    });
    return res.count;
  }

  /** Revoke a specific user's session (ownership-scoped). Returns rows revoked. */
  async revokeSession(
    userId: bigint,
    sessionId: string,
    reason: string,
    now: Date,
    executor: DbClient,
  ): Promise<number> {
    const res = await executor.refreshToken.updateMany({
      where: { userId, sessionId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason },
    });
    return res.count;
  }

  /** Revoke all of a user's active tokens, optionally keeping one session. */
  async revokeAllForUser(
    userId: bigint,
    reason: string,
    now: Date,
    executor: DbClient,
    exceptSessionId?: string,
  ): Promise<number> {
    const where: Prisma.RefreshTokenWhereInput = { userId, revokedAt: null };
    if (exceptSessionId) where.sessionId = { not: exceptSessionId };
    const res = await executor.refreshToken.updateMany({
      where,
      data: { revokedAt: now, revokeReason: reason },
    });
    return res.count;
  }

  /**
   * Whether the user has at least one active (non-revoked, unexpired) token for
   * the given public session id. Used by the auth guard so a revoked session is
   * rejected immediately, even while its short-lived access token is still valid.
   */
  async isSessionActive(
    userId: bigint,
    sessionId: string,
    now: Date,
    executor?: DbClient,
  ): Promise<boolean> {
    const count = await this.db(executor).refreshToken.count({
      where: { userId, sessionId, revokedAt: null, expiresAt: { gt: now } },
    });
    return count > 0;
  }

  /** Active (non-revoked, unexpired) sessions for a user, newest first. */
  async listActive(userId: bigint, now: Date, executor?: DbClient): Promise<ActiveSessionRow[]> {
    return this.db(executor).refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      select: {
        sessionId: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        ip: true,
        userAgent: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
