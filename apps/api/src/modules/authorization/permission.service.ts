import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PERMISSION_CACHE } from './authorization.constants';
import type { PermissionCache } from './ports/permission-cache.port';
import { PermissionRepository } from './permission.repository';

/** The subset of an authenticated principal the permission loader needs. */
export interface PermissionSubject {
  userId: bigint;
  /** Current role names (loaded fresh from the DB by the auth guard). */
  roles: string[];
}

/**
 * Resolves a user's effective permissions and answers "may they do X?".
 *
 * The authoritative source is always PostgreSQL (via {@link PermissionRepository});
 * the cache is a short-lived optimization keyed by the user plus a security
 * version derived from their role membership, so a role change can never serve a
 * stale set. A cold or cleared cache transparently falls back to a fresh DB load.
 */
@Injectable()
export class PermissionService {
  constructor(
    private readonly repo: PermissionRepository,
    @Inject(PERMISSION_CACHE) private readonly cache: PermissionCache,
  ) {}

  /**
   * Security version for the cache key: a stable digest of the user's current
   * role set. Role assignment changes shift the version (so old entries are
   * never read); permission-within-a-role changes are bounded by the cache TTL
   * and explicit invalidation.
   */
  private securityVersion(roles: string[]): string {
    const canonical = [...new Set(roles)].sort().join('\n');
    return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
  }

  /** Effective permission codes for the subject (cached; PostgreSQL on miss). */
  async getEffectivePermissions(subject: PermissionSubject): Promise<ReadonlySet<string>> {
    const version = this.securityVersion(subject.roles);
    const cached = await this.cache.get(subject.userId, version);
    if (cached) return cached;

    const codes = await this.repo.loadEffectivePermissionCodes(subject.userId);
    const permissions = new Set(codes);
    await this.cache.set(subject.userId, version, permissions);
    return permissions;
  }

  /** Whether the subject holds EVERY required code (deny-by-default on absence). */
  async hasAllPermissions(subject: PermissionSubject, required: string[]): Promise<boolean> {
    if (required.length === 0) return true;
    const effective = await this.getEffectivePermissions(subject);
    return required.every((code) => effective.has(code));
  }
}
