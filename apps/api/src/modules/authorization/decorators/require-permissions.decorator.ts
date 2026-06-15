import { SetMetadata } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '../authorization.constants';

/**
 * Declare the permission code(s) a route requires (SECURITY_MODEL §2,
 * PERMISSION_MATRIX §3). ALL listed codes must be present in the caller's
 * effective permission set — there is no "any of" mode here; missing any one
 * denies (deny-by-default).
 *
 * Authorization only ("may they do X?"). It performs NO warehouse-scope or
 * grant-ceiling checks — those are later milestones. Codes are validated against
 * PostgreSQL by {@link PermissionGuard}; never trust a JWT claim.
 *
 * Usage: `@UseGuards(JwtAuthGuard, PermissionGuard)` +
 * `@RequirePermissions('order:approve')`.
 */
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
