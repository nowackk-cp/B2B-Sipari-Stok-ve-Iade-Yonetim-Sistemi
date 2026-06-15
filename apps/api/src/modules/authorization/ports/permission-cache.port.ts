/**
 * Effective-permission cache port (SECURITY_MODEL §6).
 *
 * A cache is strictly an optimization: PostgreSQL is the SINGLE source of truth
 * for a user's effective permissions, and the system MUST behave correctly with
 * the cache empty or absent (a cold/cleared cache simply forces a fresh DB load).
 *
 * Entries are keyed by `(companyId, userId, securityVersion)`. The leading
 * `companyId` keeps tenants isolated: two companies that happen to use the same
 * numeric userId can never read each other's cached permission set (TASK-010b).
 * The security version encodes the user's current role membership, so a role
 * assignment change yields a new key and never reads a stale entry; finer-grained
 * changes (a permission added to an already-assigned role) are bounded by the
 * adapter's short TTL and the explicit
 * {@link PermissionCache.invalidate}/{@link PermissionCache.clear} hooks. The
 * production binding may be Redis (short-lived only); Redis is never
 * authoritative for security state.
 */
export interface PermissionCache {
  /** Cached set for `(companyId, userId, version)`, or null on miss. */
  get(companyId: bigint, userId: bigint, version: string): Promise<ReadonlySet<string> | null>;
  /** Store the effective permission set for `(companyId, userId, version)`. */
  set(
    companyId: bigint,
    userId: bigint,
    version: string,
    permissions: ReadonlySet<string>,
  ): Promise<void>;
  /** Drop every cached entry for a user (any company/version) — e.g. after a perm change. */
  invalidate(userId: bigint): Promise<void>;
  /** Drop the entire cache (test isolation / emergency flush). */
  clear(): Promise<void>;
}
