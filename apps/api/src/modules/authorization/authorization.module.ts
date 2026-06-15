import { Module } from '@nestjs/common';
import { PERMISSION_CACHE } from './authorization.constants';
import { InMemoryPermissionCache } from './adapters/in-memory-permission-cache';
import { PermissionRepository } from './permission.repository';
import { PermissionService } from './permission.service';
import { PermissionGuard } from './guards/permission.guard';

/**
 * Authorization module (TASK-010) — permission-based access control foundation.
 *
 * Provides the effective-permission read model, the cached lookup service, the
 * swappable permission cache and the {@link PermissionGuard}. It declares NO
 * controllers and NO role/permission/user management endpoints: those (and the
 * grant ceiling / protected-role rules) arrive in TASK-010a. The guard + service
 * are exported so any feature module can protect its routes with
 * `@UseGuards(JwtAuthGuard, PermissionGuard)` + `@RequirePermissions(...)`.
 */
@Module({
  providers: [
    PermissionRepository,
    PermissionService,
    PermissionGuard,
    { provide: PERMISSION_CACHE, useClass: InMemoryPermissionCache },
  ],
  exports: [PermissionService, PermissionGuard, PERMISSION_CACHE],
})
export class AuthorizationModule {}
