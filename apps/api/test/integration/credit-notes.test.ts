import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCompanyRbac } from '@b2b/database';
import { WAREHOUSE_SCOPE_ALL } from '@b2b/domain';
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
const RETURNS = `${BASE}/returns`;
const CREDIT_NOTES = `${BASE}/credit-notes`;

/** Every permission to drive draft→approve→ship→invoice + raise/approve return +
 * issue/read credit notes. */
const ALL_PERMS = [
  'order:read',
  'order:create',
  'order:approve',
  'order:ship',
  'invoice:read',
  'invoice:create',
  'return:read',
  'return:create',
  'return:approve',
  'credit-note:read',
  'credit-note:create',
];

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
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
  over: Partial<{ listPriceAmount: bigint; taxRateBp: number }> = {},
): Promise<{ id: bigint; publicId: string }> {
  prodSeq += 1;
  return ctx.prisma.product.create({
    data: {
      companyId,
      sku: `CN_${Date.now().toString(36)}_${prodSeq}`,
      name: `Credit Product ${prodSeq}`,
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

function raiseReturn(
  ctx: TestApp,
  token: string,
  orderPublicId: string,
  body: Record<string, unknown>,
  key: string,
): request.Test {
  return request(ctx.http)
    .post(`${ORDERS}/${orderPublicId}/returns`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body);
}

function creditNote(
  ctx: TestApp,
  token: string,
  returnPublicId: string,
  key?: string,
): request.Test {
  let req = request(ctx.http)
    .post(`${RETURNS}/${returnPublicId}/credit-note`)
    .set('Authorization', `Bearer ${token}`);
  if (key) req = req.set('Idempotency-Key', key);
  return req.send({});
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `cnkey_${Date.now().toString(36)}_${keySeq}`;
}

interface Fixture {
  companyId: bigint;
  actor: Actor;
  warehouse: { id: bigint; publicId: string };
  customer: { id: bigint; publicId: string };
}

async function fixture(ctx: TestApp): Promise<Fixture> {
  const companyId = await makeTenant(ctx);
  const actor = await makeActor(ctx, companyId, ALL_PERMS);
  const wh = await createWarehouse(ctx.prisma, companyId, { code: 'WH' });
  await assignWarehouseScope(ctx.prisma, actor.userId, wh.id, companyId);
  const customer = await createCustomer(ctx.prisma, companyId, { code: 'C1' });
  return {
    companyId,
    actor,
    warehouse: { id: wh.id, publicId: await warehousePublicId(ctx, wh.id) },
    customer: { id: customer.id, publicId: customer.publicId },
  };
}

interface ShippedLine {
  productId: bigint;
  productPublicId: string;
}

/** Draft + approve + ship an order for FRESH priced product(s). */
async function shippedOrder(
  ctx: TestApp,
  f: Fixture,
  lines: Array<{ quantity: string; listPriceAmount?: bigint; taxRateBp?: number }> = [
    { quantity: '2' },
  ],
): Promise<{ orderId: string; lines: ShippedLine[] }> {
  const built: ShippedLine[] = [];
  const items: Array<{ productId: string; quantity: string }> = [];
  for (const l of lines) {
    const product = await createPricedProduct(ctx, f.companyId, {
      listPriceAmount: l.listPriceAmount,
      taxRateBp: l.taxRateBp,
    });
    await seedBalance(ctx, product.id, f.warehouse.id, 100n);
    items.push({ productId: product.publicId, quantity: l.quantity });
    built.push({ productId: product.id, productPublicId: product.publicId });
  }
  const res = await createOrder(ctx, f.actor.token, {
    customerId: f.customer.publicId,
    warehouseId: f.warehouse.publicId,
    items,
  }).expect(201);
  const orderId = res.body.id as string;
  await action(ctx, f.actor.token, `${ORDERS}/${orderId}/approve`).expect(200);
  await action(ctx, f.actor.token, `${ORDERS}/${orderId}/ship`, freshKey()).expect(200);
  return { orderId, lines: built };
}

/** Full happy-path setup → an APPROVED return of an INVOICED order, ready to credit.
 * Returns the return public id (+ order/line info). `invoiced` defaults true. */
async function creditableReturn(
  ctx: TestApp,
  f: Fixture,
  returnItems: Array<{ lineIndex: number; quantity: string }> = [{ lineIndex: 0, quantity: '1' }],
  orderLines: Array<{ quantity: string; listPriceAmount?: bigint; taxRateBp?: number }> = [
    { quantity: '2' },
  ],
  opts: { invoiced?: boolean } = {},
): Promise<{ returnId: string; orderId: string; lines: ShippedLine[] }> {
  const { orderId, lines } = await shippedOrder(ctx, f, orderLines);
  if (opts.invoiced !== false) {
    await action(ctx, f.actor.token, `${ORDERS}/${orderId}/invoice`, freshKey()).expect(201);
  }
  const created = await raiseReturn(
    ctx,
    f.actor.token,
    orderId,
    {
      items: returnItems.map((r) => ({
        productId: lines[r.lineIndex]!.productPublicId,
        quantity: r.quantity,
      })),
    },
    freshKey(),
  ).expect(201);
  const returnId = created.body.id as string;
  await action(ctx, f.actor.token, `${RETURNS}/${returnId}/approve`, freshKey()).expect(200);
  return { returnId, orderId, lines };
}

async function creditNoteInternalId(ctx: TestApp, publicId: string): Promise<bigint> {
  const cn = await ctx.prisma.creditNote.findUniqueOrThrow({
    where: { publicId },
    select: { id: true },
  });
  return cn.id;
}

async function returnInternalId(ctx: TestApp, publicId: string): Promise<bigint> {
  const r = await ctx.prisma.return.findUniqueOrThrow({
    where: { publicId },
    select: { id: true },
  });
  return r.id;
}

describe('Return Invoice / Credit Note foundation (integration, real PostgreSQL)', () => {
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

  it('1. credit note create without credit-note:create → 403', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const noCreate = await makeActor(ctx, f.companyId, ['credit-note:read'], { global: true });
    await creditNote(ctx, noCreate.token, returnId, freshKey()).expect(403);
  });

  it('1b. unauthenticated credit note create → 401', async () => {
    await request(ctx.http)
      .post(`${RETURNS}/00000000-0000-0000-0000-000000000000/credit-note`)
      .set('Idempotency-Key', freshKey())
      .send({})
      .expect(401);
  });

  it('2. credit note list/get without credit-note:read → 403', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const created = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    const noRead = await makeActor(ctx, f.companyId, ['credit-note:create'], { global: true });
    await request(ctx.http)
      .get(CREDIT_NOTES)
      .set('Authorization', `Bearer ${noRead.token}`)
      .expect(403);
    await request(ctx.http)
      .get(`${CREDIT_NOTES}/${created.body.id}`)
      .set('Authorization', `Bearer ${noRead.token}`)
      .expect(403);
  });

  it('4b. credit note create without an Idempotency-Key header → 400', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    await request(ctx.http)
      .post(`${RETURNS}/${returnId}/credit-note`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(400);
  });

  // --- status guards --------------------------------------------------------

  it('3. crediting a REQUESTED (DRAFT) return → 409', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    await action(ctx, f.actor.token, `${ORDERS}/${orderId}/invoice`, freshKey()).expect(201);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    // NOT approved → still DRAFT.
    await creditNote(ctx, f.actor.token, created.body.id, freshKey()).expect(409);
    expect(await ctx.prisma.creditNote.count()).toBe(0);
  });

  it('4. crediting an APPROVED return succeeds → ISSUED with a gapless number', async () => {
    const f = await fixture(ctx);
    const { returnId, orderId } = await creditableReturn(ctx, f);
    const res = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    expect(res.body.status).toBe('ISSUED');
    expect(res.body.creditNoteNo).toMatch(/^CRN-\d{4}-\d{6}$/);
    expect(res.body.creditNoteNumber).toBe('1');
    expect(res.body.issuedAt).toBeTruthy();
    expect(res.body.returnId).toBe(returnId);
    expect(res.body.orderId).toBe(orderId);
    expect(res.body.originalInvoiceId).toBeTruthy();
  });

  it('5. a second credit note for the same return with a DIFFERENT key → 409', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(409);
    const retId = await returnInternalId(ctx, returnId);
    expect(await ctx.prisma.creditNote.count({ where: { returnId: retId } })).toBe(1);
  });

  // --- idempotency ----------------------------------------------------------

  it('6. same Idempotency-Key replays the same credit note (no duplicate)', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const key = freshKey();
    const first = await creditNote(ctx, f.actor.token, returnId, key).expect(201);
    const second = await creditNote(ctx, f.actor.token, returnId, key).expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.creditNoteNo).toBe(first.body.creditNoteNo);
    const retId = await returnInternalId(ctx, returnId);
    expect(await ctx.prisma.creditNote.count({ where: { returnId: retId } })).toBe(1);
  });

  it('7. the same Idempotency-Key reused for a DIFFERENT return → 409', async () => {
    const f = await fixture(ctx);
    const a = await creditableReturn(ctx, f);
    const b = await creditableReturn(ctx, f);
    const key = freshKey();
    await creditNote(ctx, f.actor.token, a.returnId, key).expect(201);
    await creditNote(ctx, f.actor.token, b.returnId, key).expect(409);
  });

  // --- tenant + scope -------------------------------------------------------

  it('8. cross-company credit note create → 404', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await creditNote(ctx, bActor.token, returnId, freshKey()).expect(404);
  });

  it('9. credit note create without warehouse scope → 404 (entity hiding, safe deny)', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    await creditNote(ctx, scopeless.token, returnId, freshKey()).expect(404);
  });

  it('10. explicit warehouse scope → credit note create succeeds', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
  });

  it('11. warehouse:scope:all in the same company → credit note create succeeds', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const global = await makeActor(ctx, f.companyId, ALL_PERMS, { global: true });
    await creditNote(ctx, global.token, returnId, freshKey()).expect(201);
  });

  // --- mass assignment ------------------------------------------------------

  it('12. a client-supplied body field (total/price/companyId/status) → 400', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    for (const body of [
      { total: '1' },
      { unitPrice: '1' },
      { companyId: '1' },
      { status: 'VOID' },
    ]) {
      await request(ctx.http)
        .post(`${RETURNS}/${returnId}/credit-note`)
        .set('Authorization', `Bearer ${f.actor.token}`)
        .set('Idempotency-Key', freshKey())
        .send(body)
        .expect(400);
    }
  });

  // --- totals + snapshot ----------------------------------------------------

  it('13+15. totals follow the returned quantity from the order/invoice price+VAT', async () => {
    const f = await fixture(ctx);
    // Order line: price 10000, VAT 2000bp, shipped 5. Return 2.
    const { returnId, lines } = await creditableReturn(
      ctx,
      f,
      [{ lineIndex: 0, quantity: '2' }],
      [{ quantity: '5', listPriceAmount: 10000n, taxRateBp: 2000 }],
    );
    const res = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    // 2 × 10000 = 20000 net; VAT 20% = 4000; total 24000.
    expect(res.body.subtotal).toEqual({ amount: '20000', currency: 'TRY' });
    expect(res.body.vat).toEqual({ amount: '4000', currency: 'TRY' });
    expect(res.body.total).toEqual({ amount: '24000', currency: 'TRY' });
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.productId).toBe(lines[0]!.productPublicId);
    expect(item.quantity).toBe('2');
    expect(item.unitPrice).toEqual({ amount: '10000', currency: 'TRY' }); // from order/invoice
    expect(item.vatRate).toBe(2000); // from order/invoice
    expect(item.lineSubtotal).toEqual({ amount: '20000', currency: 'TRY' });
    expect(item.lineVat).toEqual({ amount: '4000', currency: 'TRY' });
    expect(item.lineTotal).toEqual({ amount: '24000', currency: 'TRY' });
  });

  it('14. multi-item return totals are summed correctly', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(
      ctx,
      f,
      [
        { lineIndex: 0, quantity: '1' },
        { lineIndex: 1, quantity: '2' },
      ],
      [
        { quantity: '3', listPriceAmount: 10000n, taxRateBp: 2000 },
        { quantity: '3', listPriceAmount: 5000n, taxRateBp: 1000 },
      ],
    );
    const res = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    // L1: 1×10000 net=10000 vat=2000; L2: 2×5000 net=10000 vat=1000.
    expect(res.body.items).toHaveLength(2);
    expect(res.body.subtotal).toEqual({ amount: '20000', currency: 'TRY' });
    expect(res.body.vat).toEqual({ amount: '3000', currency: 'TRY' });
    expect(res.body.total).toEqual({ amount: '23000', currency: 'TRY' });
  });

  // --- original invoice requirement -----------------------------------------

  it('16. crediting a return whose order has NO invoice → 422 (RETURN_RULES §4)', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(
      ctx,
      f,
      [{ lineIndex: 0, quantity: '1' }],
      [{ quantity: '2' }],
      { invoiced: false },
    );
    const res = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(422);
    expect(res.body.code).toBe('BUSINESS_RULE');
    expect(await ctx.prisma.creditNote.count()).toBe(0);
  });

  // --- gapless numbering + rollback -----------------------------------------

  it('17. concurrent credit notes of DIFFERENT returns produce gapless, unique numbers', async () => {
    const f = await fixture(ctx);
    const returns = await Promise.all([
      creditableReturn(ctx, f),
      creditableReturn(ctx, f),
      creditableReturn(ctx, f),
      creditableReturn(ctx, f),
    ]);
    const results = await Promise.all(
      returns.map((r) => creditNote(ctx, f.actor.token, r.returnId, freshKey())),
    );
    for (const r of results) expect(r.status).toBe(201);
    const numbers = results.map((r) => Number(r.body.creditNoteNumber)).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  it('18. a transaction that allocates a CRN number then rolls back does NOT burn it', async () => {
    const f = await fixture(ctx);
    const a = await creditableReturn(ctx, f);
    const first = await creditNote(ctx, f.actor.token, a.returnId, freshKey()).expect(201);
    expect(first.body.creditNoteNumber).toBe('1');

    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "next_number" FROM "invoice_series"
          WHERE "company_id" = ${f.companyId} AND "series_code" = 'CRN' FOR UPDATE`;
        await tx.$executeRaw`
          UPDATE "invoice_series" SET "next_number" = "next_number" + 1
          WHERE "company_id" = ${f.companyId} AND "series_code" = 'CRN'`;
        throw new Error('forced rollback after allocation');
      }),
    ).rejects.toThrow('forced rollback after allocation');

    const series = await ctx.prisma.invoiceSeries.findFirstOrThrow({
      where: { companyId: f.companyId, seriesCode: 'CRN' },
      select: { nextNumber: true },
    });
    expect(series.nextNumber).toBe(2n); // the rolled-back +1 did not stick — no gap

    const b = await creditableReturn(ctx, f);
    const cn2 = await creditNote(ctx, f.actor.token, b.returnId, freshKey()).expect(201);
    expect(cn2.body.creditNoteNumber).toBe('2');
  });

  it('19. concurrent same-return create (different keys) → exactly one wins', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const [a, b] = await Promise.all([
      creditNote(ctx, f.actor.token, returnId, freshKey()),
      creditNote(ctx, f.actor.token, returnId, freshKey()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const retId = await returnInternalId(ctx, returnId);
    expect(await ctx.prisma.creditNote.count({ where: { returnId: retId } })).toBe(1);
  });

  it('19b. concurrent same-KEY create is a single commit (replay), never a duplicate', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const key = freshKey();
    const [a, b] = await Promise.all([
      creditNote(ctx, f.actor.token, returnId, key),
      creditNote(ctx, f.actor.token, returnId, key),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    const retId = await returnInternalId(ctx, returnId);
    expect(await ctx.prisma.creditNote.count({ where: { returnId: retId } })).toBe(1);
  });

  // --- audit ----------------------------------------------------------------

  it('20. credit note issue writes a CREDIT_NOTE_ISSUED audit row (same tx)', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const res = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    const cnId = await creditNoteInternalId(ctx, res.body.id);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'CREDIT_NOTE_ISSUED', entityId: cnId },
    });
    expect(audit.actorId).toBe(f.actor.userId);
    expect(audit.entityType).toBe('credit_note');
    expect(audit.requestId).toBeTruthy();
  });

  it('21. a failed credit note create (no invoice) writes NO audit and NO credit note', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(
      ctx,
      f,
      [{ lineIndex: 0, quantity: '1' }],
      [{ quantity: '2' }],
      { invoiced: false },
    );
    await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(422);
    expect(await ctx.prisma.creditNote.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'CREDIT_NOTE_ISSUED' } })).toBe(0);
  });

  // --- list + detail scope --------------------------------------------------

  it('22. credit note list obeys the warehouse scope filter', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const created = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    const listed = await request(ctx.http)
      .get(CREDIT_NOTES)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.body.id);
    // Same-company actor WITHOUT scope sees an empty list (deny-by-default).
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    const empty = await request(ctx.http)
      .get(CREDIT_NOTES)
      .set('Authorization', `Bearer ${scopeless.token}`)
      .expect(200);
    expect(empty.body.data).toHaveLength(0);
  });

  it('23. credit note detail obeys the warehouse scope filter (out of scope → 404)', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const created = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    await request(ctx.http)
      .get(`${CREDIT_NOTES}/${created.body.id}`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(200);
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    await request(ctx.http)
      .get(`${CREDIT_NOTES}/${created.body.id}`)
      .set('Authorization', `Bearer ${scopeless.token}`)
      .expect(404);
  });

  it('24. cross-company credit note get → 404', async () => {
    const f = await fixture(ctx);
    const { returnId } = await creditableReturn(ctx, f);
    const created = await creditNote(ctx, f.actor.token, returnId, freshKey()).expect(201);
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await request(ctx.http)
      .get(`${CREDIT_NOTES}/${created.body.id}`)
      .set('Authorization', `Bearer ${bActor.token}`)
      .expect(404);
  });
});
