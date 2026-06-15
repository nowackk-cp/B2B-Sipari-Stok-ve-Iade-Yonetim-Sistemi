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
       * - `claim_lost`    — a newer worker re-claimed the row before this worker
       *   could finalize (fencing-token mismatch); this worker wrote nothing and
       *   must not retry the mutation.
       */
      reason: 'not_claimable' | 'failed' | 'unknown' | 'claim_lost';
    };

/**
 * The approved delivery boundary for password-reset emails (AUTH-BLOCK-001).
 *
 * Crash-safe lease flow (ADR-008 effect-state model):
 *   1. Atomically lease the row (`PENDING`/retryable `FAILED`/lapsed
 *      `IN_PROGRESS`) → single winner; the secret is NOT erased.
 *   2. Decrypt the sealed token in memory.
 *   3. Stamp `deliverySendStartedAt` (fenced by the claim token) immediately
 *      before the provider call.
 *   4. Send via the provider using a stable idempotency key
 *      (`password-reset:{id}`).
 *   5. ONLY after the provider accepts: mark `SUCCEEDED`, stamp `deliveredAt`,
 *      store `providerMessageId`, then NULL the ciphertext/nonce/tag.
 *
 * A crash after decrypt but before the send-started mark leaves the row
 * `IN_PROGRESS` with the secret intact and no send-started stamp; once the lease
 * lapses another worker re-claims and retries. With an idempotency-capable
 * provider, a crash AFTER the send but before the DB update is also safe: the
 * retry reuses the same key and the provider collapses the duplicate.
 *
 * With a NON-idempotent provider (SMTP) a crash after the send-started mark is
 * NOT safe to retry — a second `sendMail` could deliver a duplicate. Such a
 * stranded row is therefore not auto-reclaimed; once its lease lapses it is
 * quarantined as `UNKNOWN` for manual review, with the secret preserved. The raw
 * token is never logged or persisted.
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
    // A lapsed in-flight row whose send already started is only safe to re-claim
    // when the provider deduplicates by idempotency key. Pass that capability so
    // a non-idempotent provider never auto-reclaims a started send.
    const claim = await this.resets.claimForDelivery(
      passwordResetTokenId,
      now,
      leaseUntil,
      this.provider.supportsIdempotency,
    );
    if (!claim) {
      // Nothing claimable. For a non-idempotent provider, a lapsed in-flight row
      // whose send already started (worker crashed after handing the message to
      // SMTP) is deliberately excluded from re-claim above — re-sending could
      // duplicate the email. Quarantine it as UNKNOWN for manual review instead of
      // silently leaving it stuck IN_PROGRESS.
      if (!this.provider.supportsIdempotency) {
        const quarantined = await this.resets.quarantineStaleSendStarted(
          passwordResetTokenId,
          now,
          'send_started_no_idempotency',
        );
        if (quarantined > 0) {
          this.logger.error(
            {
              event: 'auth.password_reset.delivery_quarantined',
              passwordResetTokenId: passwordResetTokenId.toString(),
              reason: 'send_started_no_idempotency',
            },
            'password reset delivery result UNKNOWN: send started then worker crashed with a non-idempotent provider (no auto-resend; manual review required)',
          );
          return { delivered: false, reason: 'unknown' };
        }
      }
      // Already delivered, held under a live lease, or quarantined — nothing to do.
      return { delivered: false, reason: 'not_claimable' };
    }

    const { deliveryClaimToken } = claim;

    let token: string;
    try {
      token = this.cipher.decrypt(claim.sealed);
    } catch {
      // The sealed secret will not open (tamper / key mismatch). Do NOT erase it;
      // quarantine for manual review rather than silently losing the reset.
      const count = await this.resets.markUnknown(
        passwordResetTokenId,
        deliveryClaimToken,
        'decrypt_failed',
      );
      if (count === 0) return this.claimLost(passwordResetTokenId);
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

    // Mark the send as started BEFORE calling the provider, fenced by our claim
    // token. This is the commit point: after it, a non-idempotent provider's row
    // can no longer be auto-reclaimed, so a crash during/after the send quarantines
    // as UNKNOWN rather than re-sending a duplicate email. If a newer worker
    // already re-claimed (token rotated), this writes nothing — we lost the claim
    // and must not send.
    const started = await this.resets.markSendStarted(
      passwordResetTokenId,
      deliveryClaimToken,
      this.clock.now(),
    );
    if (started === 0) return this.claimLost(passwordResetTokenId);

    try {
      const result = await this.provider.send({
        email: claim.email,
        token,
        idempotencyKey: claim.providerIdempotencyKey,
      });
      // Provider accepted the email — now (and only now) erase the secret, but
      // ONLY if we still own the claim (fencing token). A stale worker whose lease
      // lapsed and was re-claimed writes nothing and must not report success.
      const count = await this.resets.markDelivered(
        passwordResetTokenId,
        deliveryClaimToken,
        this.clock.now(),
        result.providerMessageId,
      );
      if (count === 0) return this.claimLost(passwordResetTokenId);
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
        const count = await this.resets.markFailed(
          passwordResetTokenId,
          deliveryClaimToken,
          message,
        );
        if (count === 0) return this.claimLost(passwordResetTokenId);
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
      const count = await this.resets.markUnknown(
        passwordResetTokenId,
        deliveryClaimToken,
        message,
      );
      if (count === 0) return this.claimLost(passwordResetTokenId);
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

  /**
   * A finalizer updated zero rows: a newer worker re-claimed this row (the
   * fencing token rotated). This worker mutated nothing — it must not retry and
   * must not report success. The owning worker is responsible for the outcome.
   */
  private claimLost(passwordResetTokenId: bigint): DeliveryResult {
    this.logger.warn(
      {
        event: 'auth.password_reset.delivery_claim_lost',
        passwordResetTokenId: passwordResetTokenId.toString(),
      },
      'password reset delivery claim lost to a newer worker (no-op finalization)',
    );
    return { delivered: false, reason: 'claim_lost' };
  }
}
