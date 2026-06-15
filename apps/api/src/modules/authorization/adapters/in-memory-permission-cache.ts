import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/time/clock';
import type { PermissionCache } from '../ports/permission-cache.port';

/** How long a cached permission set stays fresh. Deliberately short: PostgreSQL
 * is authoritative, so this only absorbs request bursts and bounds the staleness
 * of a permission added to an already-assigned role. */
export const PERMISSION_CACHE_TTL_MS = 5_000;

interface Entry {
  expiresAtMs: number;
  permissions: ReadonlySet<string>;
}

/**
 * Process-local, short-TTL effective-permission cache — the default binding.
 *
 * Like {@link InMemoryRateLimiter} it is single-instance and therefore not a
 * cross-node cache; it is correct (PostgreSQL remains the source of truth) and
 * keeps tests hermetic without Redis. A Redis adapter can replace it later with
 * no change to {@link PermissionService}. Expiry uses the injected clock so the
 * TTL is deterministic under test.
 */
@Injectable()
export class InMemoryPermissionCache implements PermissionCache {
  private readonly entries = new Map<string, Entry>();

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  // Tenant-isolated key: companyId FIRST so the same numeric userId in two
  // companies maps to two distinct entries (no cross-tenant collision).
  private key(companyId: bigint, userId: bigint, version: string): string {
    return `${companyId.toString()}:${userId.toString()}:${version}`;
  }

  async get(
    companyId: bigint,
    userId: bigint,
    version: string,
  ): Promise<ReadonlySet<string> | null> {
    const k = this.key(companyId, userId, version);
    const entry = this.entries.get(k);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.clock.now().getTime()) {
      this.entries.delete(k);
      return null;
    }
    return entry.permissions;
  }

  async set(
    companyId: bigint,
    userId: bigint,
    version: string,
    permissions: ReadonlySet<string>,
  ): Promise<void> {
    this.entries.set(this.key(companyId, userId, version), {
      expiresAtMs: this.clock.now().getTime() + PERMISSION_CACHE_TTL_MS,
      permissions,
    });
  }

  async invalidate(userId: bigint): Promise<void> {
    // Keys are `companyId:userId:version`; a user belongs to exactly one company,
    // so match on the userId segment to drop all of that user's entries. The
    // invalidation policy (drop everything for a user) is unchanged.
    const needle = `:${userId.toString()}:`;
    for (const key of this.entries.keys()) {
      if (key.includes(needle)) this.entries.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}
