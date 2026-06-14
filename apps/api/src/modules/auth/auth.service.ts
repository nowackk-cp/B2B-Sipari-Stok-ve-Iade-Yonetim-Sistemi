import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { Logger } from '@b2b/logger';
import type { AuthSessionView, SessionView, UserProfileView } from '@b2b/contracts';
import { evaluatePassword } from '@b2b/domain';
import { APP_LOGGER } from '../../app.constants';
import { AppConfigService } from '../../common/config/app-config.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import { CLOCK, type Clock } from '../../common/time/clock';
import type { RequestMeta } from '../../common/http/request-meta';
import type { AuthPrincipal } from '../../common/auth/principal';
import { AccountSecurityService } from '../identity/account-security.service';
import { type AuthUser, UserRepository } from '../identity/user.repository';
import { toUserProfileView } from '../identity/user-view';
import { SessionService } from '../sessions/session.service';
import { PasswordResetService } from '../security/password-reset.service';
import { ACCESS_TOKEN_SIGNER, PASSWORD_HASHER, RATE_LIMITER } from './auth.constants';
import type { AccessTokenSigner } from './ports/access-token.port';
import type { PasswordHasher } from './ports/password-hasher.port';
import type { RateLimiter } from './ports/rate-limiter.port';

/** Successful login/refresh result the controller turns into cookie + body. */
export interface AuthSuccess {
  body: AuthSessionView;
  /** Raw refresh token to set as the HttpOnly cookie (never in the JSON body). */
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserRepository,
    private readonly accountSecurity: AccountSecurityService,
    private readonly sessions: SessionService,
    private readonly passwordReset: PasswordResetService,
    private readonly audit: AuditWriter,
    private readonly config: AppConfigService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(ACCESS_TOKEN_SIGNER) private readonly signer: AccessTokenSigner,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  // --- login -----------------------------------------------------------------

  async login(email: string, password: string, meta: RequestMeta): Promise<AuthSuccess> {
    const identifier = email.trim().toLowerCase();
    await this.enforceLoginRateLimit(identifier, meta);

    const outcome = await this.prisma.transaction(async (tx) => {
      const now = this.clock.now();
      const user = await this.users.findByEmail(identifier, tx);
      if (!user) {
        await this.burnTiming(password);
        return { ok: false as const };
      }

      // Lazily clear an elapsed lock so the user gets a fresh attempt budget.
      if (user.lockedUntil !== null && user.lockedUntil.getTime() <= now.getTime()) {
        await this.accountSecurity.clearExpiredLock(tx, user, now);
        user.lockedUntil = null;
        user.failedLoginCount = 0;
      }

      const inactive = user.status !== 'ACTIVE' || user.deletedAt !== null;
      const locked = this.accountSecurity.isLocked(user, now);
      if (inactive || locked) {
        await this.burnTiming(password);
        this.logFailedLogin(identifier, user, meta, locked ? 'locked' : 'inactive');
        return { ok: false as const };
      }

      const valid = await this.hasher.verify(password, user.passwordHash);
      if (!valid) {
        await this.accountSecurity.registerFailedAttempt(tx, user, now, meta);
        this.logFailedLogin(identifier, user, meta, 'bad_password');
        return { ok: false as const };
      }

      await this.accountSecurity.registerSuccess(tx, user, now);
      if (this.hasher.needsRehash(user.passwordHash)) {
        await this.users.updateHashOnly(user.id, await this.hasher.hash(password), tx);
      }
      const issued = await this.sessions.issue(tx, user.id, meta, now);
      return {
        ok: true as const,
        user,
        sessionId: issued.sessionId,
        refreshToken: issued.rawToken,
      };
    });

    if (!outcome.ok) {
      // Identical response for unknown/wrong/disabled/locked — no enumeration.
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.resetLoginRateLimit(identifier, meta);
    return this.buildSuccess(outcome.user, outcome.sessionId, outcome.refreshToken);
  }

  // --- refresh ---------------------------------------------------------------

  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<AuthSuccess> {
    if (!rawToken) throw new UnauthorizedException('Invalid refresh token');

    const outcome = await this.prisma.transaction(async (tx) => {
      const now = this.clock.now();
      const result = await this.sessions.rotate(tx, rawToken, meta, now);
      if (result.type !== 'rotated') return result;
      const user = await this.users.findById(result.issued.userId, tx);
      if (!user || user.status !== 'ACTIVE' || user.deletedAt !== null) {
        // Roll back the just-issued rotation for an inactive account.
        throw new UnauthorizedException('Invalid refresh token');
      }
      return {
        type: 'rotated' as const,
        user,
        sessionId: result.issued.sessionId,
        refreshToken: result.issued.rawToken,
      };
    });

    if (outcome.type !== 'rotated') {
      // 'invalid' or 'reuse' — generic 401. On reuse the family revoke committed.
      throw new UnauthorizedException('Invalid refresh token');
    }
    return this.buildSuccess(outcome.user, outcome.sessionId, outcome.refreshToken);
  }

  // --- logout / sessions -----------------------------------------------------

  /** Idempotent logout of the session bound to the presented refresh token. */
  async logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
    if (!rawToken) return;
    await this.prisma.transaction(async (tx) => {
      const now = this.clock.now();
      const token = await this.sessions.findActiveByRawToken(rawToken, tx);
      if (!token) return;
      const user = await this.users.findById(token.userId, tx);
      const revoked = await this.sessions.revokeSession(tx, token.userId, token.sessionId, now);
      if (revoked && user) {
        await this.auditSessionRevoked(tx, user, token.sessionId, meta, 'logout');
      }
    });
  }

  async listSessions(principal: AuthPrincipal): Promise<SessionView[]> {
    return this.sessions.listActive(principal.userId, this.clock.now(), principal.sessionId);
  }

  /** Revoke one of the caller's own sessions (404 when not owned/found). */
  async revokeSession(
    principal: AuthPrincipal,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const revoked = await this.prisma.transaction(async (tx) => {
      const now = this.clock.now();
      const ok = await this.sessions.revokeSession(tx, principal.userId, sessionId, now);
      if (ok) {
        await this.auditSessionRevoked(tx, principal, sessionId, meta, 'revoked');
      }
      return ok;
    });
    if (!revoked) {
      throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    }
  }

  /** Revoke all the caller's sessions (logout everywhere). */
  async logoutAll(principal: AuthPrincipal, meta: RequestMeta): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const now = this.clock.now();
      const count = await this.sessions.revokeAll(tx, principal.userId, 'logout_all', now);
      await this.audit.write(tx, {
        action: AUDIT_ACTIONS.ALL_SESSIONS_REVOKED,
        actor: this.actorFrom(principal),
        entityType: 'USER',
        entityId: principal.userId,
        after: { revokedSessions: count },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    });
  }

  // --- profile ---------------------------------------------------------------

  async getProfile(principal: AuthPrincipal): Promise<UserProfileView> {
    const user = await this.users.findById(principal.userId);
    if (!user) throw new UnauthorizedException('Account is not active');
    return toUserProfileView(user);
  }

  // --- password change (authenticated) --------------------------------------

  async changePassword(
    principal: AuthPrincipal,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const policy = evaluatePassword(newPassword);
    if (!policy.ok) throw this.passwordPolicyError(policy.violations);

    await this.prisma.transaction(async (tx) => {
      const now = this.clock.now();
      const user = await this.users.findById(principal.userId, tx);
      if (!user) throw new UnauthorizedException('Account is not active');

      const valid = await this.hasher.verify(currentPassword, user.passwordHash);
      if (!valid) throw new UnprocessableEntityException('Current password is incorrect');

      const newHash = await this.hasher.hash(policy.normalized);
      await this.users.updatePassword(user.id, newHash, now, tx);
      // Revoke every OTHER session; the current device stays signed in.
      const revoked = await this.sessions.revokeAll(
        tx,
        user.id,
        'password_changed',
        now,
        principal.sessionId,
      );
      await this.audit.write(tx, {
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        actor: this.actorFrom(user),
        entityType: 'USER',
        entityId: user.id,
        after: { passwordChangedAt: now.toISOString(), otherSessionsRevoked: revoked },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    });
  }

  // --- forgot / reset password ----------------------------------------------

  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    // Always a generic success; the service is enumeration-safe internally.
    await this.passwordReset.requestReset(email.trim().toLowerCase(), meta);
  }

  async resetPassword(rawToken: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const policy = evaluatePassword(newPassword);
    if (!policy.ok) throw this.passwordPolicyError(policy.violations);

    const ok = await this.prisma.transaction(async (tx) => {
      const now = this.clock.now();
      const userId = await this.passwordReset.consume(tx, rawToken, now);
      if (userId === null) return false;
      const user = await this.users.findById(userId, tx);
      if (!user) return false;

      const newHash = await this.hasher.hash(policy.normalized);
      await this.users.updatePassword(user.id, newHash, now, tx);
      // A reset implies possible compromise → revoke ALL sessions.
      const revoked = await this.sessions.revokeAll(tx, user.id, 'password_reset', now);
      await this.audit.write(tx, {
        action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
        actor: this.actorFrom(user),
        entityType: 'USER',
        entityId: user.id,
        after: { passwordChangedAt: now.toISOString(), sessionsRevoked: revoked },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return true;
    });

    if (!ok) {
      throw new UnprocessableEntityException('Invalid or expired reset token');
    }
  }

  // --- helpers ---------------------------------------------------------------

  private buildSuccess(user: AuthUser, sessionId: string, refreshToken: string): AuthSuccess {
    const access = this.signer.issue({ subject: user.publicId, sessionId });
    return {
      body: {
        tokenType: 'Bearer',
        accessToken: access.token,
        expiresIn: access.expiresIn,
        user: toUserProfileView(user),
      },
      refreshToken,
    };
  }

  private actorFrom(u: {
    id?: bigint;
    userId?: bigint;
    email: string;
    fullName: string;
    roles: string[];
  }) {
    return {
      id: u.id ?? u.userId ?? null,
      email: u.email,
      name: u.fullName,
      rolesSnapshot: u.roles,
    };
  }

  private async auditSessionRevoked(
    tx: Prisma.TransactionClient,
    actor: { id?: bigint; userId?: bigint; email: string; fullName: string; roles: string[] },
    sessionId: string,
    meta: RequestMeta,
    reason: string,
  ): Promise<void> {
    await this.audit.write(tx, {
      action: AUDIT_ACTIONS.SESSION_REVOKED,
      actor: this.actorFrom(actor),
      entityType: 'SESSION',
      after: { sessionId, reason },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  private passwordPolicyError(violations: { message: string }[]): UnprocessableEntityException {
    return new UnprocessableEntityException({
      message: violations.map((v) => `newPassword: ${v.message}`),
      error: 'Password does not meet policy',
    });
  }

  private async enforceLoginRateLimit(identifier: string, meta: RequestMeta): Promise<void> {
    const { max, windowSeconds } = this.config.loginRateLimit;
    const keys = [`login:id:${identifier}`];
    if (meta.ip) keys.push(`login:ip:${meta.ip}`);
    for (const key of keys) {
      const res = await this.rateLimiter.hit(key, max, windowSeconds);
      if (!res.allowed) {
        this.logger.warn(
          { event: 'auth.login.rate_limited', identifier, ip: meta.ip },
          'login rate limit exceeded',
        );
        throw new HttpException(
          { message: `Too many attempts. Retry in ${res.retryAfterSeconds}s.` },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  private async resetLoginRateLimit(identifier: string, meta: RequestMeta): Promise<void> {
    await this.rateLimiter.reset(`login:id:${identifier}`);
    if (meta.ip) await this.rateLimiter.reset(`login:ip:${meta.ip}`);
  }

  /** Burn ~one hash verification to equalize timing for unknown/disabled users. */
  private async burnTiming(password: string): Promise<void> {
    if (!this.dummyHash) this.dummyHash = this.hasher.hash(`dummy:${randomUUID()}`);
    try {
      await this.hasher.verify(password, await this.dummyHash);
    } catch {
      // Timing-only; result intentionally ignored.
    }
  }

  private logFailedLogin(
    identifier: string,
    user: AuthUser | null,
    meta: RequestMeta,
    reason: string,
  ): void {
    this.logger.warn(
      {
        event: 'auth.login.failed',
        identifier,
        userId: user?.publicId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        reason,
      },
      'login failed',
    );
  }
}
