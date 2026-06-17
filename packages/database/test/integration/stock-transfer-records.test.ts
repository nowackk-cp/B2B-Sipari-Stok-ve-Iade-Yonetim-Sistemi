import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import {
  createPrisma,
  makeCompany,
  makeProduct,
  makeUser,
  makeWarehouse,
  uniqueSuffix,
} from './helpers';

/**
 * Stock Transfer Foundation — DB-level invariants for `stock_transfer_records`:
 * append-only immutability, the `(company_id, idempotency_key)` unique, the
 * source≠destination and quantity>0 CHECKs, and the composite FKs that pin
 * product + both warehouses to the SAME company (a cross-tenant transfer is
 * physically un-insertable).
 */
describe('stock_transfer_records constraints (real PostgreSQL)', () => {
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

  /** A complete, same-company set: company + product + two warehouses + user. */
  async function tenantSet() {
    const company = await makeCompany(prisma);
    const [product, from, to, user] = await Promise.all([
      makeProduct(prisma, { companyId: company.id }),
      makeWarehouse(prisma, { companyId: company.id }),
      makeWarehouse(prisma, { companyId: company.id }),
      makeUser(prisma, { companyId: company.id }),
    ]);
    return { company, product, from, to, user };
  }

  async function makeRecord(over: Partial<{ idempotencyKey: string }> = {}) {
    const { company, product, from, to, user } = await tenantSet();
    const rec = await prisma.stockTransferRecord.create({
      data: {
        companyId: company.id,
        productId: product.id,
        fromWarehouseId: from.id,
        toWarehouseId: to.id,
        quantity: 5n,
        reason: 'seed',
        idempotencyKey: over.idempotencyKey ?? `T_${uniqueSuffix()}`,
        createdById: user.id,
      },
    });
    return { rec, company, product, from, to, user };
  }

  it('blocks UPDATE on a transfer record (append-only)', async () => {
    const { rec } = await makeRecord();
    await expect(
      prisma.stockTransferRecord.update({ where: { id: rec.id }, data: { quantity: 99n } }),
    ).rejects.toThrow(/append.only/i);
  });

  it('blocks DELETE on a transfer record (append-only)', async () => {
    const { rec } = await makeRecord();
    await expect(prisma.stockTransferRecord.delete({ where: { id: rec.id } })).rejects.toThrow(
      /append.only/i,
    );
  });

  it('still allows INSERT (append-only is insert-only)', async () => {
    const { rec } = await makeRecord();
    expect(rec.id).toBeDefined();
    expect(rec.publicId).toMatch(/[0-9a-f-]{36}/);
  });

  it('rejects source == destination (CHECK)', async () => {
    const { company, product, from, user } = await tenantSet();
    await expect(
      prisma.stockTransferRecord.create({
        data: {
          companyId: company.id,
          productId: product.id,
          fromWarehouseId: from.id,
          toWarehouseId: from.id,
          quantity: 5n,
          idempotencyKey: `T_${uniqueSuffix()}`,
          createdById: user.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects non-positive quantity (CHECK)', async () => {
    const { company, product, from, to, user } = await tenantSet();
    await expect(
      prisma.stockTransferRecord.create({
        data: {
          companyId: company.id,
          productId: product.id,
          fromWarehouseId: from.id,
          toWarehouseId: to.id,
          quantity: 0n,
          idempotencyKey: `T_${uniqueSuffix()}`,
          createdById: user.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate (company_id, idempotency_key)', async () => {
    const key = `T_${uniqueSuffix()}`;
    const { company, product, from, to, user } = await tenantSet();
    await prisma.stockTransferRecord.create({
      data: {
        companyId: company.id,
        productId: product.id,
        fromWarehouseId: from.id,
        toWarehouseId: to.id,
        quantity: 5n,
        idempotencyKey: key,
        createdById: user.id,
      },
    });
    // A second warehouse pair in the SAME company, same key → rejected.
    const to2 = await makeWarehouse(prisma, { companyId: company.id });
    await expect(
      prisma.stockTransferRecord.create({
        data: {
          companyId: company.id,
          productId: product.id,
          fromWarehouseId: from.id,
          toWarehouseId: to2.id,
          quantity: 7n,
          idempotencyKey: key,
          createdById: user.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('allows the same idempotency key in a DIFFERENT company (tenant-scoped unique)', async () => {
    const key = `T_${uniqueSuffix()}`;
    await makeRecord({ idempotencyKey: key });
    // A fresh company reusing the same client key is fine.
    const { rec } = await makeRecord({ idempotencyKey: key });
    expect(rec.id).toBeDefined();
  });

  it('rejects a cross-company transfer via the composite FKs (product/warehouse in another tenant)', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const product = await makeProduct(prisma, { companyId: a.id });
    const from = await makeWarehouse(prisma, { companyId: a.id });
    const toOtherCompany = await makeWarehouse(prisma, { companyId: b.id });
    const user = await makeUser(prisma, { companyId: a.id });
    // company_id = A but the destination warehouse belongs to B → the
    // (to_warehouse_id, company_id) composite FK has no matching row → rejected.
    await expect(
      prisma.stockTransferRecord.create({
        data: {
          companyId: a.id,
          productId: product.id,
          fromWarehouseId: from.id,
          toWarehouseId: toOtherCompany.id,
          quantity: 5n,
          idempotencyKey: `T_${uniqueSuffix()}`,
          createdById: user.id,
        },
      }),
    ).rejects.toThrow();
  });
});
