import { describe, expect, it } from 'vitest';
import type { Prisma } from '@b2b/database';
import { OutboxEmailAdapter } from '../../src/modules/auth/adapters/outbox-email.adapter';
import type { PasswordResetRequestedEvent } from '../../src/modules/auth/ports/email-outbox.port';

/** Capture the row the adapter would insert, without a real database. */
function fakeTx(sink: { data?: Prisma.OutboxEventCreateInput }): Prisma.TransactionClient {
  return {
    outboxEvent: {
      create: async (args: { data: Prisma.OutboxEventCreateInput }) => {
        sink.data = args.data;
        return args.data as never;
      },
    },
  } as unknown as Prisma.TransactionClient;
}

describe('OutboxEmailAdapter payload (AUTH-BLOCK-001)', () => {
  const RAW_TOKEN = 'should-never-appear-Eh-Vh1l3aQp4r6Wc9Zt2sFnK8bX0mYg';
  const event: PasswordResetRequestedEvent = {
    passwordResetTokenId: 42n,
    userId: 7n,
    userPublicId: '11111111-2222-3333-4444-555555555555',
    email: 'user@test.local',
    expiresAt: new Date('2026-06-15T12:30:00.000Z'),
    dedupKey: 'a'.repeat(64),
  };

  it('writes only safe references and never a raw bearer token', async () => {
    const sink: { data?: Prisma.OutboxEventCreateInput } = {};
    await new OutboxEmailAdapter().enqueuePasswordReset(fakeTx(sink), event);

    expect(sink.data).toBeDefined();
    const payload = sink.data!.payload as Record<string, unknown>;

    // Safe references present.
    expect(payload.passwordResetTokenId).toBe('42');
    expect(payload.userId).toBe(event.userPublicId);
    expect(payload.to).toBe(event.email);
    expect(payload.type).toBe('password-reset');
    expect(payload.expiresAt).toBe(event.expiresAt.toISOString());

    // No raw token under any key, and the serialized payload cannot leak one.
    expect(payload).not.toHaveProperty('resetToken');
    expect(JSON.stringify(payload)).not.toContain(RAW_TOKEN);
    // The dedup key is the digest, used only to make the outbox row idempotent.
    expect(sink.data!.deduplicationKey).toBe(`password-reset:${event.dedupKey}`);
  });
});
