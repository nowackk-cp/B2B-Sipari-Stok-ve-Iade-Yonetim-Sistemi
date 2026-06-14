import { Module } from '@nestjs/common';
import { UserRepository } from './user.repository';
import { AccountSecurityService } from './account-security.service';

/**
 * Identity module — owns the `users` table (MODULE_BOUNDARIES §2 / M1). Exposes
 * low-level user data access and the durable account-security state machine for
 * the auth orchestrator to compose.
 */
@Module({
  providers: [UserRepository, AccountSecurityService],
  exports: [UserRepository, AccountSecurityService],
})
export class IdentityModule {}
