import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@b2b/database';
import type { Logger } from '@b2b/logger';
import type { SessionView } from '@b2b/contracts';
import { APP_LOGGER } from '../../app.constants';
import { AppConfigService } from '../../common/config/app-config.service';
import { AuditWriter } from '../../common/audit/audit-writer.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit-actions';
import { CLOCK, type Clock } from '../../common/time/clock';
import type { RequestMeta } from '../../common/http/request-meta';
import { TOKEN_GENERATOR } from '../auth/auth.constants';
import type { TokenGenerator } from '../auth/ports/token-generator.port';
import { UserRepository } from '../identity/user.repository';
import { SessionRepository } from './session.repository';

/** A newly minted refresh token together with its session metadata. */
export interface IssuedRefreshToken {
  /** Plaintext refresh token — returned to the client once (cookie), never stored. */
  rawToken: string;
  /** Stable public session id. */
  sessionId: string;
  userId: bigint;
  expiresAt: Date;
}

/** Outcome of a rotation attempt. `reuse` means the family was revoked. */
export type RotateResult =
  | { type: 'rotated'; issued: IssuedRefreshToken }
  | { type: 'invalid' }
  | { type: 'reuse' };

/**
 * Refresh-session lifecycle: issue, rotate-with-reuse-detection, list and
 * revoke. Every mutating method runs inside the caller's transaction so the
 * rotation chain and any audit row commit atomically.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditWriter,
    private readonly config: AppConfigService,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  private ttl(now: Date): Date {
    return new Date(now.getTime() + this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  }

  /** Start a brand-new session (login). Creates a fresh token family. */
  async issue(
    tx: Prisma.TransactionClient,
    userId: bigint,
    meta: RequestMeta,
    now: Date,
  ): Promise<IssuedRefreshToken> {
    const { token, digest } = this.tokens.generate();
    const expiresAt = this.ttl(now);
    const { sessionId } = await this.sessions.create(
      {
        userId,
        tokenHash: digest,
        tokenFamilyId: randomUUID(),
        expiresAt,
        lastUsedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx,
    );
    return { rawToken: token, sessionId, userId, expiresAt };
  }

  /**
   * Rotate a presented refresh token: revoke it and mint a successor in the same
   * family + session. Detects reuse of an already-rotated token and revokes the
   * whole family (token-theft defense), recording a TOKEN_REUSE_DETECTED audit.
   *
   * Returns a discriminated result rather than throwing so the caller's
   * transaction COMMITS the family revocation on reuse (a thrown error would
   * roll the protective revoke back).
   */
  async rotate(
    tx: Prisma.TransactionClient,
    presentedToken: string,
    meta: RequestMeta,
    now: Date,
  ): Promise<RotateResult> {
    const digest = this.tokens.digest(presentedToken);
    // Lock the row so concurrent rotations of the same token serialize.
    const existing = await this.sessions.findByTokenHashForUpdate(digest, tx);
    if (!existing) return { type: 'invalid' };

    if (existing.revokedAt !== null) {
      await this.handleReuse(tx, existing, meta, now);
      return { type: 'reuse' };
    }
    if (existing.expiresAt.getTime() <= now.getTime()) {
      return { type: 'invalid' };
    }

    const { token, digest: newDigest } = this.tokens.generate();
    const expiresAt = this.ttl(now);
    const created = await this.sessions.create(
      {
        userId: existing.userId,
        tokenHash: newDigest,
        tokenFamilyId: existing.tokenFamilyId,
        sessionId: existing.sessionId, // stable session id across rotation
        expiresAt,
        lastUsedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx,
    );
    await this.sessions.markRotated(existing.id, created.id, now, tx);

    return {
      type: 'rotated',
      issued: {
        rawToken: token,
        sessionId: existing.sessionId,
        userId: existing.userId,
        expiresAt,
      },
    };
  }

  private async handleReuse(
    tx: Prisma.TransactionClient,
    token: { id: bigint; userId: bigint; sessionId: string; tokenFamilyId: string },
    meta: RequestMeta,
    now: Date,
  ): Promise<void> {
    const revoked = await this.sessions.revokeFamily(
      token.tokenFamilyId,
      'reuse_detected',
      now,
      tx,
    );
    const user = await this.users.findById(token.userId, tx);
    await this.audit.write(tx, {
      action: AUDIT_ACTIONS.TOKEN_REUSE_DETECTED,
      actor: user
        ? { id: user.id, email: user.email, name: user.fullName, rolesSnapshot: user.roles }
        : { id: token.userId },
      entityType: 'SESSION',
      entityId: token.id,
      after: { sessionId: token.sessionId, revokedTokens: revoked, reason: 'reuse_detected' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    this.logger.warn(
      { event: 'auth.refresh.reuse_detected', userId: user?.publicId, sessionId: token.sessionId },
      'refresh token reuse detected — family revoked',
    );
  }

  /** Resolve the active (non-revoked) session bound to a presented refresh token. */
  async findActiveByRawToken(
    rawToken: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ userId: bigint; sessionId: string } | null> {
    const existing = await this.sessions.findByTokenHash(this.tokens.digest(rawToken), tx);
    if (!existing || existing.revokedAt !== null) return null;
    return { userId: existing.userId, sessionId: existing.sessionId };
  }

  /** Whether a public session id is still active for the user (guard check). */
  async isActive(userId: bigint, sessionId: string, now: Date): Promise<boolean> {
    return this.sessions.isSessionActive(userId, sessionId, now);
  }

  /** List a user's active sessions, flagging the one in use this request. */
  async listActive(
    userId: bigint,
    now: Date,
    currentSessionId: string | null,
  ): Promise<SessionView[]> {
    const rows = await this.sessions.listActive(userId, now);
    return rows.map((r) => ({
      id: r.sessionId,
      current: currentSessionId !== null && r.sessionId === currentSessionId,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      expiresAt: r.expiresAt.toISOString(),
      ip: r.ip,
      userAgent: r.userAgent,
    }));
  }

  /** Revoke one of the user's sessions. Returns false when nothing matched. */
  async revokeSession(
    tx: Prisma.TransactionClient,
    userId: bigint,
    sessionId: string,
    now: Date,
  ): Promise<boolean> {
    const count = await this.sessions.revokeSession(userId, sessionId, 'logout', now, tx);
    return count > 0;
  }

  /** Revoke all of the user's sessions, optionally keeping the current one. */
  async revokeAll(
    tx: Prisma.TransactionClient,
    userId: bigint,
    reason: string,
    now: Date,
    exceptSessionId?: string,
  ): Promise<number> {
    return this.sessions.revokeAllForUser(userId, reason, now, tx, exceptSessionId);
  }
}
