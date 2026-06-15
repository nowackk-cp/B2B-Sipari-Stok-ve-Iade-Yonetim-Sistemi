import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { PasswordResetRepository } from './password-reset.repository';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetDeliveryCipher } from './password-reset-delivery.cipher';
import { PasswordResetDeliveryService } from './password-reset-delivery.service';

/**
 * Security module — password-reset token lifecycle. Owns
 * `password_reset_tokens`. The deliverable token is envelope-encrypted by
 * {@link PasswordResetDeliveryCipher} (env-only key) and decrypted only at the
 * {@link PasswordResetDeliveryService} mail-delivery boundary (AUTH-BLOCK-001).
 * Adapters (token generator, email outbox, clock) come from the global
 * AuthAdaptersModule / TimeModule.
 */
@Module({
  imports: [IdentityModule],
  providers: [
    PasswordResetRepository,
    PasswordResetService,
    PasswordResetDeliveryCipher,
    PasswordResetDeliveryService,
  ],
  exports: [PasswordResetService, PasswordResetDeliveryService],
})
export class SecurityModule {}
