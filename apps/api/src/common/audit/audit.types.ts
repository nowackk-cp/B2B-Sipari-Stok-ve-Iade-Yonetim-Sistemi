/**
 * Snapshot of the actor responsible for an audited change. Captured inline so
 * the audit row stays meaningful even if the user is later renamed or removed
 * (ADR-007). `id` is the internal user PK or null for unauthenticated/system.
 */
export interface AuditActor {
  id?: bigint | null;
  email?: string | null;
  name?: string | null;
  rolesSnapshot?: string[] | null;
}

/**
 * A single business-audit entry. Written in the SAME transaction as the
 * mutation it records (never via event/outbox). `before`/`after` are explicit
 * domain projections — callers must NOT pass secrets; the writer additionally
 * redacts secret-bearing keys defensively.
 */
export interface AuditEntry {
  /** Stable action code, e.g. PASSWORD_CHANGED (see audit-actions.ts). */
  action: string;
  actor?: AuditActor;
  entityType?: string;
  /** Internal entity PK (bigint). Public ids are not used in audit rows. */
  entityId?: bigint;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}
