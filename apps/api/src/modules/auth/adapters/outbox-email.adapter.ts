import { Injectable } from '@nestjs/common';
import { Prisma } from '@b2b/database';
import type { EmailOutbox, PasswordResetRequestedEvent } from '../ports/email-outbox.port';

/**
 * Transactional-outbox email adapter. Appends an `outbox_events` row in the
 * caller's transaction; the worker (later milestone) will pick it up and send
 * the mail via SMTP. No SMTP is performed here.
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
        payload: {
          template: 'password-reset',
          to: event.email,
          userPublicId: event.userPublicId,
          // Outgoing delivery payload only — redaction-named so it is masked if
          // a payload ever reaches a log line.
          resetToken: event.resetToken,
          expiresAt: event.expiresAt.toISOString(),
        } satisfies Prisma.InputJsonObject,
      },
    });
  }
}
