import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@b2b/logger';
import { APP_LOGGER } from '../../../app.constants';
import type {
  ResetEmailProvider,
  SendResetEmailCommand,
  SendResetEmailResult,
} from '../ports/reset-email-provider.port';

/**
 * Placeholder reset-email provider for the pre-SMTP milestone.
 *
 * The real SMTP/API transport lands in the worker milestone; until then this
 * adapter stands in for it WITHOUT ever leaking the raw token: it logs only the
 * idempotency key and a derived message id. Because the message id is a pure
 * function of the idempotency key, a retry with the same key yields the same id —
 * so it honestly advertises `supportsIdempotency = true`, matching the contract
 * the real provider must preserve (pass the key through to the provider's own
 * deduplication).
 */
@Injectable()
export class LoggingResetEmailProvider implements ResetEmailProvider {
  readonly supportsIdempotency = true;

  constructor(@Inject(APP_LOGGER) private readonly logger: Logger) {}

  async send(command: SendResetEmailCommand): Promise<SendResetEmailResult> {
    // Deterministic id from the idempotency key → idempotent on retry. The raw
    // token is deliberately NOT part of the log line.
    const providerMessageId = createHash('sha256')
      .update(command.idempotencyKey)
      .digest('hex')
      .slice(0, 32);
    this.logger.info(
      {
        event: 'auth.password_reset.provider_send',
        idempotencyKey: command.idempotencyKey,
        providerMessageId,
      },
      'password reset email handed to provider (placeholder transport)',
    );
    return { providerMessageId };
  }
}
