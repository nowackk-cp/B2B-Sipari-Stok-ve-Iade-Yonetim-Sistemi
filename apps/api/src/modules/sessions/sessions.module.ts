import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { SessionRepository } from './session.repository';
import { SessionService } from './session.service';

/**
 * Sessions module — refresh-token rotation, reuse detection and revocation.
 * Depends on identity for the actor snapshot used in reuse audits. Swappable
 * adapters (token generator, clock) come from the global AuthAdaptersModule.
 */
@Module({
  imports: [IdentityModule],
  providers: [SessionRepository, SessionService],
  exports: [SessionService],
})
export class SessionsModule {}
