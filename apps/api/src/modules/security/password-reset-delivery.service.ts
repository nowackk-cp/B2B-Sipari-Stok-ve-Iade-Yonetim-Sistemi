import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@b2b/logger';
import { APP_LOGGER } from '../../app.constants';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PasswordResetDeliveryCipher } from './password-reset-delivery.cipher';
import { PasswordResetRepository } from './password-reset.repository';
import { RESET_EMAIL_PROVIDER, type ResetEmailProvider } from './ports/reset-email-provider.port';

/** How long a delivery claim is leased before another worker may re-claim it. */
export const DELIVERY_LEASE_MS = 5 * 60_000;

/** Outcome of an attempted reset-email delivery. */
export type DeliveryResult =
  | { delivered: true; email: string; token: string; providerMessageId: string }
  | {
      delivered: false;
      /**
       * - `not_claimable` — already delivered, in-flight under a live lease, or
       *   quarantined (no work to do).
       * - `failed`        — provider failure with an idempotent provider; the
       *   secret is preserved and the row is retryable.
       * - `unknown`       — ambiguous result with a non-idempotent provider (or an
       *   unusable secret); quarantined for manual review, secret preserved.
       */
      reason: 'not_claimable' | 'failed' | 'unknown';
    };

/**
 * The approved delivery boundary for password-reset emails (AUTH-BLOCK-001).
 *
 * Crash-safe lease flow (ADR-008 effect-state model):
 *   1. Atomically lease the row (`PENDING`/retryable `FAILED`/lapsed
 *      `IN_PROGRESS`) → single winner; the secret is NOT erased.
 *   2. Decrypt the sealed token in memory.
 *   3. Send via the provider using a stable idempotency key
 *      (`password-reset:{id}`).
 *   4. ONLY after the provider accepts: mark `SUCCEEDED`, stamp `deliveredAt`,
 *      store `providerMessageId`, then NULL the ciphertext/nonce/tag.
 *
 * A crash after decrypt but before the provider call leaves the row `IN_PROGRESS`
 * with the secret intact; once the lease lapses another worker re-claims and
 * retries. With an idempotency-capable provider, a crash AFTER the send but
 * before the DB update is also safe: the retry reuses the same key and the
 * provider collapses the duplicate. The raw token is never logged or persisted.
 */
@Injectable()
export class PasswordResetDeliveryService {
  constructor(
    private readonly resets: PasswordResetRepository,
    private readonly cipher: PasswordResetDeliveryCipher,
    @Inject(RESET_EMAIL_PROVIDER) private readonly provider: ResetEmailProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Deliver the reset email for a reset row. Safe under at-least-once redelivery
   * and worker crashes: the encrypted secret is only erased after a provider
   * send has actually succeeded.
   */
  async deliver(passwordResetTokenId: bigint): Promise<DeliveryResult> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS);
    const claim = await this.resets.claimForDelivery(passwordResetTokenId, now, leaseUntil);
    if (!claim) {
      // Already delivered, held under a live lease, or quarantined — nothing to do.
      return { delivered: false, reason: 'not_claimable' };
    }

    let token: string;
    try {
      token = this.cipher.decrypt(claim.sealed);
    } catch {
      // The sealed secret will not open (tamper / key mismatch). Do NOT erase it;
      // quarantine for manual review rather than silently losing the reset.
      await this.resets.markUnknown(passwordResetTokenId, 'decrypt_failed');
      this.logger.error(
        {
          event: 'auth.password_reset.delivery_quarantined',
          passwordResetTokenId: passwordResetTokenId.toString(),
          reason: 'decrypt_failed',
        },
        'password reset delivery quarantined: sealed secret failed to decrypt (manual review)',
      );
      return { delivered: false, reason: 'unknown' };
    }

    try {
      const result = await this.provider.send({
        email: claim.email,
        token,
        idempotencyKey: claim.providerIdempotencyKey,
      });
      // Provider accepted the email — now (and only now) erase the secret.
      await this.resets.markDelivered(
        passwordResetTokenId,
        this.clock.now(),
        result.providerMessageId,
      );
      // NOTE: the raw token is intentionally NOT logged.
      this.logger.info(
        {
          event: 'auth.password_reset.delivered',
          passwordResetTokenId: passwordResetTokenId.toString(),
          providerMessageId: result.providerMessageId,
        },
        'password reset email delivered (secret erased)',
      );
      return {
        delivered: true,
        email: claim.email,
        token,
        providerMessageId: result.providerMessageId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.provider.supportsIdempotency) {
        // Retry is safe (provider dedups by key) — keep the secret, mark retryable.
        await this.resets.markFailed(passwordResetTokenId, message);
        this.logger.warn(
          {
            event: 'auth.password_reset.delivery_failed',
            passwordResetTokenId: passwordResetTokenId.toString(),
          },
          'password reset delivery failed (retryable; secret preserved)',
        );
        return { delivered: false, reason: 'failed' };
      }
      // No provider idempotency: an auto-retry could send a duplicate, so we do
      // NOT retry and do NOT erase the secret — quarantine for manual review.
      await this.resets.markUnknown(passwordResetTokenId, message);
      this.logger.error(
        {
          event: 'auth.password_reset.delivery_quarantined',
          passwordResetTokenId: passwordResetTokenId.toString(),
          reason: 'provider_no_idempotency',
        },
        'password reset delivery result UNKNOWN (no provider idempotency; manual review required)',
      );
      return { delivered: false, reason: 'unknown' };
    }
  }
}
