import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, dbConfigured, makeOrder, makeUser } from './helpers';

describe.skipIf(!dbConfigured)('append-only immutability', () => {
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

  it('blocks UPDATE on audit_logs', async () => {
    const row = await prisma.auditLog.create({
      data: { action: 'order.approved', entityType: 'ORDER' },
    });
    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append.only/i);
  });

  it('blocks DELETE on audit_logs', async () => {
    const row = await prisma.auditLog.create({ data: { action: 'order.approved' } });
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append.only/i);
  });

  it('blocks UPDATE and DELETE on order_status_history', async () => {
    const { order, user } = await makeOrder(prisma);
    const row = await prisma.orderStatusHistory.create({
      data: { orderId: order.id, toStatus: 'APPROVED', changedById: user.id },
    });
    await expect(
      prisma.orderStatusHistory.update({ where: { id: row.id }, data: { toStatus: 'CANCELLED' } }),
    ).rejects.toThrow(/append.only/i);
    await expect(prisma.orderStatusHistory.delete({ where: { id: row.id } })).rejects.toThrow(
      /append.only/i,
    );
  });

  it('blocks UPDATE/DELETE on payments (append-only)', async () => {
    const { order, customer, user } = await makeOrder(prisma);
    const company = await prisma.company.create({ data: { name: `Co_${Date.now()}` } });
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id,
        customerId: customer.id,
        orderId: order.id,
        createdById: user.id,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amount: 100n,
        method: 'CASH',
        paidAt: new Date(),
        createdById: user.id,
      },
    });
    await expect(
      prisma.payment.update({ where: { id: payment.id }, data: { amount: 1n } }),
    ).rejects.toThrow(/append.only/i);
    await expect(prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow(
      /append.only/i,
    );
  });

  it('still allows INSERT on append-only tables', async () => {
    const user = await makeUser(prisma);
    const row = await prisma.auditLog.create({
      data: { actorId: user.id, action: 'role.assigned', entityType: 'USER', entityId: user.id },
    });
    expect(row.id).toBeDefined();
  });
});
