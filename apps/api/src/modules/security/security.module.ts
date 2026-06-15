import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { PasswordResetRepository } from './password-reset.repository';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetDeliveryCipher } from './password-reset-delivery.cipher';
import { PasswordResetDeliveryService } from './password-reset-delivery.service';
import { RESET_EMAIL_PROVIDER } from './ports/reset-email-provider.port';
import { SmtpResetEmailProvider } from './adapters/smtp-reset-email-provider';

/**
 * Security module — password-reset token lifecycle. Owns
 * `password_reset_tokens`. The deliverable token is envelope-encrypted by
 * {@link PasswordResetDeliveryCipher} (env-only key) and decrypted only at the
 * {@link PasswordResetDeliveryService} mail-delivery boundary (AUTH-BLOCK-001).
 * Adapters (token generator, email outbox, clock) come from the global
 * AuthAdaptersModule / TimeModule.
 *
 * The reset email goes out over a real SMTP relay ({@link SmtpResetEmailProvider}).
 * There is deliberately NO fake/logging fallback in this wiring: a delivery is
 * only ever marked `SUCCEEDED` (and the secret erased) after the relay accepts
 * the message. Tests inject a test-only fake via DI override.
 */
@Module({
  imports: [IdentityModule],
  providers: [
    PasswordResetRepository,
    PasswordResetService,
    PasswordResetDeliveryCipher,
    PasswordResetDeliveryService,
    { provide: RESET_EMAIL_PROVIDER, useClass: SmtpResetEmailProvider },
  ],
  exports: [PasswordResetService, PasswordResetDeliveryService],
})
export class SecurityModule {}
