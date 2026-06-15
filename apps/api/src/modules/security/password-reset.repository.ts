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

/** A reset row this worker successfully claimed (lease held) for delivery. */
export interface ClaimedResetDelivery extends DeliverableResetToken {
  /** Stable provider idempotency key for this row: `password-reset:{id}`. */
  providerIdempotencyKey: string;
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

  /**
   * Atomically lease a reset row for delivery WITHOUT erasing the secret.
   *
   * A row is claimable when its secret is still present AND it is either fresh
   * (`PENDING`), retryable (`FAILED`), or a crashed in-flight attempt whose lease
   * has lapsed (`IN_PROGRESS` with `deliveryLeaseUntil < now`). `SUCCEEDED` rows
   * (secret already gone) and `UNKNOWN` rows (quarantined for manual review) are
   * never claimed, and a live lease held by another worker is never stolen.
   *
   * The conditional `updateMany` makes this a single-winner under concurrency:
   * exactly one caller flips the row to `IN_PROGRESS`; the others re-evaluate the
   * predicate after that commit and match nothing. The winner then re-reads the
   * still-sealed ciphertext to decrypt in memory. The ciphertext/nonce/tag are
   * intentionally left intact — they are erased only on delivery success.
   */
  async claimForDelivery(
    id: bigint,
    now: Date,
    leaseUntil: Date,
    executor?: DbClient,
  ): Promise<ClaimedResetDelivery | null> {
    const db = this.db(executor);
    const providerIdempotencyKey = `password-reset:${id}`;
    const res = await db.passwordResetToken.updateMany({
      where: {
        id,
        deliveryCiphertext: { not: null },
        OR: [
          { deliveryStatus: { in: ['PENDING', 'FAILED'] } },
          { deliveryStatus: 'IN_PROGRESS', deliveryLeaseUntil: { lt: now } },
        ],
      },
      data: {
        deliveryStatus: 'IN_PROGRESS',
        deliveryLeaseUntil: leaseUntil,
        deliveryAttemptCount: { increment: 1 },
        // Stable across retries (same value every claim) — used as the provider
        // idempotency key so a crash-retry cannot create a second real email.
        providerIdempotencyKey,
      },
    });
    if (res.count !== 1) return null;

    const row = await db.passwordResetToken.findUnique({
      where: { id },
      select: {
        id: true,
        deliveryCiphertext: true,
        deliveryNonce: true,
        deliveryAuthTag: true,
        user: { select: { email: true } },
      },
    });
    // The winner holds the lease, so the secret is still present here.
    if (!row || !row.deliveryCiphertext || !row.deliveryNonce || !row.deliveryAuthTag) {
      return null;
    }
    return {
      id: row.id,
      email: row.user.email,
      providerIdempotencyKey,
      sealed: {
        ciphertext: row.deliveryCiphertext,
        nonce: row.deliveryNonce,
        authTag: row.deliveryAuthTag,
      },
    };
  }

  /**
   * Record a successful provider send and ONLY THEN erase the secret: flip to
   * `SUCCEEDED`, stamp `deliveredAt`, store `providerMessageId`, drop the lease,
   * and NULL the ciphertext/nonce/tag. Guarded on `IN_PROGRESS` so a stale
   * worker that lost its lease cannot resurrect or re-erase the row. Returns the
   * number of rows updated (1 = this worker finalised it).
   */
  async markDelivered(
    id: bigint,
    now: Date,
    providerMessageId: string,
    executor?: DbClient,
  ): Promise<number> {
    const res = await this.db(executor).passwordResetToken.updateMany({
      where: { id, deliveryStatus: 'IN_PROGRESS' },
      data: {
        deliveryStatus: 'SUCCEEDED',
        deliveredAt: now,
        providerMessageId,
        deliveryLeaseUntil: null,
        deliveryLastError: null,
        // The email is durably accepted — erase the deliverable secret now.
        deliveryCiphertext: null,
        deliveryNonce: null,
        deliveryAuthTag: null,
      },
    });
    return res.count;
  }

  /**
   * Mark a retryable failure: flip to `FAILED`, drop the lease, record the error.
   * The encrypted secret is preserved so a later claim can rebuild the email.
   * Only valid for an idempotency-capable provider (retry is safe).
   */
  async markFailed(id: bigint, error: string, executor?: DbClient): Promise<number> {
    const res = await this.db(executor).passwordResetToken.updateMany({
      where: { id, deliveryStatus: 'IN_PROGRESS' },
      data: {
        deliveryStatus: 'FAILED',
        deliveryLeaseUntil: null,
        deliveryLastError: error,
      },
    });
    return res.count;
  }

  /**
   * Quarantine an ambiguous delivery for manual review: flip to `UNKNOWN`, drop
   * the lease, record the error, and KEEP the secret. Used when the provider
   * cannot guarantee exactly-once (an auto-retry could send a duplicate), so the
   * row is deliberately not re-claimable until a human resolves it.
   */
  async markUnknown(id: bigint, error: string, executor?: DbClient): Promise<number> {
    const res = await this.db(executor).passwordResetToken.updateMany({
      where: { id, deliveryStatus: 'IN_PROGRESS' },
      data: {
        deliveryStatus: 'UNKNOWN',
        deliveryLeaseUntil: null,
        deliveryLastError: error,
      },
    });
    return res.count;
  }
}
