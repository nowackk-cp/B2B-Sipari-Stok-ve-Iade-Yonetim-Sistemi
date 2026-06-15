import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../src/modules/authorization/decorators/require-permissions.decorator';

/**
 * TEST-ONLY controller proving that controller- and handler-level
 * `@RequirePermissions(...)` are MERGED (not overridden) by the global
 * PermissionGuard: a class-level base permission and a handler-level permission
 * are BOTH required.
 *
 * Like the other probe controllers it applies NO `@UseGuards(...)` of its own —
 * enforcement comes purely from the global APP_GUARD chain in the real
 * AppModule. Registered only by the merged-metadata integration test; never part
 * of the production app.
 */
@Controller('merged-authz-probe')
@RequirePermissions('order:read')
export class MergedAuthzProbeController {
  /** Class `order:read` + handler `order:approve` ⇒ BOTH required. */
  @Get('approve')
  @RequirePermissions('order:approve')
  approve(): { ok: true; route: 'approve' } {
    return { ok: true, route: 'approve' };
  }

  /** Handler repeats the class permission ⇒ de-duplicated to a single check. */
  @Get('duplicate')
  @RequirePermissions('order:read')
  duplicate(): { ok: true; route: 'duplicate' } {
    return { ok: true, route: 'duplicate' };
  }

  /** No handler metadata ⇒ only the controller permission (`order:read`) applies. */
  @Get('inherited')
  inherited(): { ok: true; route: 'inherited' } {
    return { ok: true, route: 'inherited' };
  }
}
