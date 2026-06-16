import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, makeCompany, uniqueSuffix } from './helpers';

describe('soft delete & partial unique', () => {
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

  it('enforces unique SKU among live products only', async () => {
    const sku = `SKU_${uniqueSuffix()}`;
    const first = await prisma.product.create({ data: { sku, name: 'A' } });
    // A second live product with the same SKU is rejected.
    await expect(prisma.product.create({ data: { sku, name: 'B' } })).rejects.toThrow();

    // Soft-delete the first; the SKU becomes reusable for a new live product.
    await prisma.product.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const reused = await prisma.product.create({ data: { sku, name: 'C' } });
    expect(reused.id).not.toBe(first.id);

    // Two soft-deleted rows may share the SKU.
    await prisma.product.update({ where: { id: reused.id }, data: { deletedAt: new Date() } });
    const counts = await prisma.product.count({ where: { sku } });
    expect(counts).toBe(2);
  });

  it('allows the same warehouse code to be reused after soft delete', async () => {
    const code = `WH_${uniqueSuffix()}`;
    const company = await makeCompany(prisma);
    const wh = await prisma.warehouse.create({
      data: { companyId: company.id, code, name: 'W1', country: 'TR' },
    });
    await expect(
      prisma.warehouse.create({ data: { companyId: company.id, code, name: 'W2', country: 'TR' } }),
    ).rejects.toThrow();
    await prisma.warehouse.update({ where: { id: wh.id }, data: { deletedAt: new Date() } });
    const reused = await prisma.warehouse.create({
      data: { companyId: company.id, code, name: 'W3', country: 'TR' },
    });
    expect(reused.id).not.toBe(wh.id);
  });
});
