import { Module } from '@nestjs/common';
import { IdentityModule } from '../../src/modules/identity/identity.module';
import { SessionsModule } from '../../src/modules/sessions/sessions.module';
import { AuthorizationModule } from '../../src/modules/authorization/authorization.module';
import { TestAuthzController } from './test-authz.controller';

/**
 * TEST-ONLY module wiring the {@link TestAuthzController}. It mirrors how a real
 * feature module protects its routes: it imports the modules whose providers the
 * route guards need — IdentityModule + SessionsModule for the authentication
 * guard, AuthorizationModule for the permission guard (the access-token signer
 * and clock are global) — then applies both via `@UseGuards`. Registered only by
 * the integration test app; never imported by the production {@link AppModule}.
 */
@Module({
  imports: [IdentityModule, SessionsModule, AuthorizationModule],
  controllers: [TestAuthzController],
})
export class TestAuthzModule {}
