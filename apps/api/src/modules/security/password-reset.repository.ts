import { Injectable } from '@nestjs/common';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';
import type { SealedSecret } from './password-reset-delivery.cipher';

/** A reset row whose deliverable token is still sealed and awaiting dispatch. */
export interface DeliverableResetToken {
  id: bigint;
  email: string;
  sealed: SealedSecret;
}

/**
 * Data access for `password_reset_tokens` (owns the table). Only the token
 * digest is stored for verification; the deliverable token is kept solely as an
 * AES-256-GCM ciphertext (key is env-only) and is NULLed after delivery. The
 * raw plaintext token is never persisted (AUTH-BLOCK-001).
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

  /** Create a reset row (digest for verification + sealed token for delivery). */
  async create(
    input: {
      userId: bigint;
      tokenHash: string;
      expiresAt: Date;
      requestedByIp: string | null;
      sealed: SealedSecret;
    },
    executor: DbClient,
  ): Promise<{ id: bigint }> {
    return executor.passwordResetToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        requestedByIp: input.requestedByIp,
        deliveryCiphertext: input.sealed.ciphertext,
        deliveryNonce: input.sealed.nonce,
        deliveryAuthTag: input.sealed.authTag,
      },
      select: { id: true },
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

  /** Load a reset row's sealed deliverable token by id, or null if it is already
   * delivered (secret cleared) / missing. */
  async findDeliverable(id: bigint, executor?: DbClient): Promise<DeliverableResetToken | null> {
    const row = await this.db(executor).passwordResetToken.findUnique({
      where: { id },
      select: {
        id: true,
        deliveryCiphertext: true,
        deliveryNonce: true,
        deliveryAuthTag: true,
        user: { select: { email: true } },
      },
    });
    if (!row || !row.deliveryCiphertext || !row.deliveryNonce || !row.deliveryAuthTag) {
      return null;
    }
    return {
      id: row.id,
      email: row.user.email,
      sealed: {
        ciphertext: row.deliveryCiphertext,
        nonce: row.deliveryNonce,
        authTag: row.deliveryAuthTag,
      },
    };
  }

  /**
   * Atomically claim a reset row's delivery secret: NULL the ciphertext/nonce/tag
   * and stamp `deliveryConsumedAt`, but only while the ciphertext is still
   * present. Returns the number of rows claimed (1 = this caller won, 0 = already
   * delivered). This single-winner guard makes outbox redelivery idempotent: a
   * second dispatch attempt cannot re-send the email.
   */
  async claimDeliverySecret(id: bigint, now: Date, executor?: DbClient): Promise<number> {
    const res = await this.db(executor).passwordResetToken.updateMany({
      where: { id, deliveryCiphertext: { not: null } },
      data: {
        deliveryCiphertext: null,
        deliveryNonce: null,
        deliveryAuthTag: null,
        deliveryConsumedAt: now,
      },
    });
    return res.count;
  }
}
