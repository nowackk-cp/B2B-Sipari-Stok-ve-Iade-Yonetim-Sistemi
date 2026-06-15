import { SetMetadata } from '@nestjs/common';

/** Reflection key marking a route (or controller) as not requiring authentication. */
export const IS_PUBLIC_KEY = 'auth:is-public';

/**
 * Opt a route or controller out of the global authentication guard.
 *
 * With the authentication + permission guards bound globally (APP_GUARD), every
 * route requires a valid access token unless explicitly marked `@Public()` —
 * e.g. login, token refresh, logout, the forgot/reset-password endpoints and the
 * health probes. `@Public()` only skips authentication; it never grants any
 * permission, and a `@RequirePermissions(...)` route must NOT be public.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
