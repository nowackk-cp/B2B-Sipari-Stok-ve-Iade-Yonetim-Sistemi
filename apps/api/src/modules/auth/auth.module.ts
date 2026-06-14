import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SecurityModule } from '../security/security.module';
import { AuthAdaptersModule } from './auth-adapters.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * Authentication module (TASK-009). Orchestrates identity, sessions and security
 * behind the `/auth` endpoints. Authentication only — no role/permission/scope
 * authorization (those are later milestones).
 */
@Module({
  imports: [AuthAdaptersModule, IdentityModule, SessionsModule, SecurityModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
