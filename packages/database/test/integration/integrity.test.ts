import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import {
  createPrisma,
  makeCompany,
  makeCustomer,
  makeOrder,
  makeProduct,
  makeUser,
  makeWarehouse,
  uniqueSuffix,
} from './helpers';

/**
 * DBF-003: transaction aggregate parents must never be hard-deleted, and no
 * parent→child transaction edge may CASCADE. Status UPDATEs must still work.
 */
describe('transaction integrity — delete prevention & no cascade', () => {
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

  async function makeInvoiceWithChildren() {
    const customer = await makeCustomer(prisma);
    const company = await makeCompany(prisma);
    const user = await makeUser(prisma);
    const series = await prisma.invoiceSeries.create({
      data: { companyId: company.id, seriesCode: 'INV', fiscalYear: 2026, prefix: 'INV-2026-' },
    });
    const invoice = await prisma.invoice.create({
      data: {
        companyId: company.id,
        seriesId: series.id,
        fiscalYear: 2026,
        invoiceNumber: 1n,
        invoiceNo: 'INV-2026-1',
        status: 'ISSUED',
        issuedAt: new Date(),
        customerId: customer.id,
        createdById: user.id,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        invoiceId: invoice.id,
        description: 'Item',
        quantity: 1n,
        unitPriceAmount: 100n,
        taxRateBp: 2000,
        lineSubtotalAmount: 100n,
        lineTaxAmount: 20n,
        lineTotalAmount: 120n,
      },
    });
    await prisma.invoiceStatusHistory.create({
      data: { invoiceId: invoice.id, toStatus: 'ISSUED', changedById: user.id },
    });
    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amount: 120n,
        method: 'CASH',
        paidAt: new Date(),
        createdById: user.id,
      },
    });
    return { invoice, company, user, payment };
  }

  it('rejects deleting an order (and keeps its status history)', async () => {
    const { order, user } = await makeOrder(prisma);
    await prisma.orderStatusHistory.create({
      data: { orderId: order.id, toStatus: 'APPROVED', changedById: user.id },
    });
    await expect(prisma.order.delete({ where: { id: order.id } })).rejects.toThrow(
      /delete_forbidden/i,
    );
    expect(await prisma.order.findUnique({ where: { id: order.id } })).not.toBeNull();
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('rejects deleting a numbered/issued invoice with payment, items and history', async () => {
    const { invoice } = await makeInvoiceWithChildren();
    await expect(prisma.invoice.delete({ where: { id: invoice.id } })).rejects.toThrow(
      /delete_forbidden/i,
    );
    // Children preserved.
    expect(await prisma.invoiceItem.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { invoiceId: invoice.id } })).toBe(1);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it('rejects deleting a stock transfer (and keeps its items)', async () => {
    const [src, dest, product, user] = await Promise.all([
      makeWarehouse(prisma),
      makeWarehouse(prisma),
      makeProduct(prisma),
      makeUser(prisma),
    ]);
    const transfer = await prisma.stockTransfer.create({
      data: {
        transferNo: `TR_${uniqueSuffix()}`,
        sourceWarehouseId: src.id,
        destWarehouseId: dest.id,
        createdById: user.id,
      },
    });
    await prisma.stockTransferItem.create({
      data: { transferId: transfer.id, productId: product.id, quantity: 3n },
    });
    await expect(prisma.stockTransfer.delete({ where: { id: transfer.id } })).rejects.toThrow(
      /delete_forbidden/i,
    );
    expect(await prisma.stockTransferItem.count({ where: { transferId: transfer.id } })).toBe(1);
  });

  it('rejects deleting a return (and keeps its items)', async () => {
    const { order, customer, user } = await makeOrder(prisma);
    const product = await makeProduct(prisma);
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        productSku: 'SKU',
        productName: 'P',
        quantity: 1n,
        listPriceAmount: 100n,
        unitPriceAmount: 100n,
        taxRateBp: 2000,
        lineSubtotalAmount: 100n,
        lineTaxAmount: 20n,
        lineTotalAmount: 120n,
      },
    });
    const ret = await prisma.return.create({
      data: {
        returnNo: `RET_${uniqueSuffix()}`,
        orderId: order.id,
        customerId: customer.id,
        createdById: user.id,
      },
    });
    await prisma.returnItem.create({
      data: {
        returnId: ret.id,
        orderItemId: orderItem.id,
        productId: product.id,
        quantity: 1n,
        condition: 'RESELLABLE',
      },
    });
    await expect(prisma.return.delete({ where: { id: ret.id } })).rejects.toThrow(
      /delete_forbidden/i,
    );
    expect(await prisma.returnItem.count({ where: { returnId: ret.id } })).toBe(1);
  });

  it('rejects deleting a payment (append-only)', async () => {
    const { payment } = await makeInvoiceWithChildren();
    await expect(prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow(
      /append.only/i,
    );
  });

  it('rejects hard-deleting a user that owns transaction history (no cascade)', async () => {
    const { order, user } = await makeOrder(prisma);
    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow(
      /delete_forbidden/i,
    );
    // The order the user created is untouched.
    expect(await prisma.order.findUnique({ where: { id: order.id } })).not.toBeNull();
  });

  it('does not cascade-delete a company transaction graph (FK restrict)', async () => {
    const { invoice, company } = await makeInvoiceWithChildren();
    await expect(prisma.company.delete({ where: { id: company.id } })).rejects.toThrow();
    expect(await prisma.invoice.findUnique({ where: { id: invoice.id } })).not.toBeNull();
  });

  it('still allows a valid status UPDATE on a transaction parent', async () => {
    const { order } = await makeOrder(prisma);
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    expect(updated.status).toBe('APPROVED');
  });
});
