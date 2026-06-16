import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PERMISSION_CACHE } from './authorization.constants';
import type { PermissionCache } from './ports/permission-cache.port';
import { PermissionRepository } from './permission.repository';

/** The subset of an authenticated principal the permission loader needs. */
export interface PermissionSubject {
  userId: bigint;
  /**
   * Owning tenant — the user's REAL company id from PostgreSQL (never a JWT
   * claim). Permissions resolve only through same-company roles, and the cache
   * key is partitioned by it, so a forged token company cannot leak grants.
   */
  companyId: bigint;
  /** Current role names (loaded fresh from the DB by the auth guard). */
  roles: string[];
}

/**
 * Resolves a user's effective permissions and answers "may they do X?".
 *
 * The authoritative source is always PostgreSQL (via {@link PermissionRepository});
 * the cache is a short-lived optimization. Its key folds in TWO freshness anchors,
 * BOTH read from PostgreSQL (never a JWT claim):
 *   - the company's `authorization_version` — bumped in-transaction by DB triggers
 *     on EVERY permission-affecting change (a grant added/removed, a role dropped,
 *     a user disabled, an assignment changed), so a moved version is observed on
 *     every API instance and the old key is never read again — no local clear
 *     needed (PG-004); and
 *   - a digest of the user's current role membership.
 * The current authorization_version is loaded BEFORE every lookup, so a stale
 * entry can never grant (or keep denying) access once the DB has moved on, even
 * across two independent in-memory caches. A cold/cleared/throwing cache simply
 * forces a fresh DB load — the cache is never a hard dependency for authorization
 * and never fails open.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    private readonly repo: PermissionRepository,
    @Inject(PERMISSION_CACHE) private readonly cache: PermissionCache,
  ) {}

  /**
   * Security version for the cache key: a stable digest of the user's current
   * role set. Combined with the DB authorization_version (the primary anchor),
   * this is a secondary guard so even a role-membership change alone yields a new
   * key.
   */
  private securityVersion(roles: string[]): string {
    const canonical = [...new Set(roles)].sort().join('\n');
    return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
  }

  /**
   * Compose the cache version string: `<authzVersion>:<securityVersion>`. With the
   * adapter prefixing `companyId:userId:`, the full key is exactly
   * `companyId:userId:authzVersion:securityVersion`. `securityVersion` is
   * base64url (no `:`), so the segments never collide.
   */
  private cacheVersion(authzVersion: bigint, roles: string[]): string {
    return `${authzVersion.toString()}:${this.securityVersion(roles)}`;
  }

  /** Effective permission codes for the subject (cached; PostgreSQL on miss). */
  async getEffectivePermissions(subject: PermissionSubject): Promise<ReadonlySet<string>> {
    // Load the company's CURRENT authorization version from PostgreSQL FIRST. This
    // is the freshness anchor: a permission-affecting change has already bumped it
    // in-transaction, so the lookup below targets a brand-new key and a stale
    // entry (here or on another instance) is structurally unreachable. If this DB
    // read fails the whole check fails closed (no access granted) — never open.
    const authzVersion = await this.repo.loadAuthzVersion(subject.companyId);
    const version = this.cacheVersion(authzVersion, subject.roles);

    const cached = await this.cacheGet(subject.companyId, subject.userId, version);
    if (cached) return cached;

    const codes = await this.repo.loadEffectivePermissionCodes(subject.userId, subject.companyId);
    const permissions = new Set(codes);
    await this.cacheSet(subject.companyId, subject.userId, version, permissions);
    return permissions;
  }

  /** Cache read that NEVER throws into the request path: a failing/disabled cache
   * degrades to a fresh PostgreSQL load (deny-by-default still applies), it is
   * never allowed to fail open. */
  private async cacheGet(
    companyId: bigint,
    userId: bigint,
    version: string,
  ): Promise<ReadonlySet<string> | null> {
    try {
      return await this.cache.get(companyId, userId, version);
    } catch (err) {
      this.logger.warn(`permission cache get failed; falling back to PostgreSQL: ${String(err)}`);
      return null;
    }
  }

  /** Cache write that NEVER throws into the request path: failing to memoize is
   * harmless (the authoritative DB result is already in hand). */
  private async cacheSet(
    companyId: bigint,
    userId: bigint,
    version: string,
    permissions: ReadonlySet<string>,
  ): Promise<void> {
    try {
      await this.cache.set(companyId, userId, version, permissions);
    } catch (err) {
      this.logger.warn(`permission cache set failed (non-fatal): ${String(err)}`);
    }
  }

  /** Whether the subject holds EVERY required code (deny-by-default on absence). */
  async hasAllPermissions(subject: PermissionSubject, required: string[]): Promise<boolean> {
    if (required.length === 0) return true;
    const effective = await this.getEffectivePermissions(subject);
    return required.every((code) => effective.has(code));
  }
}
