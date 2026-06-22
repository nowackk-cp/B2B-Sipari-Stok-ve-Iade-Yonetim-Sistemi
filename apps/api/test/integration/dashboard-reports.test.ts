import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCompanyRbac } from '@b2b/database';
import { WAREHOUSE_SCOPE_ALL } from '@b2b/domain';
import { AppConfigService } from '../../src/common/config/app-config.service';
import {
  type TestApp,
  assignWarehouseScope,
  closeTestApp,
  createCompany,
  createCustomer,
  createTestApp,
  createUser,
  createWarehouse,
  grantPermissionsViaRole,
  resetState,
  seedRbac,
} from './helpers';

const BASE = '/api/v1';
const AUTH = `${BASE}/auth`;
const DASHBOARD = `${BASE}/dashboard/summary`;
const SALES = `${BASE}/reports/sales`;
const INVENTORY = `${BASE}/reports/inventory`;
const RETURNS = `${BASE}/reports/returns`;

const DASH_PERMS = ['dashboard:read'];
const REPORT_PERMS = ['report:read'];
const ALL_PERMS = ['dashboard:read', 'report:read'];

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Forge a validly-signed token carrying extra (fake) claims — proves the API
 * ignores JWT-supplied tenant/warehouse claims and trusts only PostgreSQL. */
function forgeTokenFrom(ctx: TestApp, realToken: string, extra: Record<string, unknown>): string {
  const config = ctx.app.get(AppConfigService);
  const payload = JSON.parse(
    Buffer.from(realToken.split('.')[1] as string, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${enc(header)}.${enc({ ...payload, ...extra })}`;
  const sig = createHmac('sha256', config.jwtAccessSecret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

async function makeTenant(ctx: TestApp, name?: string): Promise<bigint> {
  const company = await createCompany(ctx.prisma, name);
  await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, company));
  return company;
}

interface Actor {
  token: string;
  userId: bigint;
}

async function makeActor(
  ctx: TestApp,
  companyId: bigint,
  perms: string[],
  opts: { global?: boolean } = {},
): Promise<Actor> {
  const user = await createUser(ctx.prisma, { companyId });
  const all = [...perms];
  if (opts.global) all.push(WAREHOUSE_SCOPE_ALL);
  await grantPermissionsViaRole(ctx.prisma, user.id, all);
  const token = await login(ctx, user.email, user.password);
  return { token, userId: user.id };
}

// --- direct row builders (deterministic fixtures for the aggregate reads) -----

let seq = 0;
function uniq(): string {
  seq += 1;
  return `${Date.now().toString(36)}_${seq}`;
}

async function product(
  ctx: TestApp,
  companyId: bigint,
  over: Partial<{
    isActive: boolean;
    deletedAt: Date | null;
    criticalStockThreshold: bigint | null;
    sku: string;
    name: string;
  }> = {},
): Promise<{ id: bigint; publicId: string }> {
  return ctx.prisma.product.create({
    data: {
      companyId,
      sku: over.sku ?? `SKU_${uniq()}`,
      name: over.name ?? `Product ${uniq()}`,
      isActive: over.isActive ?? true,
      deletedAt: over.deletedAt ?? null,
      criticalStockThreshold: over.criticalStockThreshold ?? null,
    },
    select: { id: true, publicId: true },
  });
}

async function balance(
  ctx: TestApp,
  productId: bigint,
  warehouseId: bigint,
  onHand: bigint,
  reserved = 0n,
): Promise<void> {
  await ctx.prisma.stockBalance.create({ data: { productId, warehouseId, onHand, reserved } });
}

async function order(
  ctx: TestApp,
  companyId: bigint,
  customerId: bigint,
  warehouseId: bigint,
  status: 'DRAFT' | 'APPROVED' | 'SHIPPED',
  createdById: bigint,
): Promise<{ id: bigint }> {
  return ctx.prisma.order.create({
    data: {
      orderNo: `ORD-${uniq()}`,
      companyId,
      customerId,
      warehouseId,
      status,
      currency: 'TRY',
      createdById,
    },
    select: { id: true },
  });
}

async function orderItem(
  ctx: TestApp,
  companyId: bigint,
  orderId: bigint,
  productId: bigint,
  quantity: bigint,
): Promise<{ id: bigint }> {
  return ctx.prisma.orderItem.create({
    data: {
      orderId,
      companyId,
      productId,
      productSku: `S_${uniq()}`,
      productName: `N_${uniq()}`,
      quantity,
      listPriceAmount: 1000n,
      unitPriceAmount: 1000n,
      taxRateBp: 2000,
      lineSubtotalAmount: 1000n * quantity,
      lineTaxAmount: 200n * quantity,
      lineTotalAmount: 1200n * quantity,
    },
    select: { id: true },
  });
}

async function invoice(
  ctx: TestApp,
  companyId: bigint,
  customerId: bigint,
  warehouseId: bigint | null,
  createdById: bigint,
  over: Partial<{
    status: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
    issuedAt: Date | null;
    currency: string;
    subtotal: bigint;
    tax: bigint;
    grand: bigint;
  }> = {},
): Promise<{ id: bigint }> {
  return ctx.prisma.invoice.create({
    data: {
      companyId,
      customerId,
      warehouseId,
      createdById,
      status: over.status ?? 'ISSUED',
      currency: over.currency ?? 'TRY',
      subtotalAmount: over.subtotal ?? 10000n,
      taxAmount: over.tax ?? 2000n,
      grandTotalAmount: over.grand ?? 12000n,
      issuedAt: over.issuedAt === undefined ? new Date('2026-06-15T10:00:00.000Z') : over.issuedAt,
    },
    select: { id: true },
  });
}

async function series(ctx: TestApp, companyId: bigint): Promise<bigint> {
  const row = await ctx.prisma.invoiceSeries.create({
    data: {
      companyId,
      seriesCode: `CRN_${uniq()}`,
      fiscalYear: 2026,
      prefix: `CRN-2026-`,
      nextNumber: 1,
    },
    select: { id: true },
  });
  return row.id;
}

async function returnRow(
  ctx: TestApp,
  companyId: bigint,
  orderId: bigint,
  customerId: bigint,
  warehouseId: bigint,
  status: 'DRAFT' | 'APPROVED',
  createdById: bigint,
  createdAt = new Date('2026-06-15T10:00:00.000Z'),
): Promise<{ id: bigint }> {
  return ctx.prisma.return.create({
    data: {
      returnNo: `RET-${uniq()}`,
      companyId,
      orderId,
      customerId,
      warehouseId,
      status,
      idempotencyKey: `rk_${uniq()}`,
      createdById,
      createdAt,
    },
    select: { id: true },
  });
}

async function returnItem(
  ctx: TestApp,
  companyId: bigint,
  returnId: bigint,
  orderItemId: bigint,
  productId: bigint,
  quantity: bigint,
): Promise<void> {
  await ctx.prisma.returnItem.create({
    data: { returnId, companyId, orderItemId, productId, quantity, condition: 'RESELLABLE' },
  });
}

async function creditNote(
  ctx: TestApp,
  companyId: bigint,
  seriesId: bigint,
  returnId: bigint,
  orderId: bigint,
  originalInvoiceId: bigint,
  customerId: bigint,
  warehouseId: bigint,
  createdById: bigint,
  over: Partial<{ currency: string; grand: bigint }> = {},
): Promise<void> {
  await ctx.prisma.creditNote.create({
    data: {
      companyId,
      seriesId,
      creditNoteNumber: BigInt(`${seq + 1}`),
      creditNoteNo: `CRN-2026-${uniq()}`,
      fiscalYear: 2026,
      returnId,
      orderId,
      originalInvoiceId,
      customerId,
      warehouseId,
      status: 'ISSUED',
      currency: over.currency ?? 'TRY',
      subtotalAmount: 1000n,
      taxAmount: 200n,
      grandTotalAmount: over.grand ?? 1200n,
      idempotencyKey: `cnk_${uniq()}`,
      issuedAt: new Date('2026-06-15T11:00:00.000Z'),
      createdById,
    },
  });
}

function get(ctx: TestApp, token: string, url: string): request.Test {
  return request(ctx.http).get(url).set('Authorization', `Bearer ${token}`);
}

describe('Dashboard / Reports backend foundation (integration, real PostgreSQL)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
    await seedRbac(ctx.prisma);
  });

  // --- permission guards ----------------------------------------------------

  it('1. dashboard without dashboard:read → 403', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, REPORT_PERMS, { global: true });
    await get(ctx, actor.token, DASHBOARD).expect(403);
  });

  it('1b. unauthenticated dashboard → 401', async () => {
    await request(ctx.http).get(DASHBOARD).expect(401);
  });

  it('2. reports without report:read → 403', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, DASH_PERMS, { global: true });
    await get(ctx, actor.token, `${SALES}?dateFrom=2026-06-01&dateTo=2026-06-30`).expect(403);
    await get(ctx, actor.token, INVENTORY).expect(403);
    await get(ctx, actor.token, `${RETURNS}?dateFrom=2026-06-01&dateTo=2026-06-30`).expect(403);
  });

  // --- dashboard tenant + scope ---------------------------------------------

  it('3+4. dashboard counts only the actor company (no cross-company leak)', async () => {
    const a = await makeTenant(ctx, 'A');
    const actorA = await makeActor(ctx, a, ALL_PERMS, { global: true });
    const whA = await createWarehouse(ctx.prisma, a, { code: 'A1' });
    const custA = await createCustomer(ctx.prisma, a, { code: 'CA' });
    await product(ctx, a);
    await product(ctx, a);
    await order(ctx, a, custA.id, whA.id, 'DRAFT', actorA.userId);

    // Another tenant with its own data the actor must never count.
    const b = await makeTenant(ctx, 'B');
    const userB = await createUser(ctx.prisma, { companyId: b });
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B1' });
    const custB = await createCustomer(ctx.prisma, b, { code: 'CB' });
    await product(ctx, b);
    await order(ctx, b, custB.id, whB.id, 'DRAFT', userB.id);

    const res = await get(ctx, actorA.token, DASHBOARD).expect(200);
    expect(res.body.totalProducts).toBe(2);
    expect(res.body.totalCustomers).toBe(1);
    expect(res.body.draftOrders).toBe(1);
  });

  it('5. dashboard explicit scope counts only the scoped warehouse', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS);
    const wh1 = await createWarehouse(ctx.prisma, companyId, { code: 'W1' });
    const wh2 = await createWarehouse(ctx.prisma, companyId, { code: 'W2' });
    await assignWarehouseScope(ctx.prisma, actor.userId, wh1.id, companyId);
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    await order(ctx, companyId, cust.id, wh1.id, 'DRAFT', actor.userId);
    await order(ctx, companyId, cust.id, wh2.id, 'DRAFT', actor.userId);

    const res = await get(ctx, actor.token, DASHBOARD).expect(200);
    expect(res.body.draftOrders).toBe(1); // only the scoped warehouse's order
  });

  it('6. dashboard warehouse:scope:all returns the whole company', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh1 = await createWarehouse(ctx.prisma, companyId, { code: 'W1' });
    const wh2 = await createWarehouse(ctx.prisma, companyId, { code: 'W2' });
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    await order(ctx, companyId, cust.id, wh1.id, 'DRAFT', actor.userId);
    await order(ctx, companyId, cust.id, wh2.id, 'APPROVED', actor.userId);

    const res = await get(ctx, actor.token, DASHBOARD).expect(200);
    expect(res.body.draftOrders).toBe(1);
    expect(res.body.approvedOrders).toBe(1);
  });

  it('6b. dashboard sales + low stock + status counts (global)', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    // low-stock product (available 10 ≤ threshold 20) + a healthy one (no threshold).
    const low = await product(ctx, companyId, { criticalStockThreshold: 20n });
    const ok = await product(ctx, companyId);
    await balance(ctx, low.id, wh.id, 40n, 30n); // available 10
    await balance(ctx, ok.id, wh.id, 100n, 0n);
    await order(ctx, companyId, cust.id, wh.id, 'SHIPPED', actor.userId);
    await invoice(ctx, companyId, cust.id, wh.id, actor.userId, { grand: 12000n });

    const res = await get(ctx, actor.token, DASHBOARD).expect(200);
    expect(res.body.lowStockProducts).toBe(1);
    expect(res.body.shippedOrders).toBe(1);
    expect(res.body.issuedInvoices).toBe(1);
    expect(res.body.todaySalesAmount).toEqual([{ amount: '12000', currency: 'TRY' }]);
    expect(res.body.monthSalesAmount).toEqual([{ amount: '12000', currency: 'TRY' }]);
  });

  it('6c. dashboard low-stock ignores a balance whose warehouse belongs to another company (scope:all)', async () => {
    const a = await makeTenant(ctx, 'A');
    const actorA = await makeActor(ctx, a, ALL_PERMS, { global: true });
    const lowA = await product(ctx, a, { criticalStockThreshold: 20n });

    // Cross-company pairing: A's product + B's warehouse in a single stock_balances
    // row. Without a `warehouses.company_id` pin this low balance would leak into A's
    // low-stock count even though the warehouse is another tenant's.
    const b = await makeTenant(ctx, 'B');
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-WH' });
    await balance(ctx, lowA.id, whB.id, 5n, 0n); // available 5 ≤ 20, but B's warehouse

    const res = await get(ctx, actorA.token, DASHBOARD).expect(200);
    // warehouse:scope:all is company-local — B's warehouse must never be counted.
    expect(res.body.lowStockProducts).toBe(0);
  });

  it('15. a no-warehouse-scope actor sees zero warehouse-bound figures (company master still counts)', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS); // no scope, not global
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    await product(ctx, companyId);
    await order(ctx, companyId, cust.id, wh.id, 'DRAFT', actor.userId);

    const res = await get(ctx, actor.token, DASHBOARD).expect(200);
    expect(res.body.totalProducts).toBe(1); // company master data is visible
    expect(res.body.draftOrders).toBe(0); // warehouse-bound → zero without scope
  });

  it('16. a forged company/warehouse JWT claim does not change the result', async () => {
    const a = await makeTenant(ctx, 'A');
    const actorA = await makeActor(ctx, a, ALL_PERMS, { global: true });
    const whA = await createWarehouse(ctx.prisma, a, { code: 'A1' });
    const custA = await createCustomer(ctx.prisma, a, { code: 'CA' });
    await order(ctx, a, custA.id, whA.id, 'DRAFT', actorA.userId);

    const b = await makeTenant(ctx, 'B');
    const userB = await createUser(ctx.prisma, { companyId: b });
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B1' });
    const custB = await createCustomer(ctx.prisma, b, { code: 'CB' });
    await order(ctx, b, custB.id, whB.id, 'DRAFT', userB.id);
    await order(ctx, b, custB.id, whB.id, 'DRAFT', userB.id);

    // Actor A forges B's company id; the API must still only count A's data.
    const forged = forgeTokenFrom(ctx, actorA.token, {
      companyId: b.toString(),
      warehouseId: whB.id.toString(),
    });
    const res = await get(ctx, forged, DASHBOARD).expect(200);
    expect(res.body.draftOrders).toBe(1); // A's single draft, not B's two
  });

  // --- sales report ---------------------------------------------------------

  it('7. sales report returns correct invoice totals for a date range', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    // Two invoices on the same day (in range) + one outside the range.
    await invoice(ctx, companyId, cust.id, wh.id, actor.userId, {
      issuedAt: new Date('2026-06-10T08:00:00.000Z'),
      subtotal: 10000n,
      tax: 2000n,
      grand: 12000n,
    });
    await invoice(ctx, companyId, cust.id, wh.id, actor.userId, {
      issuedAt: new Date('2026-06-10T20:00:00.000Z'),
      subtotal: 5000n,
      tax: 1000n,
      grand: 6000n,
    });
    await invoice(ctx, companyId, cust.id, wh.id, actor.userId, {
      issuedAt: new Date('2026-07-01T08:00:00.000Z'),
      grand: 99999n,
    });

    const res = await get(
      ctx,
      actor.token,
      `${SALES}?dateFrom=2026-06-01&dateTo=2026-06-30&groupBy=day`,
    ).expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      period: '2026-06-10',
      invoiceCount: 2,
      subtotalAmount: '15000',
      vatAmount: '3000',
      totalAmount: '18000',
      currency: 'TRY',
    });
  });

  it('7b. sales report groupBy=month buckets by month', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    await invoice(ctx, companyId, cust.id, wh.id, actor.userId, {
      issuedAt: new Date('2026-06-05T08:00:00.000Z'),
      grand: 12000n,
    });
    await invoice(ctx, companyId, cust.id, wh.id, actor.userId, {
      issuedAt: new Date('2026-06-25T08:00:00.000Z'),
      grand: 6000n,
    });

    const res = await get(
      ctx,
      actor.token,
      `${SALES}?dateFrom=2026-06-01&dateTo=2026-06-30&groupBy=month`,
    ).expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].period).toBe('2026-06');
    expect(res.body.rows[0].invoiceCount).toBe(2);
    expect(res.body.rows[0].totalAmount).toBe('18000');
  });

  it('8. sales report with an invalid date → 400', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const res = await get(
      ctx,
      actor.token,
      `${SALES}?dateFrom=not-a-date&dateTo=2026-06-30`,
    ).expect(400);
    expect(res.body.requestId).toBeTruthy();
    // dateFrom after dateTo is also a 400.
    await get(ctx, actor.token, `${SALES}?dateFrom=2026-06-30&dateTo=2026-06-01`).expect(400);
  });

  it('9. sales report obeys the warehouse scope filter', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS);
    const wh1 = await createWarehouse(ctx.prisma, companyId, { code: 'W1' });
    const wh2 = await createWarehouse(ctx.prisma, companyId, { code: 'W2' });
    await assignWarehouseScope(ctx.prisma, actor.userId, wh1.id, companyId);
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    await invoice(ctx, companyId, cust.id, wh1.id, actor.userId, { grand: 12000n });
    await invoice(ctx, companyId, cust.id, wh2.id, actor.userId, { grand: 99999n });

    const res = await get(
      ctx,
      actor.token,
      `${SALES}?dateFrom=2026-06-01&dateTo=2026-06-30`,
    ).expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].totalAmount).toBe('12000'); // only the scoped warehouse
  });

  it('15b. cross-company sales report is empty (no leak)', async () => {
    const a = await makeTenant(ctx, 'A');
    const actorA = await makeActor(ctx, a, ALL_PERMS, { global: true });
    const b = await makeTenant(ctx, 'B');
    const userB = await createUser(ctx.prisma, { companyId: b });
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B1' });
    const custB = await createCustomer(ctx.prisma, b, { code: 'CB' });
    await invoice(ctx, b, custB.id, whB.id, userB.id, { grand: 99999n });

    const res = await get(
      ctx,
      actorA.token,
      `${SALES}?dateFrom=2026-06-01&dateTo=2026-06-30`,
    ).expect(200);
    expect(res.body.rows).toHaveLength(0);
  });

  // --- inventory report -----------------------------------------------------

  it('10. inventory report computes available = onHand − reserved', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const p = await product(ctx, companyId, { sku: 'SKU-A', name: 'Alpha' });
    await balance(ctx, p.id, wh.id, 100n, 30n);

    const res = await get(ctx, actor.token, INVENTORY).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      sku: 'SKU-A',
      onHand: '100',
      reserved: '30',
      available: '70',
      isLowStock: false,
    });
  });

  it('11. inventory report lowStockOnly keeps only low-stock balances', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const low = await product(ctx, companyId, { criticalStockThreshold: 20n, sku: 'LOW' });
    const ok = await product(ctx, companyId, { criticalStockThreshold: 5n, sku: 'OK' });
    await balance(ctx, low.id, wh.id, 30n, 20n); // available 10 ≤ 20 → low
    await balance(ctx, ok.id, wh.id, 50n, 0n); // available 50 > 5 → not low

    const all = await get(ctx, actor.token, INVENTORY).expect(200);
    expect(all.body.data).toHaveLength(2);
    const only = await get(ctx, actor.token, `${INVENTORY}?lowStockOnly=true`).expect(200);
    expect(only.body.data).toHaveLength(1);
    expect(only.body.data[0].sku).toBe('LOW');
    expect(only.body.data[0].isLowStock).toBe(true);
  });

  it('12. inventory report excludes soft-deleted products and warehouses', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const whDel = await createWarehouse(ctx.prisma, companyId, {
      code: 'WD',
      deletedAt: new Date(),
    });
    const live = await product(ctx, companyId, { sku: 'LIVE' });
    const dead = await product(ctx, companyId, { sku: 'DEAD', deletedAt: new Date() });
    await balance(ctx, live.id, wh.id, 10n, 0n); // visible
    await balance(ctx, dead.id, wh.id, 10n, 0n); // hidden (product soft-deleted)
    await balance(ctx, live.id, whDel.id, 10n, 0n); // hidden (warehouse soft-deleted)

    const res = await get(ctx, actor.token, INVENTORY).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sku).toBe('LIVE');
  });

  it('12c. inventory report does not leak a balance whose warehouse belongs to another company (scope:all)', async () => {
    const a = await makeTenant(ctx, 'A');
    const actorA = await makeActor(ctx, a, ALL_PERMS, { global: true });
    const whA = await createWarehouse(ctx.prisma, a, { code: 'A-WH' });
    const pA = await product(ctx, a, { sku: 'A-OWN' });
    await balance(ctx, pA.id, whA.id, 5n, 0n); // legitimate A row

    // Cross-company pairing: A's product + B's warehouse in one stock_balances row.
    // Tenant is pinned through the product, but the warehouse is another company's;
    // without `warehouses.company_id` this row (and B's public id + quantities) leaks.
    const b = await makeTenant(ctx, 'B');
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-WH' });
    await balance(ctx, pA.id, whB.id, 999n, 0n); // must never surface for A

    const res = await get(ctx, actorA.token, INVENTORY).expect(200);
    // scope:all is company-local: only A's own warehouse row is visible.
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sku).toBe('A-OWN');
    expect(res.body.data.some((r: { onHand: string }) => r.onHand === '999')).toBe(false);
  });

  it('12b. inventory report search matches name or SKU', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const widget = await product(ctx, companyId, { sku: 'AAA', name: 'Widget' });
    const gadget = await product(ctx, companyId, { sku: 'BBB', name: 'Gadget' });
    await balance(ctx, widget.id, wh.id, 1n, 0n);
    await balance(ctx, gadget.id, wh.id, 1n, 0n);

    const res = await get(ctx, actor.token, `${INVENTORY}?search=widg`).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Widget');
  });

  // --- returns report -------------------------------------------------------

  it('13. returns report computes requested/approved counts + quantity', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    const p = await product(ctx, companyId);
    const o = await order(ctx, companyId, cust.id, wh.id, 'SHIPPED', actor.userId);
    const oi = await orderItem(ctx, companyId, o.id, p.id, 5n);
    const r1 = await returnRow(ctx, companyId, o.id, cust.id, wh.id, 'DRAFT', actor.userId);
    await returnItem(ctx, companyId, r1.id, oi.id, p.id, 2n);
    const r2 = await returnRow(ctx, companyId, o.id, cust.id, wh.id, 'APPROVED', actor.userId);
    await returnItem(ctx, companyId, r2.id, oi.id, p.id, 3n);

    const res = await get(
      ctx,
      actor.token,
      `${RETURNS}?dateFrom=2026-06-01&dateTo=2026-06-30`,
    ).expect(200);
    expect(res.body.returnCount).toBe(2);
    expect(res.body.requestedCount).toBe(1);
    expect(res.body.approvedCount).toBe(1);
    expect(res.body.totalReturnedQuantity).toBe('5');
  });

  it('14. returns report computes credit-note totals by currency', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    const o = await order(ctx, companyId, cust.id, wh.id, 'SHIPPED', actor.userId);
    const inv = await invoice(ctx, companyId, cust.id, wh.id, actor.userId, { grand: 12000n });
    const r = await returnRow(ctx, companyId, o.id, cust.id, wh.id, 'APPROVED', actor.userId);
    const sid = await series(ctx, companyId);
    await creditNote(ctx, companyId, sid, r.id, o.id, inv.id, cust.id, wh.id, actor.userId, {
      grand: 1200n,
    });

    const res = await get(
      ctx,
      actor.token,
      `${RETURNS}?dateFrom=2026-06-01&dateTo=2026-06-30`,
    ).expect(200);
    expect(res.body.creditNoteCount).toBe(1);
    expect(res.body.creditNoteTotalAmount).toEqual([{ amount: '1200', currency: 'TRY' }]);
  });

  it('14b. returns report status filter narrows the counts', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const cust = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    const o = await order(ctx, companyId, cust.id, wh.id, 'SHIPPED', actor.userId);
    await returnRow(ctx, companyId, o.id, cust.id, wh.id, 'DRAFT', actor.userId);
    await returnRow(ctx, companyId, o.id, cust.id, wh.id, 'APPROVED', actor.userId);

    const res = await get(
      ctx,
      actor.token,
      `${RETURNS}?dateFrom=2026-06-01&dateTo=2026-06-30&status=APPROVED`,
    ).expect(200);
    expect(res.body.returnCount).toBe(1);
    expect(res.body.approvedCount).toBe(1);
    expect(res.body.requestedCount).toBe(0);
  });

  it('8b. returns report with an invalid date → 400', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    await get(ctx, actor.token, `${RETURNS}?dateFrom=2026-06-01&dateTo=bad`).expect(400);
  });
});
