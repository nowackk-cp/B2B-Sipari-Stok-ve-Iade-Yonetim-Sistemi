/**
 * Effective-permission cache port (SECURITY_MODEL §6).
 *
 * A cache is strictly an optimization: PostgreSQL is the SINGLE source of truth
 * for a user's effective permissions, and the system MUST behave correctly with
 * the cache empty or absent (a cold/cleared cache simply forces a fresh DB load).
 *
 * Entries are keyed by `(userId, securityVersion)`. The security version encodes
 * the user's current role membership, so a role assignment change yields a new
 * key and never reads a stale entry; finer-grained changes (a permission added
 * to an already-assigned role) are bounded by the adapter's short TTL and the
 * explicit {@link PermissionCache.invalidate}/{@link PermissionCache.clear}
 * hooks. The production binding may be Redis (short-lived only); Redis is never
 * authoritative for security state.
 */
export interface PermissionCache {
  /** Return the cached permission set for `(userId, version)`, or null on miss. */
  get(userId: bigint, version: string): Promise<ReadonlySet<string> | null>;
  /** Store the effective permission set for `(userId, version)`. */
  set(userId: bigint, version: string, permissions: ReadonlySet<string>): Promise<void>;
  /** Drop every cached entry for a user (any version) — e.g. after a perm change. */
  invalidate(userId: bigint): Promise<void>;
  /** Drop the entire cache (test isolation / emergency flush). */
  clear(): Promise<void>;
}
