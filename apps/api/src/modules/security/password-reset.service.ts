import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { Logger } from '@b2b/logger';
import { APP_LOGGER } from '../../app.constants';
import { AppConfigService } from '../../common/config/app-config.service';
import { PrismaService } from '../../common/database/prisma.service';
import { CLOCK, type Clock } from '../../common/time/clock';
import type { RequestMeta } from '../../common/http/request-meta';
import { EMAIL_OUTBOX, TOKEN_GENERATOR } from '../auth/auth.constants';
import type { TokenGenerator } from '../auth/ports/token-generator.port';
import type { EmailOutbox } from '../auth/ports/email-outbox.port';
import { UserRepository } from '../identity/user.repository';
import { PasswordResetRepository } from './password-reset.repository';

/**
 * Password-reset token lifecycle (CSPRNG, digest-only, single-use, short-lived).
 *
 * `requestReset` is enumeration-safe: it performs identical-looking work and the
 * controller always returns the same generic success. A token is only minted for
 * an existing active user, and the raw token reaches the user solely via the
 * transactional email outbox — never a log or audit row.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly resets: PasswordResetRepository,
    private readonly users: UserRepository,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGenerator,
    @Inject(EMAIL_OUTBOX) private readonly email: EmailOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  /** Request a reset. No-op (but constant generic outcome) for unknown/inactive
   * accounts. Existing active tokens for the user are invalidated first. */
  async requestReset(email: string, meta: RequestMeta): Promise<void> {
    const now = this.clock.now();
    const user = await this.users.findByEmail(email);
    if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') {
      this.logger.info(
        { event: 'auth.password_reset.requested', outcome: 'no_active_user' },
        'password reset requested for unknown/inactive account (generic response)',
      );
      return;
    }

    const { token, digest } = this.tokens.generate();
    const expiresAt = new Date(now.getTime() + this.config.passwordResetTtlMinutes * 60_000);

    await this.prisma.transaction(async (tx) => {
      await this.resets.consumeActiveForUser(user.id, now, tx);
      await this.resets.create(
        { userId: user.id, tokenHash: digest, expiresAt, requestedByIp: meta.ip },
        tx,
      );
      await this.email.enqueuePasswordReset(tx, {
        userId: user.id,
        userPublicId: user.publicId,
        email: user.email,
        resetToken: token,
        expiresAt,
        dedupKey: digest,
      });
    });

    this.logger.info(
      { event: 'auth.password_reset.requested', outcome: 'issued', userId: user.publicId },
      'password reset token issued',
    );
  }

  /**
   * Consume a presented reset token inside the caller's transaction. Returns the
   * owning userId or null when the token is invalid/expired/already used. The
   * raw token is never logged.
   */
  async consume(tx: Prisma.TransactionClient, rawToken: string, now: Date): Promise<bigint | null> {
    const digest = this.tokens.digest(rawToken);
    return this.resets.consumeByDigest(digest, now, tx);
  }
}
