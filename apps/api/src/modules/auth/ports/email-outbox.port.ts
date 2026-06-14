import type { Prisma } from '@b2b/database';

/**
 * A password-reset email request to be delivered asynchronously. The raw
 * `resetToken` is the outgoing-delivery payload (the email link) — it is written
 * to the transactional outbox only and MUST NOT be logged or audited.
 */
export interface PasswordResetRequestedEvent {
  userId: bigint;
  userPublicId: string;
  email: string;
  /** Raw single-use token — outgoing delivery only; never logged/audited. */
  resetToken: string;
  expiresAt: Date;
  /** Stable dedup seed (the token digest) so the outbox row is idempotent. */
  dedupKey: string;
}

/**
 * Email delivery port. The reset email is NOT sent inline (no external I/O in a
 * transaction — CLAUDE.md). Instead a row is appended to `outbox_events` in the
 * SAME transaction as the token creation (ADR-008); the worker delivers it
 * later. Tests substitute a capturing adapter to assert the payload.
 */
export interface EmailOutbox {
  enqueuePasswordReset(
    tx: Prisma.TransactionClient,
    event: PasswordResetRequestedEvent,
  ): Promise<void>;
}
