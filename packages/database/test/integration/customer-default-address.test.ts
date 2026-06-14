import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, makeCustomer } from './helpers';

/**
 * DBF-004: at most one active default address per (customer, type), enforced by
 * a partial unique index (WHERE is_default AND deleted_at IS NULL).
 */
describe('customer default address uniqueness', () => {
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

  const addr = (customerId: bigint, over: Record<string, unknown> = {}) => ({
    customerId,
    type: 'BILLING' as const,
    line1: 'Street 1',
    isDefault: true,
    ...over,
  });

  it('rejects two active defaults of the same type for one customer', async () => {
    const c = await makeCustomer(prisma);
    await prisma.customerAddress.create({ data: addr(c.id) });
    await expect(prisma.customerAddress.create({ data: addr(c.id) })).rejects.toThrow();
  });

  it('accepts a default BILLING and a default SHIPPING together', async () => {
    const c = await makeCustomer(prisma);
    await prisma.customerAddress.create({ data: addr(c.id, { type: 'BILLING' }) });
    const shipping = await prisma.customerAddress.create({
      data: addr(c.id, { type: 'SHIPPING' }),
    });
    expect(shipping.isDefault).toBe(true);
  });

  it('accepts multiple non-default addresses of the same type', async () => {
    const c = await makeCustomer(prisma);
    await prisma.customerAddress.create({ data: addr(c.id, { isDefault: false }) });
    const second = await prisma.customerAddress.create({ data: addr(c.id, { isDefault: false }) });
    expect(second.id).toBeDefined();
  });

  it('accepts a new default after the previous default is soft-deleted', async () => {
    const c = await makeCustomer(prisma);
    const first = await prisma.customerAddress.create({ data: addr(c.id) });
    await prisma.customerAddress.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });
    const replacement = await prisma.customerAddress.create({ data: addr(c.id) });
    expect(replacement.isDefault).toBe(true);
  });

  it('serialises two concurrent default inserts — exactly one wins', async () => {
    const c = await makeCustomer(prisma);
    const results = await Promise.allSettled([
      prisma.customerAddress.create({ data: addr(c.id) }),
      prisma.customerAddress.create({ data: addr(c.id) }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(
      await prisma.customerAddress.count({
        where: { customerId: c.id, type: 'BILLING', isDefault: true, deletedAt: null },
      }),
    ).toBe(1);
  });
});
