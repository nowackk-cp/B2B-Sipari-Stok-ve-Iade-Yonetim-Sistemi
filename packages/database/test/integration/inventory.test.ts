import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, makeProduct, makeWarehouse } from './helpers';

describe('inventory constraints', () => {
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

  async function productWarehouse() {
    const [product, warehouse] = await Promise.all([makeProduct(prisma), makeWarehouse(prisma)]);
    return { product, warehouse };
  }

  it('rejects negative on_hand (CHECK)', async () => {
    const { product, warehouse } = await productWarehouse();
    await expect(
      prisma.stockBalance.create({
        data: { productId: product.id, warehouseId: warehouse.id, onHand: -1n, reserved: 0n },
      }),
    ).rejects.toThrow();
  });

  it('rejects negative reserved (CHECK)', async () => {
    const { product, warehouse } = await productWarehouse();
    await expect(
      prisma.stockBalance.create({
        data: { productId: product.id, warehouseId: warehouse.id, onHand: 5n, reserved: -1n },
      }),
    ).rejects.toThrow();
  });

  it('rejects reserved greater than on_hand (CHECK)', async () => {
    const { product, warehouse } = await productWarehouse();
    await expect(
      prisma.stockBalance.create({
        data: { productId: product.id, warehouseId: warehouse.id, onHand: 5n, reserved: 10n },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate balance for the same product/warehouse', async () => {
    const { product, warehouse } = await productWarehouse();
    await prisma.stockBalance.create({
      data: { productId: product.id, warehouseId: warehouse.id, onHand: 5n, reserved: 0n },
    });
    await expect(
      prisma.stockBalance.create({
        data: { productId: product.id, warehouseId: warehouse.id, onHand: 1n, reserved: 0n },
      }),
    ).rejects.toThrow();
  });

  async function makeLedger(idempotencyKey: string) {
    const { product, warehouse } = await productWarehouse();
    return prisma.stockLedger.create({
      data: {
        productId: product.id,
        warehouseId: warehouse.id,
        changeType: 'RECEIPT',
        quantity: 5n,
        balanceAfter: 5n,
        referenceType: 'ADJUSTMENT',
        idempotencyKey,
      },
    });
  }

  it('rejects a duplicate stock-ledger idempotency key', async () => {
    const key = `ADJUSTMENT:${Date.now()}`;
    await makeLedger(key);
    const { product, warehouse } = await productWarehouse();
    await expect(
      prisma.stockLedger.create({
        data: {
          productId: product.id,
          warehouseId: warehouse.id,
          changeType: 'RECEIPT',
          quantity: 1n,
          balanceAfter: 1n,
          referenceType: 'ADJUSTMENT',
          idempotencyKey: key,
        },
      }),
    ).rejects.toThrow();
  });

  it('blocks UPDATE on the append-only stock ledger', async () => {
    const row = await makeLedger(`ADJUSTMENT:${Date.now()}_u`);
    await expect(
      prisma.stockLedger.update({ where: { id: row.id }, data: { quantity: 99n } }),
    ).rejects.toThrow(/append.only/i);
  });

  it('blocks DELETE on the append-only stock ledger', async () => {
    const row = await makeLedger(`ADJUSTMENT:${Date.now()}_d`);
    await expect(prisma.stockLedger.delete({ where: { id: row.id } })).rejects.toThrow(
      /append.only/i,
    );
  });
});
