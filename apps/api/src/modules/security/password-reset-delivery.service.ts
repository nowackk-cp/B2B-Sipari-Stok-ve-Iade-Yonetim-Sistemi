import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@b2b/logger';
import { APP_LOGGER } from '../../app.constants';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PasswordResetDeliveryCipher } from './password-reset-delivery.cipher';
import { PasswordResetRepository } from './password-reset.repository';

/** Outcome of an attempted reset-email delivery. */
export type DeliveryResult =
  | { delivered: true; email: string; token: string }
  | { delivered: false; reason: 'no_secret' | 'already_delivered' };

/**
 * The approved delivery boundary for password-reset emails (AUTH-BLOCK-001).
 *
 * Given a reset-row id (carried in the transactional outbox payload), it
 * re-loads the sealed deliverable token, atomically claims it (so a redelivery
 * cannot send twice), decrypts it in memory, and hands the raw link token to the
 * mail dispatcher. The raw token is never logged or persisted; once claimed, the
 * ciphertext/nonce/tag are NULLed on the row.
 *
 * The actual SMTP send is a later (worker) milestone; this service owns the
 * decrypt-and-erase step that keeps the secret out of the database.
 */
@Injectable()
export class PasswordResetDeliveryService {
  constructor(
    private readonly resets: PasswordResetRepository,
    private readonly cipher: PasswordResetDeliveryCipher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Deliver the reset email for a reset row. Idempotent: a second call (e.g. an
   * at-least-once outbox redelivery) returns `already_delivered` without sending.
   */
  async deliver(passwordResetTokenId: bigint): Promise<DeliveryResult> {
    const deliverable = await this.resets.findDeliverable(passwordResetTokenId);
    if (!deliverable) {
      return { delivered: false, reason: 'no_secret' };
    }

    // Claim BEFORE decrypt/send so exactly one dispatch wins under redelivery.
    const claimed = await this.resets.claimDeliverySecret(passwordResetTokenId, this.clock.now());
    if (claimed !== 1) {
      return { delivered: false, reason: 'already_delivered' };
    }

    const token = this.cipher.decrypt(deliverable.sealed);
    // NOTE: the raw token is intentionally NOT logged. SMTP send lands in the
    // worker milestone; here we only prove the decrypt-and-erase boundary.
    this.logger.info(
      {
        event: 'auth.password_reset.delivered',
        passwordResetTokenId: passwordResetTokenId.toString(),
      },
      'password reset email delivered (secret erased)',
    );
    return { delivered: true, email: deliverable.email, token };
  }
}
