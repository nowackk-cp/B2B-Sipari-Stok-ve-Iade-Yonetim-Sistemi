import { describe, expect, it } from 'vitest';
import type { Prisma } from '@b2b/database';
import { AuditWriter } from '../../src/common/audit/audit-writer.service';

function captureTx() {
  const captured: { data?: Record<string, unknown> } = {};
  const tx = {
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.data = args.data;
        return undefined;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, captured };
}

describe('AuditWriter redaction', () => {
  const writer = new AuditWriter();

  it('redacts secret-bearing keys in before/after', async () => {
    const { tx, captured } = captureTx();
    await writer.write(tx, {
      action: 'PASSWORD_CHANGED',
      actor: { id: 1n, email: 'a@b.c', name: 'A', rolesSnapshot: ['ADMIN'] },
      entityType: 'USER',
      entityId: 1n,
      after: {
        passwordChangedAt: '2026-06-15T00:00:00Z',
        password: 'super-secret',
        passwordHash: '$argon2id$...',
        refreshToken: 'raw-token',
        tokenDigest: 'deadbeef',
      },
    });

    const after = captured.data?.after as Record<string, unknown>;
    expect(after.passwordChangedAt).toBe('2026-06-15T00:00:00Z');
    expect(after.password).toBe('[REDACTED]');
    expect(after.passwordHash).toBe('[REDACTED]');
    expect(after.refreshToken).toBe('[REDACTED]');
    expect(after.tokenDigest).toBe('[REDACTED]');
    const serialized = JSON.stringify(after);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('raw-token');
  });

  it('records actor snapshot and action', async () => {
    const { tx, captured } = captureTx();
    await writer.write(tx, {
      action: 'SESSION_REVOKED',
      actor: { id: 7n, email: 'x@y.z', name: 'X', rolesSnapshot: ['SALES'] },
    });
    expect(captured.data?.action).toBe('SESSION_REVOKED');
    expect(captured.data?.actorEmail).toBe('x@y.z');
    expect(captured.data?.actorName).toBe('X');
  });
});
