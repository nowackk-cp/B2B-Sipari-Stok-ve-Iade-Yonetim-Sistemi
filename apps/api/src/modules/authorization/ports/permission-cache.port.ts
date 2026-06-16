/**
 * Effective-permission cache port (SECURITY_MODEL §6).
 *
 * A cache is strictly an optimization: PostgreSQL is the SINGLE source of truth
 * for a user's effective permissions, and the system MUST behave correctly with
 * the cache empty or absent (a cold/cleared cache simply forces a fresh DB load).
 *
 * Entries are keyed by `(companyId, userId, version)`, where `version` is the
 * composite `"<authorizationVersion>:<securityVersion>"` produced by
 * {@link PermissionService} — so the full key is
 * `companyId:userId:authzVersion:securityVersion`. The leading `companyId` keeps
 * tenants isolated: two companies that happen to use the same numeric userId can
 * never read each other's cached permission set (TASK-010b).
 *
 * The PRIMARY freshness anchor is `authorizationVersion`: a per-company monotonic
 * counter that PostgreSQL bumps in-transaction on EVERY permission-affecting
 * change (a grant added/removed, a role dropped, a user disabled, an assignment
 * changed). Because the caller loads that counter from PostgreSQL before every
 * lookup, a moved version yields a brand-new key and a stale entry — even one
 * sitting in another instance's separate in-memory cache — is structurally
 * unreachable, with NO local clear required (PG-004). The `securityVersion`
 * (a digest of current role membership) is a secondary guard. The TTL and the
 * explicit {@link PermissionCache.invalidate}/{@link PermissionCache.clear} hooks
 * remain as optimizations only. The production binding may be Redis (short-lived
 * only); Redis is never authoritative for security state.
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
