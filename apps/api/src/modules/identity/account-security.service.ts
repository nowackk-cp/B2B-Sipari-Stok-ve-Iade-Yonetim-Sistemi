import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { Logger } from '@b2b/logger';
import { APP_LOGGER } from '../../app.constants';
import { AppConfigService } from '../../common/config/app-config.service';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import type { RequestMeta } from '../../common/http/request-meta';
import { type AuthUser, UserRepository } from './user.repository';

/**
 * Durable account-security state machine: failed-attempt counting and temporary
 * lockout. Authoritative in PostgreSQL (CLAUDE.md §8 — Redis is never the source
 * of truth). All mutations take a transaction handle so the counter change and
 * the lock audit commit atomically.
 */
@Injectable()
export class AccountSecurityService {
  constructor(
    private readonly users: UserRepository,
    private readonly audit: AuditWriter,
    private readonly config: AppConfigService,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  /** True while the account is locked at `now`. */
  isLocked(user: Pick<AuthUser, 'lockedUntil'>, now: Date): boolean {
    return user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
  }

  /**
   * Register a failed login attempt: atomically increment the counter and, when
   * the threshold is reached, lock the account. Only the request that wins the
   * lock race writes the ACCOUNT_LOCKED business audit (same transaction).
   */
  async registerFailedAttempt(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    now: Date,
    meta: RequestMeta,
  ): Promise<void> {
    const newCount = await this.users.incrementFailedLogin(user.id, tx);
    const { threshold, durationMinutes } = this.config.lockout;
    if (newCount < threshold) return;

    const lockedUntil = new Date(now.getTime() + durationMinutes * 60_000);
    const won = await this.users.lockIfUnlocked(user.id, lockedUntil, tx);
    if (!won) return;

    await this.audit.write(tx, {
      action: AUDIT_ACTIONS.ACCOUNT_LOCKED,
      actor: { id: user.id, email: user.email, name: user.fullName, rolesSnapshot: user.roles },
      entityType: 'USER',
      entityId: user.id,
      after: { lockedUntil: lockedUntil.toISOString(), reason: 'failed_login_threshold' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    this.logger.warn(
      {
        event: 'auth.account.locked',
        userId: user.publicId,
        lockedUntil: lockedUntil.toISOString(),
      },
      'account temporarily locked after failed attempts',
    );
  }

  /** Record a successful login (reset counters + lastLogin) in the caller's tx. */
  async registerSuccess(tx: Prisma.TransactionClient, user: AuthUser, now: Date): Promise<void> {
    await this.users.recordSuccessfulLogin(user.id, now, tx);
  }

  /** Lazily clear a lock whose window has already elapsed (best-effort). */
  async clearExpiredLock(tx: Prisma.TransactionClient, user: AuthUser, now: Date): Promise<void> {
    if (user.lockedUntil !== null && user.lockedUntil.getTime() <= now.getTime()) {
      await this.users.clearExpiredLock(user.id, now, tx);
    }
  }
}
