import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, makeOutboxEvent, uniqueSuffix } from './helpers';

/**
 * DBF-006 / ADR-008 (G-17): effect receipts are FK-bound to the outbox event
 * that spawned them (RESTRICT — never cascade), dedupe both the effect and the
 * provider call, and carry a crash-state invariant on completed_at.
 */
describe('effect receipt FK & state model', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('rejects a receipt referencing a non-existent outbox event', async () => {
    await expect(
      prisma.effectReceipt.create({
        data: {
          outboxEventId: 999_999n,
          effectType: 'EMAIL',
          effectKey: `EMAIL:${uniqueSuffix()}`,
          providerIdempotencyKey: `p_${uniqueSuffix()}`,
        },
      }),
    ).rejects.toThrow();
  });

  it('does not cascade-delete receipts when the outbox event is deleted', async () => {
    const outbox = await makeOutboxEvent(prisma);
    const receipt = await prisma.effectReceipt.create({
      data: {
        outboxEventId: outbox.id,
        effectType: 'EMAIL',
        effectKey: `EMAIL:${uniqueSuffix()}`,
        providerIdempotencyKey: `p_${uniqueSuffix()}`,
      },
    });
    await expect(prisma.outboxEvent.delete({ where: { id: outbox.id } })).rejects.toThrow();
    expect(await prisma.effectReceipt.findUnique({ where: { id: receipt.id } })).not.toBeNull();
  });

  it('rejects a duplicate (effect_type, effect_key)', async () => {
    const outbox = await makeOutboxEvent(prisma);
    const effectKey = `EMAIL:${uniqueSuffix()}`;
    await prisma.effectReceipt.create({
      data: {
        outboxEventId: outbox.id,
        effectType: 'EMAIL',
        effectKey,
        providerIdempotencyKey: `p_${uniqueSuffix()}`,
      },
    });
    await expect(
      prisma.effectReceipt.create({
        data: {
          outboxEventId: outbox.id,
          effectType: 'EMAIL',
          effectKey,
          providerIdempotencyKey: `p_${uniqueSuffix()}`,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate provider idempotency key within the provider scope', async () => {
    const outbox = await makeOutboxEvent(prisma);
    const provKey = `prov_${uniqueSuffix()}`;
    await prisma.effectReceipt.create({
      data: {
        outboxEventId: outbox.id,
        effectType: 'EMAIL',
        effectKey: `EMAIL:${uniqueSuffix()}`,
        providerIdempotencyKey: provKey,
      },
    });
    await expect(
      prisma.effectReceipt.create({
        data: {
          outboxEventId: outbox.id,
          effectType: 'EMAIL',
          effectKey: `EMAIL:${uniqueSuffix()}`,
          providerIdempotencyKey: provKey,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects SUCCEEDED with a NULL completed_at (CHECK)', async () => {
    const outbox = await makeOutboxEvent(prisma);
    await expect(
      prisma.effectReceipt.create({
        data: {
          outboxEventId: outbox.id,
          effectType: 'EMAIL',
          effectKey: `EMAIL:${uniqueSuffix()}`,
          providerIdempotencyKey: `p_${uniqueSuffix()}`,
          status: 'SUCCEEDED',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects PLANNED with a non-NULL completed_at (CHECK)', async () => {
    const outbox = await makeOutboxEvent(prisma);
    await expect(
      prisma.effectReceipt.create({
        data: {
          outboxEventId: outbox.id,
          effectType: 'EMAIL',
          effectKey: `EMAIL:${uniqueSuffix()}`,
          providerIdempotencyKey: `p_${uniqueSuffix()}`,
          status: 'PLANNED',
          completedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts the PLANNED → SUCCEEDED(+completed_at) transition', async () => {
    const outbox = await makeOutboxEvent(prisma);
    const receipt = await prisma.effectReceipt.create({
      data: {
        outboxEventId: outbox.id,
        effectType: 'EMAIL',
        effectKey: `EMAIL:${uniqueSuffix()}`,
        providerIdempotencyKey: `p_${uniqueSuffix()}`,
      },
    });
    const done = await prisma.effectReceipt.update({
      where: { id: receipt.id },
      data: { status: 'SUCCEEDED', completedAt: new Date(), providerMessageId: 'msg-1' },
    });
    expect(done.status).toBe('SUCCEEDED');
  });

  it('rejects an invalid status value (enum)', async () => {
    const outbox = await makeOutboxEvent(prisma);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO effect_receipts (outbox_event_id, effect_type, effect_key, provider_idempotency_key, status, attempts, created_at, updated_at)
         VALUES (${outbox.id}, 'EMAIL', 'k_${Date.now()}', 'p_${Date.now()}', 'BOGUS', 0, now(), now())`,
      ),
    ).rejects.toThrow();
  });
});
