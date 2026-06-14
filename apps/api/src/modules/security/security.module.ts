import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { PasswordResetRepository } from './password-reset.repository';
import { PasswordResetService } from './password-reset.service';

/**
 * Security module — password-reset token lifecycle. Owns
 * `password_reset_tokens`. Adapters (token generator, email outbox, clock) come
 * from the global AuthAdaptersModule / TimeModule.
 */
@Module({
  imports: [IdentityModule],
  providers: [PasswordResetRepository, PasswordResetService],
  exports: [PasswordResetService],
})
export class SecurityModule {}
