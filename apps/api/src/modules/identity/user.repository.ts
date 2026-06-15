import { Injectable } from '@nestjs/common';
import type { DbClient } from '../../common/database/db-client';
import { PrismaService } from '../../common/database/prisma.service';

/** Internal, fully-typed user record used across the auth services. Never
 * returned to clients — the controller maps to the whitelisted contract view. */
export interface AuthUser {
  id: bigint;
  publicId: string;
  /** Owning tenant, read from PostgreSQL (never trusted from a JWT claim). */
  companyId: bigint;
  email: string;
  passwordHash: string;
  fullName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
  failedLoginCount: number;
  lockedUntil: Date | null;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  roles: string[];
}

const USER_WITH_ROLES = {
  roles: { select: { role: { select: { name: true } } } },
} as const;

interface UserRow {
  id: bigint;
  publicId: string;
  companyId: bigint;
  email: string;
  passwordHash: string;
  fullName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
  failedLoginCount: number;
  lockedUntil: Date | null;
  passwordChangedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  roles: { role: { name: string } }[];
}

function toAuthUser(row: UserRow): AuthUser {
  const { roles, ...rest } = row;
  return { ...rest, roles: roles.map((r) => r.role.name) };
}

/**
 * Identity module's data access (owns the `users` table — MODULE_BOUNDARIES §2).
 * Every method takes an explicit executor so it composes inside a caller's
 * transaction; `db()` falls back to the root client for read paths.
 */
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(executor?: DbClient): DbClient {
    return executor ?? this.prisma.client;
  }

  /** Look up by email (citext → case-insensitive). Includes role names. */
  async findByEmail(email: string, executor?: DbClient): Promise<AuthUser | null> {
    const row = await this.db(executor).user.findUnique({
      where: { email },
      include: USER_WITH_ROLES,
    });
    return row ? toAuthUser(row as UserRow) : null;
  }

  /** Look up by public UUID. Includes role names. */
  async findByPublicId(publicId: string, executor?: DbClient): Promise<AuthUser | null> {
    const row = await this.db(executor).user.findUnique({
      where: { publicId },
      include: USER_WITH_ROLES,
    });
    return row ? toAuthUser(row as UserRow) : null;
  }

  async findById(id: bigint, executor?: DbClient): Promise<AuthUser | null> {
    const row = await this.db(executor).user.findUnique({
      where: { id },
      include: USER_WITH_ROLES,
    });
    return row ? toAuthUser(row as UserRow) : null;
  }

  /** Atomically increment the failed-login counter; returns the new value. */
  async incrementFailedLogin(userId: bigint, executor: DbClient): Promise<number> {
    const updated = await executor.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    return updated.failedLoginCount;
  }

  /**
   * Lock the account until `lockedUntil`, but ONLY if it is not already locked.
   * Returns true for the caller that won the race (so it alone audits the lock).
   * Resets the failed counter so a post-expiry attempt starts fresh.
   */
  async lockIfUnlocked(userId: bigint, lockedUntil: Date, executor: DbClient): Promise<boolean> {
    const res = await executor.user.updateMany({
      where: { id: userId, lockedUntil: null },
      data: { lockedUntil, failedLoginCount: 0 },
    });
    return res.count === 1;
  }

  /** Clear an expired lock and reset the counter (returns true if it changed). */
  async clearExpiredLock(userId: bigint, now: Date, executor: DbClient): Promise<boolean> {
    const res = await executor.user.updateMany({
      where: { id: userId, lockedUntil: { lte: now } },
      data: { lockedUntil: null, failedLoginCount: 0 },
    });
    return res.count === 1;
  }

  /** Record a successful login: reset counters, clear lock, set last-login. */
  async recordSuccessfulLogin(userId: bigint, at: Date, executor: DbClient): Promise<void> {
    await executor.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: at },
    });
  }

  /** Update the password hash and stamp passwordChangedAt (real password change). */
  async updatePassword(
    userId: bigint,
    passwordHash: string,
    at: Date,
    executor: DbClient,
  ): Promise<void> {
    await executor.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: at },
    });
  }

  /** Replace only the hash (transparent rehash on login — password unchanged). */
  async updateHashOnly(userId: bigint, passwordHash: string, executor: DbClient): Promise<void> {
    await executor.user.update({ where: { id: userId }, data: { passwordHash } });
  }
}
