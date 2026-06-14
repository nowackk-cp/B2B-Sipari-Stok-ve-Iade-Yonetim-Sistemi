import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { withTransaction } from '../../src/transaction';
import { createPrisma, makeCustomer, makeInvoiceSeries, makeUser } from './helpers';

describe('billing — invoice series & numbering', () => {
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

  it('rejects a duplicate invoice series for the same company/code/year', async () => {
    const { company } = await makeInvoiceSeries(prisma, 2026);
    await expect(
      prisma.invoiceSeries.create({
        data: { companyId: company.id, seriesCode: 'INV', fiscalYear: 2026, prefix: 'INV-2026-' },
      }),
    ).rejects.toThrow();
  });

  it('enforces the composite invoice-number uniqueness but allows multiple drafts', async () => {
    const { company, series } = await makeInvoiceSeries(prisma, 2026);
    const customer = await makeCustomer(prisma);
    const user = await makeUser(prisma);
    const base = {
      companyId: company.id,
      seriesId: series.id,
      fiscalYear: 2026,
      customerId: customer.id,
      createdById: user.id,
    };
    await prisma.invoice.create({ data: { ...base, invoiceNumber: 1n, status: 'ISSUED' } });
    await expect(
      prisma.invoice.create({ data: { ...base, invoiceNumber: 1n, status: 'ISSUED' } }),
    ).rejects.toThrow();
    // DRAFT invoices (NULL number) do not collide under NULLS DISTINCT.
    await prisma.invoice.create({ data: { ...base } });
    await prisma.invoice.create({ data: { ...base } });
    expect(await prisma.invoice.count({ where: { invoiceNumber: null } })).toBe(2);
  });

  it('rolls back next_number when the issue transaction fails (gapless)', async () => {
    const { series } = await makeInvoiceSeries(prisma, 2026);
    await expect(
      withTransaction(
        async (tx) => {
          await tx.invoiceSeries.update({
            where: { id: series.id },
            data: { nextNumber: { increment: 1 } },
          });
          throw new Error('boom after increment');
        },
        {},
        prisma,
      ),
    ).rejects.toThrow('boom after increment');
    const after = await prisma.invoiceSeries.findUnique({ where: { id: series.id } });
    expect(after?.nextNumber).toBe(1n); // increment was rolled back
  });

  it('serialises concurrent number allocation via row lock (no duplicates, no loss)', async () => {
    const { company, series } = await makeInvoiceSeries(prisma, 2026);
    const customer = await makeCustomer(prisma);
    const user = await makeUser(prisma);

    async function allocate(): Promise<bigint> {
      return withTransaction(
        async (tx) => {
          const locked = await tx.$queryRaw<Array<{ next_number: bigint }>>`
            SELECT next_number FROM invoice_series WHERE id = ${series.id} FOR UPDATE
          `;
          const number = locked[0]!.next_number;
          await tx.invoice.create({
            data: {
              companyId: company.id,
              seriesId: series.id,
              fiscalYear: 2026,
              customerId: customer.id,
              createdById: user.id,
              invoiceNumber: number,
              status: 'ISSUED',
            },
          });
          await tx.invoiceSeries.update({
            where: { id: series.id },
            data: { nextNumber: { increment: 1 } },
          });
          return number;
        },
        {},
        prisma,
      );
    }

    const results = await Promise.all([allocate(), allocate(), allocate()]);
    const numbers = results.map((n) => Number(n)).sort();
    expect(new Set(numbers).size).toBe(3); // all distinct
    const after = await prisma.invoiceSeries.findUnique({ where: { id: series.id } });
    expect(after?.nextNumber).toBe(4n); // advanced by exactly 3
    expect(await prisma.invoice.count({ where: { seriesId: series.id } })).toBe(3);
  });
});
