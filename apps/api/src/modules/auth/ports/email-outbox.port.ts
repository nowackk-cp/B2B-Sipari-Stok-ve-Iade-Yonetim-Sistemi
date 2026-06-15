import type { Prisma } from '@b2b/database';

/**
 * A password-reset email request to be delivered asynchronously.
 *
 * The raw bearer token is deliberately NOT part of this event. It is
 * envelope-encrypted (AES-256-GCM) onto the `password_reset_tokens` row; the
 * outbox payload carries only safe references (the reset-row id, the recipient,
 * template/type, expiry). The mail dispatcher re-loads the row by id and
 * decrypts the sealed token at delivery time (AUTH-BLOCK-001).
 */
export interface PasswordResetRequestedEvent {
  /** Reset-row id the mail dispatcher loads to decrypt the deliverable token. */
  passwordResetTokenId: bigint;
  userId: bigint;
  userPublicId: string;
  email: string;
  expiresAt: Date;
  /** Stable dedup seed (the token digest) so the outbox row is idempotent. */
  dedupKey: string;
}

/**
 * Email delivery port. The reset email is NOT sent inline (no external I/O in a
 * transaction — CLAUDE.md). Instead a row is appended to `outbox_events` in the
 * SAME transaction as the token creation (ADR-008); the worker delivers it
 * later. The payload contains NO recoverable bearer secret. Tests substitute a
 * capturing adapter to assert the (secret-free) payload.
 */
export interface EmailOutbox {
  enqueuePasswordReset(
    tx: Prisma.TransactionClient,
    event: PasswordResetRequestedEvent,
  ): Promise<void>;
}
