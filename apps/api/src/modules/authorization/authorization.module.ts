import { Module } from '@nestjs/common';
import { PERMISSION_CACHE } from './authorization.constants';
import { InMemoryPermissionCache } from './adapters/in-memory-permission-cache';
import { PermissionRepository } from './permission.repository';
import { PermissionService } from './permission.service';
import { AuthorizationGrantService } from './authorization-grant.service';
import { PermissionGuard } from './guards/permission.guard';

/**
 * Authorization module (TASK-010) — permission-based access control foundation.
 *
 * Provides the effective-permission read model, the cached lookup service, the
 * swappable permission cache, the {@link PermissionGuard} and the
 * {@link AuthorizationGrantService} (the grant-ceiling decision core). It declares
 * NO controllers and NO role/permission/user management endpoints: those arrive
 * with a later management module, which will call the grant service before any
 * privileged mutation. The guard + services are exported so any feature module
 * can protect its routes with `@UseGuards(JwtAuthGuard, PermissionGuard)` +
 * `@RequirePermissions(...)` and enforce the grant ceiling.
 */
@Module({
  providers: [
    PermissionRepository,
    PermissionService,
    AuthorizationGrantService,
    PermissionGuard,
    { provide: PERMISSION_CACHE, useClass: InMemoryPermissionCache },
  ],
  exports: [PermissionService, AuthorizationGrantService, PermissionGuard, PERMISSION_CACHE],
})
export class AuthorizationModule {}
