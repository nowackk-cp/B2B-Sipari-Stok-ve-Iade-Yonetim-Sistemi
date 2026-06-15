import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type AuthPrincipal, PRINCIPAL_KEY } from '../../../common/auth/principal';
import { IS_PUBLIC_KEY } from '../../../common/auth/public.decorator';
import { CLOCK, type Clock } from '../../../common/time/clock';
import { UserRepository } from '../../identity/user.repository';
import { SessionService } from '../../sessions/session.service';
import { ACCESS_TOKEN_SIGNER } from '../auth.constants';
import { type AccessTokenSigner, InvalidAccessTokenError } from '../ports/access-token.port';

/**
 * Authentication guard (TASK-009 §12 — authentication only, NOT authorization).
 *
 * Verifies the Bearer access token's signature + standard claims, then confirms
 * (1) the user still exists and is ACTIVE/not-deleted and (2) the bound session
 * is still active — so a logged-out / revoked session is rejected immediately
 * even while its short-lived token would otherwise validate. On success a
 * minimal {@link AuthPrincipal} is attached to the request.
 *
 * Bound globally (APP_GUARD) ahead of {@link PermissionGuard}, so it runs first
 * and the principal is present before any authorization check. Routes that must
 * stay open (login, refresh, logout, forgot/reset-password, health) opt out with
 * `@Public()`. It performs NO permission/role/scope decisions.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_TOKEN_SIGNER) private readonly signer: AccessTokenSigner,
    private readonly users: UserRepository,
    private readonly sessions: SessionService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(req.headers.authorization);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let claims;
    try {
      claims = this.signer.verify(token);
    } catch (err) {
      if (err instanceof InvalidAccessTokenError) throw new UnauthorizedException('Invalid token');
      throw err;
    }

    const user = await this.users.findByPublicId(claims.sub);
    if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    const now = this.clock.now();
    const sessionActive = await this.sessions.isActive(user.id, claims.sid, now);
    if (!sessionActive) throw new UnauthorizedException('Session is no longer active');

    const principal: AuthPrincipal = {
      userId: user.id,
      // Tenant comes from the DB user record, not the token (tenant isolation).
      companyId: user.companyId,
      userPublicId: user.publicId,
      sessionId: claims.sid,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
    };
    (req as Request & Record<string, unknown>)[PRINCIPAL_KEY] = principal;
    return true;
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() || null;
}
