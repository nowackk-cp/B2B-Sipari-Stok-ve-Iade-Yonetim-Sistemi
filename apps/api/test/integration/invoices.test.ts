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
const ORDERS = `${BASE}/orders`;
const INVOICES = `${BASE}/invoices`;

/** Every permission needed to drive draft→approve→ship→invoice + read invoices. */
const ALL_PERMS = [
  'order:read',
  'order:create',
  'order:cancel',
  'order:approve',
  'order:ship',
  'invoice:read',
  'invoice:create',
];

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

/** A fresh tenant with its own seeded RBAC (no pre-seeded MAIN warehouse/series). */
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

let prodSeq = 0;
async function createPricedProduct(
  ctx: TestApp,
  companyId: bigint,
  over: Partial<{ sku: string; listPriceAmount: bigint; taxRateBp: number }> = {},
): Promise<{ id: bigint; publicId: string }> {
  prodSeq += 1;
  return ctx.prisma.product.create({
    data: {
      companyId,
      sku: over.sku ?? `IP_${Date.now().toString(36)}_${prodSeq}`,
      name: `Invoice Product ${prodSeq}`,
      listPriceAmount: over.listPriceAmount ?? 10000n,
      currency: 'TRY',
      taxRateBp: over.taxRateBp ?? 2000,
      isActive: true,
    },
    select: { id: true, publicId: true },
  });
}

async function warehousePublicId(ctx: TestApp, id: bigint): Promise<string> {
  const wh = await ctx.prisma.warehouse.findUniqueOrThrow({
    where: { id },
    select: { publicId: true },
  });
  return wh.publicId;
}

async function seedBalance(
  ctx: TestApp,
  productId: bigint,
  warehouseId: bigint,
  onHand: bigint,
): Promise<void> {
  await ctx.prisma.stockBalance.create({ data: { productId, warehouseId, onHand } });
}

function createOrder(ctx: TestApp, token: string, body: Record<string, unknown>): request.Test {
  return request(ctx.http).post(ORDERS).set('Authorization', `Bearer ${token}`).send(body);
}

function action(ctx: TestApp, token: string, path: string, key?: string): request.Test {
  let req = request(ctx.http).post(path).set('Authorization', `Bearer ${token}`);
  if (key) req = req.set('Idempotency-Key', key);
  return req.send({});
}

function invoice(ctx: TestApp, token: string, orderPublicId: string, key: string): request.Test {
  return request(ctx.http)
    .post(`${ORDERS}/${orderPublicId}/invoice`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({});
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `ikey_${Date.now().toString(36)}_${keySeq}`;
}

interface Fixture {
  companyId: bigint;
  actor: Actor;
  warehouse: { id: bigint; publicId: string };
  customer: { id: bigint; publicId: string };
  product: { id: bigint; publicId: string };
}

/** Tenant + in-scope warehouse + customer + priced product, with an explicitly
 * scoped actor holding all order + invoice permissions. */
async function fixture(ctx: TestApp): Promise<Fixture> {
  const companyId = await makeTenant(ctx);
  const actor = await makeActor(ctx, companyId, ALL_PERMS);
  const wh = await createWarehouse(ctx.prisma, companyId, { code: 'WH' });
  await assignWarehouseScope(ctx.prisma, actor.userId, wh.id, companyId);
  const customer = await createCustomer(ctx.prisma, companyId, { code: 'C1' });
  const product = await createPricedProduct(ctx, companyId, { listPriceAmount: 10000n });
  return {
    companyId,
    actor,
    warehouse: { id: wh.id, publicId: await warehousePublicId(ctx, wh.id) },
    customer: { id: customer.id, publicId: customer.publicId },
    product: { id: product.id, publicId: product.publicId },
  };
}

/** Draft an order; returns its public id. */
async function draftOrder(ctx: TestApp, f: Fixture, quantity = '2'): Promise<string> {
  const res = await createOrder(ctx, f.actor.token, {
    customerId: f.customer.publicId,
    warehouseId: f.warehouse.publicId,
    items: [{ productId: f.product.publicId, quantity }],
  }).expect(201);
  return res.body.id as string;
}

/** Draft + approve + ship an order for a FRESH product (its own stock balance, so
 * repeated calls in one test never collide on the (product, warehouse) balance). */
async function shippedOrder(
  ctx: TestApp,
  f: Fixture,
  quantity = '2',
  onHand = 100n,
): Promise<string> {
  const product = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 10000n });
  await seedBalance(ctx, product.id, f.warehouse.id, onHand);
  const res = await createOrder(ctx, f.actor.token, {
    customerId: f.customer.publicId,
    warehouseId: f.warehouse.publicId,
    items: [{ productId: product.publicId, quantity }],
  }).expect(201);
  const id = res.body.id as string;
  await action(ctx, f.actor.token, `${ORDERS}/${id}/approve`).expect(200);
  await action(ctx, f.actor.token, `${ORDERS}/${id}/ship`, freshKey()).expect(200);
  return id;
}

describe('Invoice / billing foundation (integration, real PostgreSQL)', () => {
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

  // --- permission + status guards -------------------------------------------

  it('1. invoice create without invoice:create → 403', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const noCreate = await makeActor(ctx, f.companyId, ['order:read'], { global: true });
    await invoice(ctx, noCreate.token, id, freshKey()).expect(403);
  });

  it('1b. unauthenticated invoice create → 401', async () => {
    await request(ctx.http)
      .post(`${ORDERS}/00000000-0000-0000-0000-000000000000/invoice`)
      .set('Idempotency-Key', freshKey())
      .send({})
      .expect(401);
  });

  it('2. invoice list/get without invoice:read → 403', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const inv = await invoice(ctx, f.actor.token, id, freshKey()).expect(201);
    const noRead = await makeActor(ctx, f.companyId, ['order:read'], { global: true });
    await request(ctx.http)
      .get(INVOICES)
      .set('Authorization', `Bearer ${noRead.token}`)
      .expect(403);
    await request(ctx.http)
      .get(`${INVOICES}/${inv.body.id}`)
      .set('Authorization', `Bearer ${noRead.token}`)
      .expect(403);
  });

  it('1c. invoice create without an Idempotency-Key header → 400', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    await request(ctx.http)
      .post(`${ORDERS}/${id}/invoice`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(400);
  });

  it('3. invoicing a DRAFT order → 409', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await invoice(ctx, f.actor.token, id, freshKey()).expect(409);
  });

  it('4. invoicing an APPROVED order → 409', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await action(ctx, f.actor.token, `${ORDERS}/${id}/approve`).expect(200);
    await invoice(ctx, f.actor.token, id, freshKey()).expect(409);
  });

  it('5. invoicing a CANCELLED order → 409', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await action(ctx, f.actor.token, `${ORDERS}/${id}/cancel`).expect(200);
    await invoice(ctx, f.actor.token, id, freshKey()).expect(409);
  });

  it('6. invoicing a SHIPPED order succeeds → status ISSUED with a gapless number', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const res = await invoice(ctx, f.actor.token, id, freshKey()).expect(201);
    expect(res.body.status).toBe('ISSUED');
    expect(res.body.invoiceNo).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(res.body.invoiceNumber).toBe('1');
    expect(res.body.issuedAt).toBeTruthy();
    expect(res.body.orderId).toBe(id);
  });

  it('7. a second invoice for the same order with a DIFFERENT key → 409', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    await invoice(ctx, f.actor.token, id, freshKey()).expect(201);
    await invoice(ctx, f.actor.token, id, freshKey()).expect(409);
  });

  // --- idempotency ----------------------------------------------------------

  it('8. same Idempotency-Key replays the same invoice (no duplicate)', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const key = freshKey();
    const first = await invoice(ctx, f.actor.token, id, key).expect(201);
    const second = await invoice(ctx, f.actor.token, id, key).expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.invoiceNo).toBe(first.body.invoiceNo);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(await ctx.prisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('9. the same Idempotency-Key reused for a DIFFERENT order → 409', async () => {
    const f = await fixture(ctx);
    const id1 = await shippedOrder(ctx, f);
    const id2 = await shippedOrder(ctx, f, '2', 100n);
    const key = freshKey();
    await invoice(ctx, f.actor.token, id1, key).expect(201);
    await invoice(ctx, f.actor.token, id2, key).expect(409);
  });

  // --- tenant + scope -------------------------------------------------------

  it('10. cross-company invoice create → 404', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await invoice(ctx, bActor.token, id, freshKey()).expect(404);
  });

  it('11. invoice create without warehouse scope → 404 (object-level entity hiding)', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    await invoice(ctx, scopeless.token, id, freshKey()).expect(404);
  });

  it('12. explicit warehouse scope → invoice create succeeds', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    await invoice(ctx, f.actor.token, id, freshKey()).expect(201);
  });

  it('13. warehouse:scope:all in the same company → invoice create succeeds', async () => {
    const companyId = await makeTenant(ctx);
    const author = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const customer = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    const product = await createPricedProduct(ctx, companyId);
    await seedBalance(ctx, product.id, wh.id, 100n);
    const created = await createOrder(ctx, author.token, {
      customerId: customer.publicId,
      warehouseId: await warehousePublicId(ctx, wh.id),
      items: [{ productId: product.publicId, quantity: '3' }],
    }).expect(201);
    await action(ctx, author.token, `${ORDERS}/${created.body.id}/approve`).expect(200);
    await action(ctx, author.token, `${ORDERS}/${created.body.id}/ship`, freshKey()).expect(200);
    await invoice(ctx, author.token, created.body.id as string, freshKey()).expect(201);
  });

  it('12b. another company’s warehouse:scope:all cannot invoice this order (no bypass) → 404', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const b = await makeTenant(ctx, 'B');
    const bGlobal = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await invoice(ctx, bGlobal.token, id, freshKey()).expect(404);
    const forged = forgeTokenFrom(ctx, bGlobal.token, {
      companyId: f.companyId.toString(),
      warehouseId: f.warehouse.id.toString(),
    });
    await invoice(ctx, forged, id, freshKey()).expect(404);
  });

  // --- totals + snapshot ----------------------------------------------------

  it('14+15. invoice totals + line snapshot equal the order (multi-line)', async () => {
    const f = await fixture(ctx);
    const p2 = await createPricedProduct(ctx, f.companyId, {
      listPriceAmount: 5000n,
      taxRateBp: 1000,
    });
    await seedBalance(ctx, f.product.id, f.warehouse.id, 50n);
    await seedBalance(ctx, p2.id, f.warehouse.id, 50n);
    const created = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [
        { productId: f.product.publicId, quantity: '2' },
        { productId: p2.publicId, quantity: '3' },
      ],
    }).expect(201);
    const orderId = created.body.id as string;
    await action(ctx, f.actor.token, `${ORDERS}/${orderId}/approve`).expect(200);
    await action(ctx, f.actor.token, `${ORDERS}/${orderId}/ship`, freshKey()).expect(200);

    const order = created.body;
    const inv = await invoice(ctx, f.actor.token, orderId, freshKey()).expect(201);
    // Totals identical to the order's.
    expect(inv.body.subtotal).toEqual(order.subtotal);
    expect(inv.body.vat).toEqual(order.vat);
    expect(inv.body.total).toEqual(order.total);
    expect(inv.body.currency).toBe(order.currency);
    // Line snapshot identical (ordered by id): qty, unit price, vat rate, amounts.
    expect(inv.body.items).toHaveLength(2);
    for (let i = 0; i < order.items.length; i += 1) {
      const oi = order.items[i];
      const ii = inv.body.items[i];
      expect(ii.productId).toBe(oi.productId);
      expect(ii.quantity).toBe(oi.quantity);
      expect(ii.unitPrice).toEqual(oi.unitPrice);
      expect(ii.vatRate).toBe(oi.vatRate);
      expect(ii.lineSubtotal).toEqual(oi.lineSubtotal);
      expect(ii.lineVat).toEqual(oi.lineVat);
      expect(ii.lineTotal).toEqual(oi.lineTotal);
    }
  });

  it('16. a client-supplied body field (total/price/companyId) → 400', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    for (const body of [
      { total: '1' },
      { unitPrice: '1' },
      { companyId: '1' },
      { status: 'PAID' },
    ]) {
      await request(ctx.http)
        .post(`${ORDERS}/${id}/invoice`)
        .set('Authorization', `Bearer ${f.actor.token}`)
        .set('Idempotency-Key', freshKey())
        .send(body)
        .expect(400);
    }
  });

  // --- gapless numbering + rollback -----------------------------------------

  it('17+20. concurrent invoices of DIFFERENT orders produce gapless, unique, monotonic numbers', async () => {
    const f = await fixture(ctx);
    const ids = await Promise.all([
      shippedOrder(ctx, f, '1', 100n),
      shippedOrder(ctx, f, '1', 100n),
      shippedOrder(ctx, f, '1', 100n),
      shippedOrder(ctx, f, '1', 100n),
    ]);
    const results = await Promise.all(ids.map((id) => invoice(ctx, f.actor.token, id, freshKey())));
    for (const r of results) expect(r.status).toBe(201);
    const numbers = results.map((r) => Number(r.body.invoiceNumber)).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4]); // contiguous, unique, no gap
  });

  it('18. a transaction that allocates a number then rolls back does NOT burn it (gapless)', async () => {
    const f = await fixture(ctx);
    const id1 = await shippedOrder(ctx, f);
    // Issue one invoice → number 1, series.nextNumber advances to 2.
    const first = await invoice(ctx, f.actor.token, id1, freshKey()).expect(201);
    expect(first.body.invoiceNumber).toBe('1');

    // A transaction that locks the series, takes the next number and advances the
    // counter — then ROLLS BACK — must leave next_number untouched. This is the
    // exact FOR UPDATE + increment the issue path uses (ADR-006 / INVC-6).
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "next_number" FROM "invoice_series"
          WHERE "company_id" = ${f.companyId} AND "series_code" = 'INV' FOR UPDATE`;
        await tx.$executeRaw`
          UPDATE "invoice_series" SET "next_number" = "next_number" + 1
          WHERE "company_id" = ${f.companyId} AND "series_code" = 'INV'`;
        throw new Error('forced rollback after allocation');
      }),
    ).rejects.toThrow('forced rollback after allocation');

    const series = await ctx.prisma.invoiceSeries.findFirstOrThrow({
      where: { companyId: f.companyId, seriesCode: 'INV' },
      select: { nextNumber: true },
    });
    expect(series.nextNumber).toBe(2n); // the rolled-back +1 did not stick — no gap

    // The next real issue therefore takes the contiguous number 2.
    const id2 = await shippedOrder(ctx, f, '1', 100n);
    const inv2 = await invoice(ctx, f.actor.token, id2, freshKey()).expect(201);
    expect(inv2.body.invoiceNumber).toBe('2');
  });

  it('19. concurrent same-order invoice create (different keys) → exactly one wins', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const [a, b] = await Promise.all([
      invoice(ctx, f.actor.token, id, freshKey()),
      invoice(ctx, f.actor.token, id, freshKey()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(await ctx.prisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('19b. concurrent same-KEY invoice create is a single commit (replay), never a duplicate', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const key = freshKey();
    const [a, b] = await Promise.all([
      invoice(ctx, f.actor.token, id, key),
      invoice(ctx, f.actor.token, id, key),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(await ctx.prisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('21. invoice number allocation locks the invoice_series row (counter advances per issue)', async () => {
    const f = await fixture(ctx);
    const id1 = await shippedOrder(ctx, f);
    const id2 = await shippedOrder(ctx, f, '1', 100n);
    await invoice(ctx, f.actor.token, id1, freshKey()).expect(201);
    await invoice(ctx, f.actor.token, id2, freshKey()).expect(201);
    const series = await ctx.prisma.invoiceSeries.findFirstOrThrow({
      where: { companyId: f.companyId, seriesCode: 'INV' },
      select: { nextNumber: true, version: true },
    });
    expect(series.nextNumber).toBe(3n); // two numbers consumed (1, 2) → next is 3
    expect(series.version).toBeGreaterThanOrEqual(2);
  });

  // --- list + detail scope --------------------------------------------------

  it('22. invoice list obeys the warehouse scope filter', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    await invoice(ctx, f.actor.token, id, freshKey()).expect(201);
    // In-scope actor sees the invoice.
    const listed = await request(ctx.http)
      .get(INVOICES)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].orderId).toBe(id);
    // Same-company actor WITHOUT scope sees an empty list (deny-by-default).
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    const empty = await request(ctx.http)
      .get(INVOICES)
      .set('Authorization', `Bearer ${scopeless.token}`)
      .expect(200);
    expect(empty.body.data).toHaveLength(0);
  });

  it('23. invoice detail obeys the warehouse scope filter (out of scope → 404)', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const inv = await invoice(ctx, f.actor.token, id, freshKey()).expect(201);
    // In-scope actor can read it.
    await request(ctx.http)
      .get(`${INVOICES}/${inv.body.id}`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(200);
    // Same-company actor WITHOUT scope → 404 (hidden).
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    await request(ctx.http)
      .get(`${INVOICES}/${inv.body.id}`)
      .set('Authorization', `Bearer ${scopeless.token}`)
      .expect(404);
  });

  it('24. cross-company invoice get → 404', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const inv = await invoice(ctx, f.actor.token, id, freshKey()).expect(201);
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await request(ctx.http)
      .get(`${INVOICES}/${inv.body.id}`)
      .set('Authorization', `Bearer ${bActor.token}`)
      .expect(404);
  });

  // --- audit ----------------------------------------------------------------

  it('25. invoice issue writes an INVOICE_ISSUED audit row + ISSUED history (same tx)', async () => {
    const f = await fixture(ctx);
    const id = await shippedOrder(ctx, f);
    const inv = await invoice(ctx, f.actor.token, id, freshKey()).expect(201);
    const invoiceRow = await ctx.prisma.invoice.findUniqueOrThrow({
      where: { publicId: inv.body.id },
      select: { id: true },
    });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'INVOICE_ISSUED', entityId: invoiceRow.id },
    });
    expect(audit.actorId).toBe(f.actor.userId);
    expect(audit.entityType).toBe('invoice');
    expect(audit.requestId).toBeTruthy();
    const history = await ctx.prisma.invoiceStatusHistory.findMany({
      where: { invoiceId: invoiceRow.id },
      select: { fromStatus: true, toStatus: true, changedById: true },
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.toStatus).toBe('ISSUED');
    expect(history[0]?.changedById).toBe(f.actor.userId);
  });

  it('26. a failed invoice create writes NO audit and NO invoice', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f); // still DRAFT → invoice 409
    await invoice(ctx, f.actor.token, id, freshKey()).expect(409);
    expect(await ctx.prisma.invoice.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'INVOICE_ISSUED' } })).toBe(0);
  });
});
