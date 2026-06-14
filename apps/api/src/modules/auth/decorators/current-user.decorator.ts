import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { type AuthPrincipal, PRINCIPAL_KEY } from '../../../common/auth/principal';

/**
 * Inject the authenticated {@link AuthPrincipal} attached by {@link JwtAuthGuard}.
 * Only valid on routes protected by that guard.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const req = ctx.switchToHttp().getRequest<Request & Record<string, unknown>>();
    return req[PRINCIPAL_KEY] as AuthPrincipal;
  },
);
