import { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabase } from '../../src/testing';

/**
 * Whether a real, isolated test database is configured. When false, the DB
 * integration suites self-skip (`describe.skipIf`) so they never report a false
 * green — the database gate is only truly green when these run against Postgres.
 */
export const dbConfigured: boolean = (() => {
  try {
    assertSafeTestDatabase();
    return true;
  } catch {
    return false;
  }
})();

let counter = 0;
/** Process-unique suffix for business keys so factories never collide. */
export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}_${counter}`;
}

export function createPrisma(): PrismaClient {
  return new PrismaClient();
}

export async function makeUser(
  prisma: PrismaClient,
  over: Partial<{ email: string; fullName: string }> = {},
) {
  const s = uniqueSuffix();
  return prisma.user.create({
    data: {
      email: over.email ?? `user_${s}@test.local`,
      passwordHash: 'x',
      fullName: over.fullName ?? `User ${s}`,
      status: 'ACTIVE',
    },
  });
}

export async function makeWarehouse(prisma: PrismaClient, over: Partial<{ code: string }> = {}) {
  const s = uniqueSuffix();
  return prisma.warehouse.create({
    data: { code: over.code ?? `WH_${s}`, name: `Warehouse ${s}`, country: 'TR' },
  });
}

export async function makeProduct(prisma: PrismaClient, over: Partial<{ sku: string }> = {}) {
  const s = uniqueSuffix();
  return prisma.product.create({
    data: { sku: over.sku ?? `SKU_${s}`, name: `Product ${s}` },
  });
}

export async function makeCustomer(prisma: PrismaClient) {
  const s = uniqueSuffix();
  return prisma.customer.create({ data: { code: `CUST_${s}`, name: `Customer ${s}` } });
}

export async function makeCompany(prisma: PrismaClient) {
  const s = uniqueSuffix();
  return prisma.company.create({ data: { name: `Company ${s}` } });
}

export async function makeOrder(prisma: PrismaClient) {
  const [customer, warehouse, user] = await Promise.all([
    makeCustomer(prisma),
    makeWarehouse(prisma),
    makeUser(prisma),
  ]);
  const s = uniqueSuffix();
  const order = await prisma.order.create({
    data: {
      orderNo: `ORD_${s}`,
      customerId: customer.id,
      warehouseId: warehouse.id,
      createdById: user.id,
    },
  });
  return { order, customer, warehouse, user };
}

export async function makeInvoiceSeries(prisma: PrismaClient, fiscalYear = 2026) {
  const company = await makeCompany(prisma);
  const series = await prisma.invoiceSeries.create({
    data: { companyId: company.id, seriesCode: 'INV', fiscalYear, prefix: `INV-${fiscalYear}-` },
  });
  return { company, series };
}
