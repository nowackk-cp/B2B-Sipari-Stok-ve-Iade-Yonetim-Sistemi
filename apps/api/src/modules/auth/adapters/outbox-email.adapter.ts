import { Injectable } from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { EmailOutbox, PasswordResetRequestedEvent } from '../ports/email-outbox.port';

/**
 * Transactional-outbox email adapter. Appends an `outbox_events` row in the
 * caller's transaction; the worker (later milestone) will pick it up, re-load
 * the reset row by `passwordResetTokenId`, decrypt the sealed token and send the
 * mail via SMTP. No SMTP is performed here.
 *
 * The payload carries only safe references — recipient, template/type, expiry
 * and the reset-row id. The raw bearer token is NEVER written here (AUTH-BLOCK-001).
 *
 * `deduplication_key` is unique, so re-requesting a reset with the same token
 * digest is a no-op insert race rather than a duplicate email.
 */
@Injectable()
export class OutboxEmailAdapter implements EmailOutbox {
  async enqueuePasswordReset(
    tx: Prisma.TransactionClient,
    event: PasswordResetRequestedEvent,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        eventType: 'auth.password_reset.requested',
        aggregateType: 'USER',
        aggregateId: event.userId,
        deduplicationKey: `password-reset:${event.dedupKey}`,
        // Safe references only — no recoverable bearer secret. The deliverable
        // token is envelope-encrypted on the reset row and re-loaded by id.
        payload: {
          type: 'password-reset',
          template: 'password-reset',
          to: event.email,
          userId: event.userPublicId,
          passwordResetTokenId: event.passwordResetTokenId.toString(),
          expiresAt: event.expiresAt.toISOString(),
        } satisfies Prisma.InputJsonObject,
      },
    });
  }
}
