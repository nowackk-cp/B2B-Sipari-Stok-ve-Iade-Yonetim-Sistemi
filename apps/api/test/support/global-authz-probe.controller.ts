import { Controller, Get } from '@nestjs/common';
import { Public } from '../../src/common/auth/public.decorator';
import { RequirePermissions } from '../../src/modules/authorization/decorators/require-permissions.decorator';

/**
 * TEST-ONLY controller proving the GLOBAL guard chain. Registered only by the
 * runtime-proof integration test (never by the production AppModule).
 *
 * Crucially it applies NO `@UseGuards(...)` of its own: both the authentication
 * guard and the permission guard reach these routes purely through the global
 * APP_GUARD registration in the real AppModule. If that registration were
 * removed, `needsPermission` would stop returning 401/403 and the test fails.
 */
@Controller('global-authz-probe')
export class GlobalAuthzProbeController {
  /** Public + no permission metadata: reachable with no token at all. */
  @Get('open')
  @Public()
  open(): { ok: true; route: 'open' } {
    return { ok: true, route: 'open' };
  }

  /** Authenticated but no permission metadata: the global PermissionGuard must
   * no-op, so ANY authenticated user (even with zero permissions) passes. */
  @Get('authed-no-permission')
  authedNoPermission(): { ok: true; route: 'authed' } {
    return { ok: true, route: 'authed' };
  }

  /** Declares a permission but applies NO guard locally — enforcement comes only
   * from the global APP_GUARD chain. */
  @Get('needs-permission')
  @RequirePermissions('product:read')
  needsPermission(): { ok: true; route: 'protected' } {
    return { ok: true, route: 'protected' };
  }
}
