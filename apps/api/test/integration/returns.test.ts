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

/** Every permission needed to drive draft→approve→ship→invoice + raise/approve/read returns. */
const ALL_PERMS = [
  'order:read',
  'order:create',
  'order:cancel',
  'order:approve',
  'order:ship',
  'invoice:read',
  'invoice:create',
  'return:read',
  'return:create',
  'return:approve',
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
  over: Partial<{ sku: string; listPriceAmount: bigint; taxRateBp: number }> = {},
): Promise<{ id: bigint; publicId: string }> {
  prodSeq += 1;
  return ctx.prisma.product.create({
    data: {
      companyId,
      sku: over.sku ?? `RP_${Date.now().toString(36)}_${prodSeq}`,
      name: `Return Product ${prodSeq}`,
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
  reserved = 0n,
): Promise<void> {
  await ctx.prisma.stockBalance.create({ data: { productId, warehouseId, onHand, reserved } });
}

async function balanceOf(
  ctx: TestApp,
  productId: bigint,
  warehouseId: bigint,
): Promise<{ onHand: bigint; reserved: bigint }> {
  const b = await ctx.prisma.stockBalance.findFirstOrThrow({
    where: { productId, warehouseId },
    select: { onHand: true, reserved: true },
  });
  return b;
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
  key?: string,
): request.Test {
  let req = request(ctx.http)
    .post(`${ORDERS}/${orderPublicId}/returns`)
    .set('Authorization', `Bearer ${token}`);
  if (key) req = req.set('Idempotency-Key', key);
  return req.send(body);
}

function approveReturn(
  ctx: TestApp,
  token: string,
  returnPublicId: string,
  key?: string,
): request.Test {
  let req = request(ctx.http)
    .post(`${RETURNS}/${returnPublicId}/approve`)
    .set('Authorization', `Bearer ${token}`);
  if (key) req = req.set('Idempotency-Key', key);
  return req.send({});
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `rkey_${Date.now().toString(36)}_${keySeq}`;
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
  shipped: bigint;
}

/** Draft + approve + ship an order for FRESH product(s) (own balance, so repeated
 * calls never collide on a (product, warehouse) balance). Returns the order public
 * id + its lines. `onHand` is each product's pre-ship on-hand. */
async function shippedOrder(
  ctx: TestApp,
  f: Fixture,
  lines: Array<{ quantity: string; onHand?: bigint }> = [{ quantity: '2' }],
): Promise<{ orderId: string; lines: ShippedLine[] }> {
  const built: ShippedLine[] = [];
  const items: Array<{ productId: string; quantity: string }> = [];
  for (const l of lines) {
    const product = await createPricedProduct(ctx, f.companyId);
    await seedBalance(ctx, product.id, f.warehouse.id, l.onHand ?? 100n);
    items.push({ productId: product.publicId, quantity: l.quantity });
    built.push({
      productId: product.id,
      productPublicId: product.publicId,
      shipped: BigInt(l.quantity),
    });
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

async function returnInternalId(ctx: TestApp, publicId: string): Promise<bigint> {
  const r = await ctx.prisma.return.findUniqueOrThrow({
    where: { publicId },
    select: { id: true },
  });
  return r.id;
}

describe('Return / refund foundation (integration, real PostgreSQL)', () => {
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

  it('1. return create without return:create → 403', async () => {
    const f = await fixture(ctx);
    const { orderId } = await shippedOrder(ctx, f);
    const noCreate = await makeActor(ctx, f.companyId, ['return:read'], { global: true });
    await raiseReturn(
      ctx,
      noCreate.token,
      orderId,
      { items: [{ productId: f.customer.publicId, quantity: '1' }] },
      freshKey(),
    ).expect(403);
  });

  it('1b. unauthenticated return create → 401', async () => {
    await request(ctx.http)
      .post(`${ORDERS}/00000000-0000-0000-0000-000000000000/returns`)
      .set('Idempotency-Key', freshKey())
      .send({ items: [{ productId: '00000000-0000-0000-0000-000000000000', quantity: '1' }] })
      .expect(401);
  });

  it('2. return list/get without return:read → 403', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    const noRead = await makeActor(ctx, f.companyId, ['return:create'], { global: true });
    await request(ctx.http).get(RETURNS).set('Authorization', `Bearer ${noRead.token}`).expect(403);
    await request(ctx.http)
      .get(`${RETURNS}/${created.body.id}`)
      .set('Authorization', `Bearer ${noRead.token}`)
      .expect(403);
  });

  it('3. return approve without return:approve → 403', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    const noApprove = await makeActor(ctx, f.companyId, ['return:read', 'return:create'], {
      global: true,
    });
    await approveReturn(ctx, noApprove.token, created.body.id, freshKey()).expect(403);
  });

  // --- create status guards -------------------------------------------------

  it('4. raising a return for a DRAFT/APPROVED/CANCELLED order → 409', async () => {
    const f = await fixture(ctx);
    // DRAFT
    const p1 = await createPricedProduct(ctx, f.companyId);
    await seedBalance(ctx, p1.id, f.warehouse.id, 100n);
    const draft = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [{ productId: p1.publicId, quantity: '2' }],
    }).expect(201);
    await raiseReturn(
      ctx,
      f.actor.token,
      draft.body.id,
      { items: [{ productId: p1.publicId, quantity: '1' }] },
      freshKey(),
    ).expect(409);
    // APPROVED
    await action(ctx, f.actor.token, `${ORDERS}/${draft.body.id}/approve`).expect(200);
    await raiseReturn(
      ctx,
      f.actor.token,
      draft.body.id,
      { items: [{ productId: p1.publicId, quantity: '1' }] },
      freshKey(),
    ).expect(409);
    // CANCELLED (a fresh draft order)
    const p2 = await createPricedProduct(ctx, f.companyId);
    await seedBalance(ctx, p2.id, f.warehouse.id, 100n);
    const draft2 = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [{ productId: p2.publicId, quantity: '2' }],
    }).expect(201);
    await action(ctx, f.actor.token, `${ORDERS}/${draft2.body.id}/cancel`).expect(200);
    await raiseReturn(
      ctx,
      f.actor.token,
      draft2.body.id,
      { items: [{ productId: p2.publicId, quantity: '1' }] },
      freshKey(),
    ).expect(409);
  });

  it('5. raising a return for a SHIPPED order succeeds → status DRAFT', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const res = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.orderId).toBe(orderId);
    expect(res.body.returnNo).toMatch(/^RET-\d{8}-[0-9A-F]{10}$/);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productId).toBe(lines[0]!.productPublicId);
    expect(res.body.items[0].quantity).toBe('1');
    expect(res.body.approvedAt).toBeNull();
  });

  it('6. raising a return for an INVOICED order succeeds', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    await action(ctx, f.actor.token, `${ORDERS}/${orderId}/invoice`, freshKey()).expect(201);
    await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
  });

  it('1c. return create / approve without an Idempotency-Key → 400', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    await request(ctx.http)
      .post(`${ORDERS}/${orderId}/returns`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({ items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] })
      .expect(400);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    await request(ctx.http)
      .post(`${RETURNS}/${created.body.id}/approve`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(400);
  });

  // --- quantity validation --------------------------------------------------

  it('7. invalid quantity (0/negative/decimal/empty/over-bigint) → 400', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    for (const quantity of ['0', '-1', '1.5', '', '9223372036854775808']) {
      await raiseReturn(
        ctx,
        f.actor.token,
        orderId,
        { items: [{ productId: lines[0]!.productPublicId, quantity }] },
        freshKey(),
      ).expect(400);
    }
  });

  it('8. a return quantity above the shipped quantity → 409', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2' }]);
    await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '3' }] },
      freshKey(),
    ).expect(409);
  });

  it('9. previously-returned quantity counts toward the limit', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '5' }]);
    const p = lines[0]!.productPublicId;
    // Return + approve 3 of 5.
    const first = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: p, quantity: '3' }] },
      freshKey(),
    ).expect(201);
    await approveReturn(ctx, f.actor.token, first.body.id, freshKey()).expect(200);
    // A further 3 would exceed (3 already + 3 = 6 > 5) → 409.
    await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: p, quantity: '3' }] },
      freshKey(),
    ).expect(409);
    // But the remaining 2 is allowed.
    await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: p, quantity: '2' }] },
      freshKey(),
    ).expect(201);
  });

  // --- idempotency ----------------------------------------------------------

  it('10. same Idempotency-Key replays the same return (no duplicate)', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const key = freshKey();
    const body = { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] };
    const first = await raiseReturn(ctx, f.actor.token, orderId, body, key).expect(201);
    const second = await raiseReturn(ctx, f.actor.token, orderId, body, key).expect(201);
    expect(second.body.id).toBe(first.body.id);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: orderId },
      select: { id: true },
    });
    expect(await ctx.prisma.return.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('11. the same Idempotency-Key reused with a different payload → 409', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2' }]);
    const key = freshKey();
    const p = lines[0]!.productPublicId;
    await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: p, quantity: '1' }] },
      key,
    ).expect(201);
    await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: p, quantity: '2' }] },
      key,
    ).expect(409);
  });

  // --- tenant + scope -------------------------------------------------------

  it('12. cross-company return create → 404', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await raiseReturn(
      ctx,
      bActor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(404);
  });

  it('13. return create without warehouse scope → 404 (entity hiding, safe deny)', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    await raiseReturn(
      ctx,
      scopeless.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(404);
  });

  it('14. explicit warehouse scope → return create succeeds', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
  });

  it('15. warehouse:scope:all in the same company → return create succeeds', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const global = await makeActor(ctx, f.companyId, ALL_PERMS, { global: true });
    await raiseReturn(
      ctx,
      global.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
  });

  // --- create has no stock effect -------------------------------------------

  it('16. raising a return does NOT change the balance or write a ledger movement', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2', onHand: 100n }]);
    const line = lines[0]!;
    const before = await balanceOf(ctx, line.productId, f.warehouse.id);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: line.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    const after = await balanceOf(ctx, line.productId, f.warehouse.id);
    expect(after.onHand).toBe(before.onHand); // 98 unchanged (100 - 2 shipped)
    expect(after.reserved).toBe(before.reserved);
    const retId = await returnInternalId(ctx, created.body.id);
    expect(
      await ctx.prisma.stockLedger.count({
        where: { referenceType: 'RETURN', referenceId: retId },
      }),
    ).toBe(0);
  });

  // --- approve restocks -----------------------------------------------------

  it('17-20. approve sets APPROVED, restocks on_hand, writes RETURN_IN, leaves reserved', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2', onHand: 100n }]);
    const line = lines[0]!;
    // After ship: on_hand 98, reserved 0.
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: line.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    const res = await approveReturn(ctx, f.actor.token, created.body.id, freshKey()).expect(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approvedAt).toBeTruthy();

    const bal = await balanceOf(ctx, line.productId, f.warehouse.id);
    expect(bal.onHand).toBe(99n); // 98 + 1 restocked
    expect(bal.reserved).toBe(0n); // unchanged

    const retId = await returnInternalId(ctx, created.body.id);
    const movements = await ctx.prisma.stockLedger.findMany({
      where: { referenceType: 'RETURN', referenceId: retId },
      select: {
        changeType: true,
        quantity: true,
        productId: true,
        warehouseId: true,
        balanceAfter: true,
      },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.changeType).toBe('RETURN_IN');
    expect(movements[0]!.quantity).toBe(1n); // positive
    expect(movements[0]!.warehouseId).toBe(f.warehouse.id);
    expect(movements[0]!.balanceAfter).toBe(99n);
  });

  it('21+22. approve writes a RETURN_APPROVED audit + DRAFT→APPROVED history (same tx)', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    await approveReturn(ctx, f.actor.token, created.body.id, freshKey()).expect(200);
    const retId = await returnInternalId(ctx, created.body.id);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'RETURN_APPROVED', entityId: retId },
    });
    expect(audit.actorId).toBe(f.actor.userId);
    expect(audit.entityType).toBe('return');
    expect(audit.requestId).toBeTruthy();
    const history = await ctx.prisma.returnStatusHistory.findMany({
      where: { returnId: retId },
      orderBy: { id: 'asc' },
      select: { fromStatus: true, toStatus: true },
    });
    // null→DRAFT at create, DRAFT→APPROVED at approve.
    expect(history.map((h) => h.toStatus)).toEqual(['DRAFT', 'APPROVED']);
    expect(history[1]!.fromStatus).toBe('DRAFT');
  });

  it('23. a failed approve (over-return) leaves NO restock/ledger and keeps the return DRAFT', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2', onHand: 100n }]);
    const p = lines[0]!.productPublicId;
    // Two DRAFT returns of 1 each (2 shipped → both allowed).
    const a = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: p, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    const b = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: p, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    // Approve B (restocks 1 → on_hand 99).
    await approveReturn(ctx, f.actor.token, b.body.id, freshKey()).expect(200);
    // Tamper A's line to 2 so approving it would exceed (1 approved + 2 = 3 > 2).
    const aId = await returnInternalId(ctx, a.body.id);
    await ctx.prisma.returnItem.updateMany({ where: { returnId: aId }, data: { quantity: 2n } });
    await approveReturn(ctx, f.actor.token, a.body.id, freshKey()).expect(409);
    // A stays DRAFT, no RETURN_IN for A, balance still 99 (only B restocked).
    const aRow = await ctx.prisma.return.findUniqueOrThrow({
      where: { id: aId },
      select: { status: true },
    });
    expect(aRow.status).toBe('DRAFT');
    expect(
      await ctx.prisma.stockLedger.count({ where: { referenceType: 'RETURN', referenceId: aId } }),
    ).toBe(0);
    expect((await balanceOf(ctx, lines[0]!.productId, f.warehouse.id)).onHand).toBe(99n);
  });

  it('24. approving an already-APPROVED return → 409 (no second restock)', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2', onHand: 100n }]);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    await approveReturn(ctx, f.actor.token, created.body.id, freshKey()).expect(200);
    await approveReturn(ctx, f.actor.token, created.body.id, freshKey()).expect(409);
    const retId = await returnInternalId(ctx, created.body.id);
    expect(
      await ctx.prisma.stockLedger.count({
        where: { referenceType: 'RETURN', referenceId: retId },
      }),
    ).toBe(1);
    expect((await balanceOf(ctx, lines[0]!.productId, f.warehouse.id)).onHand).toBe(99n);
  });

  it('24b. same-key approve replay returns the same APPROVED return (no duplicate)', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2', onHand: 100n }]);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    const key = freshKey();
    const first = await approveReturn(ctx, f.actor.token, created.body.id, key).expect(200);
    const second = await approveReturn(ctx, f.actor.token, created.body.id, key).expect(200);
    expect(second.body.status).toBe('APPROVED');
    expect(second.body.id).toBe(first.body.id);
    const retId = await returnInternalId(ctx, created.body.id);
    expect(
      await ctx.prisma.stockLedger.count({
        where: { referenceType: 'RETURN', referenceId: retId },
      }),
    ).toBe(1);
  });

  it('25. concurrent approve (different keys) → one wins, exactly one RETURN_IN', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2', onHand: 100n }]);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    const [a, b] = await Promise.all([
      approveReturn(ctx, f.actor.token, created.body.id, freshKey()),
      approveReturn(ctx, f.actor.token, created.body.id, freshKey()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const retId = await returnInternalId(ctx, created.body.id);
    expect(
      await ctx.prisma.stockLedger.count({
        where: { referenceType: 'RETURN', referenceId: retId },
      }),
    ).toBe(1);
    expect((await balanceOf(ctx, lines[0]!.productId, f.warehouse.id)).onHand).toBe(99n);
  });

  // --- multi-item all-or-nothing --------------------------------------------

  it('26. a multi-item return restocks every line atomically', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [
      { quantity: '2', onHand: 100n },
      { quantity: '3', onHand: 50n },
    ]);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      {
        items: [
          { productId: lines[0]!.productPublicId, quantity: '1' },
          { productId: lines[1]!.productPublicId, quantity: '2' },
        ],
      },
      freshKey(),
    ).expect(201);
    await approveReturn(ctx, f.actor.token, created.body.id, freshKey()).expect(200);
    expect((await balanceOf(ctx, lines[0]!.productId, f.warehouse.id)).onHand).toBe(99n); // 98 + 1
    expect((await balanceOf(ctx, lines[1]!.productId, f.warehouse.id)).onHand).toBe(49n); // 47 + 2
    const retId = await returnInternalId(ctx, created.body.id);
    expect(
      await ctx.prisma.stockLedger.count({
        where: { referenceType: 'RETURN', referenceId: retId },
      }),
    ).toBe(2);
  });

  it('26b. a multi-item approve is all-or-nothing (one over-return line rolls back both)', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [
      { quantity: '2', onHand: 100n },
      { quantity: '2', onHand: 100n },
    ]);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      {
        items: [
          { productId: lines[0]!.productPublicId, quantity: '1' },
          { productId: lines[1]!.productPublicId, quantity: '1' },
        ],
      },
      freshKey(),
    ).expect(201);
    // Tamper the SECOND line to exceed its shipped quantity (3 > 2).
    const retId = await returnInternalId(ctx, created.body.id);
    await ctx.prisma.returnItem.updateMany({
      where: { returnId: retId, productId: lines[1]!.productId },
      data: { quantity: 3n },
    });
    await approveReturn(ctx, f.actor.token, created.body.id, freshKey()).expect(409);
    // Neither line restocked (both still at post-ship 98), no ledger, still DRAFT.
    expect((await balanceOf(ctx, lines[0]!.productId, f.warehouse.id)).onHand).toBe(98n);
    expect((await balanceOf(ctx, lines[1]!.productId, f.warehouse.id)).onHand).toBe(98n);
    expect(
      await ctx.prisma.stockLedger.count({
        where: { referenceType: 'RETURN', referenceId: retId },
      }),
    ).toBe(0);
    const row = await ctx.prisma.return.findUniqueOrThrow({
      where: { id: retId },
      select: { status: true },
    });
    expect(row.status).toBe('DRAFT');
  });

  // --- lifecycle edge cases -------------------------------------------------

  it('27. an inactive product still approves safely (physical goods restock)', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2', onHand: 100n }]);
    const line = lines[0]!;
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: line.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    // Deactivate AND soft-delete the product after the return is raised.
    await ctx.prisma.product.update({
      where: { id: line.productId },
      data: { isActive: false, deletedAt: new Date() },
    });
    await approveReturn(ctx, f.actor.token, created.body.id, freshKey()).expect(200);
    // Restock still reflects physical reality (on_hand 99) + ledger written.
    expect((await balanceOf(ctx, line.productId, f.warehouse.id)).onHand).toBe(99n);
    const retId = await returnInternalId(ctx, created.body.id);
    expect(
      await ctx.prisma.stockLedger.count({
        where: { referenceType: 'RETURN', referenceId: retId, changeType: 'RETURN_IN' },
      }),
    ).toBe(1);
  });

  it('28. an inactive warehouse fails approve and leaves no restock', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f, [{ quantity: '2', onHand: 100n }]);
    const line = lines[0]!;
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: line.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    await ctx.prisma.warehouse.update({ where: { id: f.warehouse.id }, data: { isActive: false } });
    await approveReturn(ctx, f.actor.token, created.body.id, freshKey()).expect(403);
    expect((await balanceOf(ctx, line.productId, f.warehouse.id)).onHand).toBe(98n); // unchanged
    const retId = await returnInternalId(ctx, created.body.id);
    expect(
      await ctx.prisma.stockLedger.count({
        where: { referenceType: 'RETURN', referenceId: retId },
      }),
    ).toBe(0);
  });

  // --- list + detail scope --------------------------------------------------

  it('29. return list obeys the warehouse scope filter', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    const listed = await request(ctx.http)
      .get(RETURNS)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].orderId).toBe(orderId);
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    const empty = await request(ctx.http)
      .get(RETURNS)
      .set('Authorization', `Bearer ${scopeless.token}`)
      .expect(200);
    expect(empty.body.data).toHaveLength(0);
  });

  it('30. return detail obeys the warehouse scope filter (out of scope → 404)', async () => {
    const f = await fixture(ctx);
    const { orderId, lines } = await shippedOrder(ctx, f);
    const created = await raiseReturn(
      ctx,
      f.actor.token,
      orderId,
      { items: [{ productId: lines[0]!.productPublicId, quantity: '1' }] },
      freshKey(),
    ).expect(201);
    await request(ctx.http)
      .get(`${RETURNS}/${created.body.id}`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(200);
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    await request(ctx.http)
      .get(`${RETURNS}/${created.body.id}`)
      .set('Authorization', `Bearer ${scopeless.token}`)
      .expect(404);
    // Cross-company get → 404.
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await request(ctx.http)
      .get(`${RETURNS}/${created.body.id}`)
      .set('Authorization', `Bearer ${bActor.token}`)
      .expect(404);
  });
});
