import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type AuthPrincipal, PRINCIPAL_KEY } from '../../../common/auth/principal';
import { REQUIRED_PERMISSIONS_KEY } from '../authorization.constants';
import { PermissionService } from '../permission.service';

/**
 * Permission authorization guard (TASK-010, SECURITY_MODEL §2).
 *
 * Resolves the codes declared by `@RequirePermissions(...)` — the controller- and
 * handler-level declarations are MERGED (a handler permission ADDS to, never
 * replaces, the controller's base permission) — and allows the request only when
 * the caller's effective permissions — loaded fresh from PostgreSQL, NEVER from a
 * JWT claim — contain ALL of them.
 *
 * Deny-by-default: a permission-protected route with no authenticated principal
 * is rejected (401); a principal missing any required code is rejected (403). It
 * answers only "may they do X?" — no warehouse-scope or grant-ceiling logic, and
 * no branching on role names (a role is just a permission bundle).
 *
 * Pair it with the authentication guard, which attaches the principal and is the
 * authority on active-user / active-session: `@UseGuards(JwtAuthGuard, PermissionGuard)`.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Merge (not override) the controller- and handler-level declarations: a
    // class-level base permission and a handler-level permission are BOTH
    // required. getAllAndMerge concatenates the two arrays; de-duplicate so a
    // code declared at both levels is enforced exactly once.
    const declared = this.reflector.getAllAndMerge<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const required = [...new Set(declared)];
    // No declared permissions on either level → nothing for this guard to enforce.
    if (required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request & Record<string, unknown>>();
    const principal = req[PRINCIPAL_KEY] as AuthPrincipal | undefined;
    // Deny-by-default: authorization cannot proceed without an authenticated
    // identity (the authentication guard must run first and attach it).
    if (!principal) throw new UnauthorizedException('Authentication required');

    const granted = await this.permissions.hasAllPermissions(
      { userId: principal.userId, roles: principal.roles },
      required,
    );
    if (!granted) throw new ForbiddenException('Insufficient permissions');
    return true;
  }
}
