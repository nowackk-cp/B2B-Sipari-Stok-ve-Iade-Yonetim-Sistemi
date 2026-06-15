import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from '@b2b/logger';
import { APP_LOGGER } from '../../../app.constants';
import { AppConfigService } from '../../../common/config/app-config.service';
import type {
  ResetEmailProvider,
  SendResetEmailCommand,
  SendResetEmailResult,
} from '../ports/reset-email-provider.port';

/** Sanitize the stable idempotency key into a valid RFC 5322 Message-ID local part. */
function messageIdFor(idempotencyKey: string): string {
  const local = idempotencyKey.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `<${local}@password-reset.b2bops.local>`;
}

/**
 * Real outbound reset-email provider over SMTP (Nodemailer). Replaces the former
 * logging placeholder that fabricated a `SUCCEEDED` result without sending: this
 * adapter hands the message to an actual SMTP relay and only resolves once the
 * relay accepts it.
 *
 * Honesty about idempotency (CLAUDE.md §9, ADR-008): SMTP gives NO native
 * deduplication — a second `sendMail` with the same content produces a second
 * real email. We therefore advertise `supportsIdempotency = false`, so the
 * delivery service quarantines an ambiguous failure as `UNKNOWN` (manual review)
 * rather than auto-retrying and risking a duplicate. The stable provider key is
 * still threaded through as the message's `Message-ID` for audit/correlation —
 * that is NOT a claim that the relay deduplicates by it.
 *
 * The raw bearer token appears only in the in-memory reset URL while the body is
 * built; it is never logged, and only `idempotencyKey` + `providerMessageId`
 * reach the log line (AUTH-BLOCK-001).
 */
@Injectable()
export class SmtpResetEmailProvider implements ResetEmailProvider {
  readonly supportsIdempotency = false;

  private readonly transport: Transporter;
  private readonly from: string;
  private readonly resetLinkBase: string;

  constructor(
    @Inject(APP_LOGGER) private readonly logger: Logger,
    config: AppConfigService,
  ) {
    const mail = config.mail;
    this.from = mail.from;
    this.resetLinkBase = config.passwordResetLinkBase;
    // Lazy transport: no socket is opened until the first sendMail, so wiring the
    // provider into the module graph never blocks boot on the relay.
    this.transport = createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
    });
  }

  async send(command: SendResetEmailCommand): Promise<SendResetEmailResult> {
    // The decrypted token lives ONLY in this local URL string, in memory, for the
    // lifetime of the send. It is never logged nor persisted.
    const resetUrl = `${this.resetLinkBase}?token=${encodeURIComponent(command.token)}`;
    const messageId = messageIdFor(command.idempotencyKey);

    // sendMail resolves only when the relay accepts the message; a rejection
    // throws (no fabricated success), and the delivery service keeps the secret.
    const info = await this.transport.sendMail({
      from: this.from,
      to: command.email,
      subject: 'Reset your password',
      text: [
        'We received a request to reset your password.',
        '',
        'Use the link below to choose a new password:',
        resetUrl,
        '',
        'If you did not request this, you can safely ignore this email.',
      ].join('\n'),
      html: [
        '<p>We received a request to reset your password.</p>',
        '<p>Use the link below to choose a new password:</p>',
        `<p><a href="${resetUrl}">Reset your password</a></p>`,
        '<p>If you did not request this, you can safely ignore this email.</p>',
      ].join(''),
      messageId,
    });

    const providerMessageId = info.messageId ?? messageId;
    this.logger.info(
      {
        event: 'auth.password_reset.provider_send',
        idempotencyKey: command.idempotencyKey,
        providerMessageId,
      },
      'password reset email sent via SMTP',
    );
    return { providerMessageId };
  }
}
