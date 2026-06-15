import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../src/modules/auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../src/common/auth/principal';
import { Public } from '../../src/common/auth/public.decorator';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../src/modules/authorization/guards/permission.guard';
import { RequirePermissions } from '../../src/modules/authorization/decorators/require-permissions.decorator';

/**
 * TEST-ONLY controller exercising every guard combination. It lives under
 * `test/support` and is registered only by the integration test module — it is
 * NEVER part of the production app (no fake endpoints ship). Routes:
 *
 *  - `public`           — no guards, no permissions (open).
 *  - `authenticated`    — authentication only.
 *  - `single`           — one required permission.
 *  - `multiple`         — several required permissions (ALL must be held).
 *  - `system`           — a protected permission ADMIN never holds (role-name test).
 *  - `unguarded`        — declares a permission but OMITS PermissionGuard on
 *                         purpose: a fixture proving the route↔permission
 *                         coverage scanner flags an unprotected protected route.
 */
@Controller('test-authz')
export class TestAuthzController {
  @Get('public')
  @Public()
  publicRoute(): { ok: true; route: 'public' } {
    return { ok: true, route: 'public' };
  }

  @Get('authenticated')
  @UseGuards(JwtAuthGuard)
  authenticatedRoute(@CurrentUser() user: AuthPrincipal): { ok: true; userId: string } {
    return { ok: true, userId: user.userPublicId };
  }

  @Get('single')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermissions('product:read')
  singlePermissionRoute(): { ok: true; route: 'single' } {
    return { ok: true, route: 'single' };
  }

  @Get('multiple')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermissions('order:create', 'order:approve')
  multiplePermissionRoute(): { ok: true; route: 'multiple' } {
    return { ok: true, route: 'multiple' };
  }

  @Get('system')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermissions('system:read')
  systemRoute(): { ok: true; route: 'system' } {
    return { ok: true, route: 'system' };
  }

  // Intentionally missing PermissionGuard despite declaring a permission — a
  // negative fixture for the coverage scanner. Do NOT copy this pattern.
  @Get('unguarded')
  @UseGuards(JwtAuthGuard)
  @RequirePermissions('system:read')
  unguardedProtectedRoute(): { ok: true; route: 'unguarded' } {
    return { ok: true, route: 'unguarded' };
  }
}
