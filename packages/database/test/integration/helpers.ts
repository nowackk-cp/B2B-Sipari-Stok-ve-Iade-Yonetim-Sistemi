import { PrismaClient } from '@prisma/client';

/**
 * Database integration test factories. These suites are run ONLY by the
 * fail-closed gate runner (scripts/db-test-gate.mjs), which guarantees a real,
 * reachable PostgreSQL test database before vitest is invoked. The suites
 * therefore do NOT self-skip — a missing database is the gate runner's failure
 * to surface, never a silent green here.
 */

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
  over: Partial<{ email: string; fullName: string; companyId: bigint }> = {},
) {
  const s = uniqueSuffix();
  // Users are company-scoped (company_id NOT NULL). Attach a fresh tenant unless
  // the caller pins one, so factory users never collide on company.
  const companyId = over.companyId ?? (await makeCompany(prisma)).id;
  return prisma.user.create({
    data: {
      companyId,
      email: over.email ?? `user_${s}@test.local`,
      passwordHash: 'x',
      fullName: over.fullName ?? `User ${s}`,
      status: 'ACTIVE',
    },
  });
}

export async function makeWarehouse(
  prisma: PrismaClient,
  over: Partial<{ code: string; companyId: bigint }> = {},
) {
  const s = uniqueSuffix();
  // Warehouses are company-scoped (company_id NOT NULL). Attach a fresh tenant
  // unless the caller pins one, so factory warehouses never collide on company.
  const companyId = over.companyId ?? (await makeCompany(prisma)).id;
  return prisma.warehouse.create({
    data: { companyId, code: over.code ?? `WH_${s}`, name: `Warehouse ${s}`, country: 'TR' },
  });
}

export async function makeProduct(
  prisma: PrismaClient,
  over: Partial<{ sku: string; companyId: bigint }> = {},
) {
  const s = uniqueSuffix();
  // Products are company-scoped (company_id NOT NULL, TASK-011). Attach a fresh
  // tenant unless the caller pins one, so factory products never collide on the
  // company-scoped SKU unique.
  const companyId = over.companyId ?? (await makeCompany(prisma)).id;
  return prisma.product.create({
    data: { companyId, sku: over.sku ?? `SKU_${s}`, name: `Product ${s}` },
  });
}

export async function makeCustomer(
  prisma: PrismaClient,
  over: Partial<{ code: string; companyId: bigint }> = {},
) {
  const s = uniqueSuffix();
  // Customers are company-scoped (company_id NOT NULL, Customer Management
  // Foundation). Attach a fresh tenant unless the caller pins one, so factory
  // customers never collide on the company-scoped code unique.
  const companyId = over.companyId ?? (await makeCompany(prisma)).id;
  return prisma.customer.create({
    data: { companyId, code: over.code ?? `CUST_${s}`, name: `Customer ${s}` },
  });
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

export async function makeFile(prisma: PrismaClient) {
  const user = await makeUser(prisma);
  const file = await prisma.file.create({
    data: {
      storageKey: `key/${uniqueSuffix()}`,
      bucket: 'imports',
      filename: 'in.xlsx',
      contentType: 'application/vnd.ms-excel',
      sizeBytes: 10n,
      uploadedById: user.id,
    },
  });
  return { file, user };
}

export async function makeOutboxEvent(prisma: PrismaClient) {
  return prisma.outboxEvent.create({
    data: {
      eventType: 'invoice.issued',
      aggregateType: 'INVOICE',
      aggregateId: 1n,
      deduplicationKey: `evt:${uniqueSuffix()}`,
      payload: {},
    },
  });
}

/** Effect receipt bound to a fresh outbox event (outbox_event_id is NOT NULL). */
export async function makeEffectReceipt(
  prisma: PrismaClient,
  over: Partial<{ effectType: string; effectKey: string; providerIdempotencyKey: string }> = {},
) {
  const outbox = await makeOutboxEvent(prisma);
  const s = uniqueSuffix();
  const receipt = await prisma.effectReceipt.create({
    data: {
      outboxEventId: outbox.id,
      effectType: over.effectType ?? 'EMAIL',
      effectKey: over.effectKey ?? `EMAIL:${s}`,
      providerIdempotencyKey: over.providerIdempotencyKey ?? `prov:${s}`,
    },
  });
  return { receipt, outbox };
}

/** Import job bound to a company + source file (both required). */
export async function makeImportJob(
  prisma: PrismaClient,
  over: Partial<{ fileChecksumSha256: string; status: string; companyId: bigint }> = {},
) {
  const company = over.companyId !== undefined ? { id: over.companyId } : await makeCompany(prisma);
  const { file, user } = await makeFile(prisma);
  const s = uniqueSuffix();
  const job = await prisma.importJob.create({
    data: {
      companyId: company.id,
      type: 'PRODUCT',
      sourceFileId: file.id,
      fileChecksumSha256: over.fileChecksumSha256 ?? `c_${s}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(over.status ? { status: over.status as any } : {}),
      createdById: user.id,
    },
  });
  return { job, company, file, user };
}
