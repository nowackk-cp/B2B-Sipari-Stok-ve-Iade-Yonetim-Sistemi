/**
 * Authorization (permission) wiring constants.
 *
 * `REQUIRED_PERMISSIONS_KEY` is the reflection metadata key under which
 * `@RequirePermissions(...)` stores the codes a route requires. `PERMISSION_CACHE`
 * is the DI token for the swappable effective-permission cache adapter.
 */
export const REQUIRED_PERMISSIONS_KEY = 'authz:required-permissions';

export const PERMISSION_CACHE = Symbol('PERMISSION_CACHE');
