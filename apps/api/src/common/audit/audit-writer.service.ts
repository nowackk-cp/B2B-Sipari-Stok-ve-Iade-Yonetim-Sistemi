import { Injectable } from '@nestjs/common';
import { Prisma } from '@b2b/database';
import { getRequestContext } from '@b2b/logger';
import { redactForAudit } from './audit-redact';
import type { AuditEntry } from './audit.types';

/**
 * Transaction-aware business-audit writer (ADR-007 / MODULE_BOUNDARIES §3.4).
 *
 * `write(tx, entry)` inserts an immutable `audit_logs` row using the SAME
 * transaction handle as the mutation. If the surrounding transaction rolls back,
 * the audit row rolls back with it; if the audit insert fails, the mutation
 * rolls back too. Audit is NEVER written via event/outbox/async consumer.
 *
 * The append-only trigger on `audit_logs` blocks UPDATE/DELETE at the DB level.
 */
@Injectable()
export class AuditWriter {
  async write(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    const requestId = getRequestContext()?.requestId ?? null;

    await tx.auditLog.create({
      data: {
        actorId: entry.actor?.id ?? null,
        actorEmail: entry.actor?.email ?? null,
        actorName: entry.actor?.name ?? null,
        actorRolesSnapshot: toJson(entry.actor?.rolesSnapshot ?? undefined),
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        // Defensive redaction: even though callers pass explicit domain
        // projections, never let a secret-bearing key reach the audit row.
        before: toJson(entry.before),
        after: toJson(entry.after),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        requestId,
      },
    });
  }
}

/** Map an optional value to a Prisma JSON input, redacting secrets, using SQL
 * NULL when absent (nullable Json columns reject a bare JS `null`). */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return redactForAudit(value) as Prisma.InputJsonValue;
}
