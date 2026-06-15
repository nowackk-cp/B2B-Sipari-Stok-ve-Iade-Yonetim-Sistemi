import { randomUUID } from 'node:crypto';
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
  /**
   * Fencing token for THIS claim. Must be presented to every finalizer; a newer
   * claim rotates it, so a stale worker can no longer mutate the row.
   */
  deliveryClaimToken: string;
  /** When this claim's lease lapses (a later worker may re-claim afterwards). */
  leaseUntil: Date;
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
   *
   * Each successful claim also mints a fresh CSPRNG `deliveryClaimToken` (a
   * fencing token). Finalizers must present it; a later re-claim rotates it, so a
   * stale worker that lost the race can no longer overwrite the row.
   */
  async claimForDelivery(
    id: bigint,
    now: Date,
    leaseUntil: Date,
    executor?: DbClient,
  ): Promise<ClaimedResetDelivery | null> {
    const db = this.db(executor);
    const providerIdempotencyKey = `password-reset:${id}`;
    // Fresh, unguessable fencing token for this claim. A re-claim overwrites it,
    // invalidating any earlier holder's token.
    const deliveryClaimToken = randomUUID();
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
        deliveryClaimToken,
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
        deliveryClaimToken: true,
        deliveryLeaseUntil: true,
        user: { select: { email: true } },
      },
    });
    // The winner holds a live lease, so both the secret and the just-minted
    // claim token are still present here (no other worker could have rotated them).
    if (
      !row ||
      !row.deliveryCiphertext ||
      !row.deliveryNonce ||
      !row.deliveryAuthTag ||
      !row.deliveryClaimToken ||
      !row.deliveryLeaseUntil
    ) {
      return null;
    }
    return {
      id: row.id,
      email: row.user.email,
      providerIdempotencyKey,
      deliveryClaimToken: row.deliveryClaimToken,
      leaseUntil: row.deliveryLeaseUntil,
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
   * and NULL the ciphertext/nonce/tag. Guarded on `IN_PROGRESS` AND a matching
   * `deliveryClaimToken`, so a stale worker whose claim was superseded cannot
   * resurrect or re-erase the row. Returns the number of rows updated (0 = this
   * worker lost claim ownership; it must not mutate further).
   */
  async markDelivered(
    id: bigint,
    claimToken: string,
    now: Date,
    providerMessageId: string,
    executor?: DbClient,
  ): Promise<number> {
    const res = await this.db(executor).passwordResetToken.updateMany({
      where: { id, deliveryStatus: 'IN_PROGRESS', deliveryClaimToken: claimToken },
      data: {
        deliveryStatus: 'SUCCEEDED',
        deliveredAt: now,
        providerMessageId,
        deliveryLeaseUntil: null,
        deliveryClaimToken: null,
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
   * Only valid for an idempotency-capable provider (retry is safe). Guarded on a
   * matching `deliveryClaimToken` so a superseded worker cannot drop a newer
   * worker's live claim. Returns 0 when this worker lost claim ownership.
   */
  async markFailed(
    id: bigint,
    claimToken: string,
    error: string,
    executor?: DbClient,
  ): Promise<number> {
    const res = await this.db(executor).passwordResetToken.updateMany({
      where: { id, deliveryStatus: 'IN_PROGRESS', deliveryClaimToken: claimToken },
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
   * row is deliberately not re-claimable until a human resolves it. Guarded on a
   * matching `deliveryClaimToken` so a superseded worker cannot quarantine a newer
   * worker's live claim. Returns 0 when this worker lost claim ownership.
   */
  async markUnknown(
    id: bigint,
    claimToken: string,
    error: string,
    executor?: DbClient,
  ): Promise<number> {
    const res = await this.db(executor).passwordResetToken.updateMany({
      where: { id, deliveryStatus: 'IN_PROGRESS', deliveryClaimToken: claimToken },
      data: {
        deliveryStatus: 'UNKNOWN',
        deliveryLeaseUntil: null,
        deliveryLastError: error,
      },
    });
    return res.count;
  }
}
