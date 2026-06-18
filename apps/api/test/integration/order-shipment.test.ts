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
const STOCK = `${BASE}/stock`;

/** Every order permission needed to drive draft→approve→ship, plus the stock
 * permissions the ship-vs-mutation race tests need. */
const ALL_PERMS = [
  'order:read',
  'order:create',
  'order:update',
  'order:cancel',
  'order:approve',
  'order:ship',
  'stock:adjust',
  'stock:transfer',
  'stock:read',
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

/** A fresh tenant with its own seeded RBAC (no pre-seeded MAIN warehouse). */
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
  const product = await ctx.prisma.product.create({
    data: {
      companyId,
      sku: over.sku ?? `SP_${Date.now().toString(36)}_${prodSeq}`,
      name: `Ship Product ${prodSeq}`,
      listPriceAmount: over.listPriceAmount ?? 10000n,
      currency: 'TRY',
      taxRateBp: over.taxRateBp ?? 2000,
      isActive: true,
    },
    select: { id: true, publicId: true },
  });
  return product;
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
): Promise<{ onHand: bigint; reserved: bigint } | null> {
  const bal = await ctx.prisma.stockBalance.findFirst({
    where: { productId, warehouseId },
    select: { onHand: true, reserved: true },
  });
  return bal ? { onHand: bal.onHand, reserved: bal.reserved } : null;
}

function createOrder(ctx: TestApp, token: string, body: Record<string, unknown>): request.Test {
  return request(ctx.http).post(ORDERS).set('Authorization', `Bearer ${token}`).send(body);
}

function approve(ctx: TestApp, token: string, orderPublicId: string): request.Test {
  return request(ctx.http)
    .post(`${ORDERS}/${orderPublicId}/approve`)
    .set('Authorization', `Bearer ${token}`)
    .send({});
}

function ship(ctx: TestApp, token: string, orderPublicId: string, key: string): request.Test {
  return request(ctx.http)
    .post(`${ORDERS}/${orderPublicId}/ship`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send({});
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `skey_${Date.now().toString(36)}_${keySeq}`;
}

interface Fixture {
  companyId: bigint;
  actor: Actor;
  warehouse: { id: bigint; publicId: string };
  customer: { id: bigint; publicId: string };
  product: { id: bigint; publicId: string };
}

/** Tenant + in-scope warehouse + customer + priced product, with an explicitly
 * scoped actor holding all order + stock permissions. */
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

async function draftOrder(ctx: TestApp, f: Fixture, quantity = '2'): Promise<string> {
  const res = await createOrder(ctx, f.actor.token, {
    customerId: f.customer.publicId,
    warehouseId: f.warehouse.publicId,
    items: [{ productId: f.product.publicId, quantity }],
  }).expect(201);
  return res.body.id as string;
}

/** Draft + approve a single-product order with plenty of stock; returns its public id. */
async function approvedOrder(
  ctx: TestApp,
  f: Fixture,
  quantity = '2',
  onHand = 100n,
): Promise<string> {
  await seedBalance(ctx, f.product.id, f.warehouse.id, onHand);
  const id = await draftOrder(ctx, f, quantity);
  await approve(ctx, f.actor.token, id).expect(200);
  return id;
}

describe('Order shipment / stock commit foundation (integration, real PostgreSQL)', () => {
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

  it('1. ship without order:ship → 403', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f);
    const noShip = await makeActor(ctx, f.companyId, ['order:read'], { global: true });
    await ship(ctx, noShip.token, id, freshKey()).expect(403);
  });

  it('1b. unauthenticated ship is rejected by the global JwtAuthGuard → 401', async () => {
    await request(ctx.http)
      .post(`${ORDERS}/00000000-0000-0000-0000-000000000000/ship`)
      .set('Idempotency-Key', freshKey())
      .send({})
      .expect(401);
  });

  it('1c. ship without an Idempotency-Key header → 400', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f);
    await request(ctx.http)
      .post(`${ORDERS}/${id}/ship`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(400);
  });

  it('2. shipping a DRAFT order → 409', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await ship(ctx, f.actor.token, id, freshKey()).expect(409);
  });

  it('3. shipping a CANCELLED order → 409', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await request(ctx.http)
      .post(`${ORDERS}/${id}/cancel`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(200);
    await ship(ctx, f.actor.token, id, freshKey()).expect(409);
  });

  it('4. shipping an APPROVED order succeeds → status SHIPPED', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f);
    const res = await ship(ctx, f.actor.token, id, freshKey()).expect(200);
    expect(res.body.status).toBe('SHIPPED');
    expect(res.body.shippedAt).toBeTruthy();
  });

  it('5. shipping an already-SHIPPED order with a DIFFERENT key → 409', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f);
    await ship(ctx, f.actor.token, id, freshKey()).expect(200);
    await ship(ctx, f.actor.token, id, freshKey()).expect(409);
  });

  // --- idempotency ----------------------------------------------------------

  it('6. same Idempotency-Key replays the same result and commits nothing twice', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '3', 50n);
    const key = freshKey();
    const first = await ship(ctx, f.actor.token, id, key).expect(200);
    const second = await ship(ctx, f.actor.token, id, key).expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.status).toBe('SHIPPED');
    // Stock committed exactly once; exactly one SHIPMENT movement; one shipment row.
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 47n,
      reserved: 0n,
    });
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(1);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(await ctx.prisma.orderShipment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('7. the same Idempotency-Key reused for a DIFFERENT order → 409', async () => {
    const f = await fixture(ctx);
    const id1 = await approvedOrder(ctx, f);
    const p2 = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 5000n });
    await seedBalance(ctx, p2.id, f.warehouse.id, 100n);
    const created = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [{ productId: p2.publicId, quantity: '2' }],
    }).expect(201);
    await approve(ctx, f.actor.token, created.body.id).expect(200);

    const key = freshKey();
    await ship(ctx, f.actor.token, id1, key).expect(200);
    await ship(ctx, f.actor.token, created.body.id as string, key).expect(409);
  });

  // --- tenant + scope -------------------------------------------------------

  it('8. cross-company ship → 404', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f);
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await ship(ctx, bActor.token, id, freshKey()).expect(404);
  });

  it('9. ship without warehouse scope → 404 (object-level entity hiding)', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f);
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    await ship(ctx, scopeless.token, id, freshKey()).expect(404);
  });

  it('10. explicit warehouse scope → ship succeeds', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f);
    await ship(ctx, f.actor.token, id, freshKey()).expect(200);
  });

  it('11. warehouse:scope:all in the same company → ship succeeds', async () => {
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
    await approve(ctx, author.token, created.body.id).expect(200);
    await ship(ctx, author.token, created.body.id as string, freshKey()).expect(200);
  });

  it('12. another company’s warehouse:scope:all cannot ship this order (no bypass) → 404', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f);
    const b = await makeTenant(ctx, 'B');
    const bGlobal = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await ship(ctx, bGlobal.token, id, freshKey()).expect(404);
    const forged = forgeTokenFrom(ctx, bGlobal.token, {
      companyId: f.companyId.toString(),
      warehouseId: f.warehouse.id.toString(),
    });
    await ship(ctx, forged, id, freshKey()).expect(404);
  });

  // --- stock commit effect --------------------------------------------------

  it('13+14. shipment reduces reserved AND on_hand by the shipped quantity', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '4', 10n);
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 10n,
      reserved: 4n,
    });
    await ship(ctx, f.actor.token, id, freshKey()).expect(200);
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 6n,
      reserved: 0n,
    });
  });

  it('15. shipment marks the order’s ACTIVE reservations CONSUMED', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2');
    await ship(ctx, f.actor.token, id, freshKey()).expect(200);
    const reservations = await ctx.prisma.stockReservation.findMany({
      where: { order: { publicId: id } },
      select: { status: true, consumedAt: true },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe('CONSUMED');
    expect(reservations[0]?.consumedAt).toBeTruthy();
  });

  it('16+17. shipment writes one SHIPMENT ledger movement per item, bound to the order', async () => {
    const f = await fixture(ctx);
    const p2 = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 5000n });
    await seedBalance(ctx, f.product.id, f.warehouse.id, 20n);
    await seedBalance(ctx, p2.id, f.warehouse.id, 20n);
    const created = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [
        { productId: f.product.publicId, quantity: '2' },
        { productId: p2.publicId, quantity: '3' },
      ],
    }).expect(201);
    await approve(ctx, f.actor.token, created.body.id).expect(200);
    await ship(ctx, f.actor.token, created.body.id as string, freshKey()).expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: created.body.id },
      select: { id: true },
    });
    const movements = await ctx.prisma.stockLedger.findMany({
      where: { changeType: 'SHIPMENT' },
      orderBy: { productId: 'asc' },
      select: { quantity: true, referenceType: true, referenceId: true, idempotencyKey: true },
    });
    expect(movements).toHaveLength(2);
    for (const m of movements) {
      expect(m.quantity).toBeLessThan(0n); // OUT (negative)
      expect(m.referenceType).toBe('ORDER_SHIPMENT');
      expect(m.referenceId).toBe(order.id);
      expect(m.idempotencyKey.startsWith(`ORDER_SHIPMENT:${order.id.toString()}:`)).toBe(true);
    }
    // Signed quantities are −2 and −3 (numeric ascending).
    expect(movements.map((m) => m.quantity).sort((a, b) => (a < b ? -1 : 1))).toEqual([-3n, -2n]);
  });

  it('18. SHIPMENT ledger rows remain immutable (UPDATE/DELETE rejected by the DB)', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2');
    await ship(ctx, f.actor.token, id, freshKey()).expect(200);
    const movement = await ctx.prisma.stockLedger.findFirstOrThrow({
      where: { changeType: 'SHIPMENT' },
      select: { id: true },
    });
    await expect(
      ctx.prisma
        .$executeRaw`UPDATE "stock_ledger" SET "reason" = 'tamper' WHERE "id" = ${movement.id}`,
    ).rejects.toThrow();
    await expect(
      ctx.prisma.$executeRaw`DELETE FROM "stock_ledger" WHERE "id" = ${movement.id}`,
    ).rejects.toThrow();
  });

  // --- shipment failure cases (all-or-nothing rollback) ---------------------

  it('19. a missing ACTIVE reservation → ship 409 and full rollback', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2');
    // Release the reservation out from under the order (no longer ACTIVE).
    await ctx.prisma.stockReservation.updateMany({
      where: { order: { publicId: id } },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    await ship(ctx, f.actor.token, id, freshKey()).expect(409);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true, status: true, shippedAt: true },
    });
    expect(order.status).toBe('APPROVED'); // unchanged
    expect(order.shippedAt).toBeNull();
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(0);
    expect(await ctx.prisma.orderShipment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('20. reserved < shipment quantity → ship 409 and full rollback', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '5', 100n);
    // Tamper the balance: plenty of on_hand, but reserved below the reservation qty.
    await ctx.prisma.stockBalance.updateMany({
      where: { productId: f.product.id, warehouseId: f.warehouse.id },
      data: { reserved: 2n },
    });
    await ship(ctx, f.actor.token, id, freshKey()).expect(409);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true, status: true },
    });
    expect(order.status).toBe('APPROVED');
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 100n,
      reserved: 2n,
    });
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(0);
  });

  it('21. on_hand < shipment quantity → ship 409 and full rollback', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '5', 100n);
    // Tamper the balance: on_hand below the reservation qty (reserved lowered too to
    // keep the reserved <= on_hand CHECK satisfied; the on_hand guard fires first).
    await ctx.prisma.stockBalance.updateMany({
      where: { productId: f.product.id, warehouseId: f.warehouse.id },
      data: { onHand: 3n, reserved: 3n },
    });
    await ship(ctx, f.actor.token, id, freshKey()).expect(409);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { status: true },
    });
    expect(order.status).toBe('APPROVED');
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 3n,
      reserved: 3n,
    });
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(0);
  });

  it('22+23. multi-item ship is all-or-nothing: one short line commits NO line', async () => {
    const f = await fixture(ctx);
    const p2 = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 5000n });
    await seedBalance(ctx, f.product.id, f.warehouse.id, 50n);
    await seedBalance(ctx, p2.id, f.warehouse.id, 50n);
    const created = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [
        { productId: f.product.publicId, quantity: '2' },
        { productId: p2.publicId, quantity: '4' },
      ],
    }).expect(201);
    await approve(ctx, f.actor.token, created.body.id).expect(200);
    // Drop on_hand on the SECOND line below its reserved qty (force a shortfall).
    await ctx.prisma.stockBalance.updateMany({
      where: { productId: p2.id, warehouseId: f.warehouse.id },
      data: { onHand: 1n, reserved: 1n },
    });
    await ship(ctx, f.actor.token, created.body.id as string, freshKey()).expect(409);
    // Neither line committed: first line balance untouched, no movements, order APPROVED.
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 50n,
      reserved: 2n,
    });
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(0);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: created.body.id },
      select: { id: true, status: true },
    });
    expect(order.status).toBe('APPROVED');
    expect(
      await ctx.prisma.stockReservation.count({ where: { orderId: order.id, status: 'CONSUMED' } }),
    ).toBe(0);
  });

  // --- lifecycle revalidation -----------------------------------------------

  it('27. a product deactivated after approval → ship fails 422, nothing committed', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2');
    await ctx.prisma.product.update({ where: { id: f.product.id }, data: { isActive: false } });
    const res = await ship(ctx, f.actor.token, id, freshKey()).expect(422);
    expect(res.body.code).toBe('BUSINESS_RULE');
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { status: true },
    });
    expect(order.status).toBe('APPROVED');
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 100n,
      reserved: 2n,
    });
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(0);
  });

  it('28. the warehouse deactivated after approval → ship fails, nothing committed', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2');
    await ctx.prisma.warehouse.update({ where: { id: f.warehouse.id }, data: { isActive: false } });
    // An inactive warehouse is denied by the warehouse-scope check (403) before the
    // transaction; the in-transaction FOR SHARE warehouse revalidation (422) is the
    // race net behind it. Either way the ship fails and commits nothing.
    const res = await ship(ctx, f.actor.token, id, freshKey());
    expect([403, 422]).toContain(res.status);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { status: true },
    });
    expect(order.status).toBe('APPROVED');
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(0);
  });

  // --- history + audit ------------------------------------------------------

  it('29+30. shipment appends a SHIPPED history row and an ORDER_SHIPPED audit row (same tx)', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2');
    await ship(ctx, f.actor.token, id, freshKey()).expect(200);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    const history = await ctx.prisma.orderStatusHistory.findMany({
      where: { orderId: order.id },
      orderBy: { id: 'asc' },
      select: { fromStatus: true, toStatus: true, changedById: true },
    });
    expect(history.map((h) => h.toStatus)).toEqual(['DRAFT', 'APPROVED', 'SHIPPED']);
    expect(history.at(-1)!.fromStatus).toBe('APPROVED');
    expect(history.at(-1)!.changedById).toBe(f.actor.userId);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'ORDER_SHIPPED', entityId: order.id },
    });
    expect(audit.actorId).toBe(f.actor.userId);
    expect(audit.entityType).toBe('order');
    expect(audit.requestId).toBeTruthy();
  });

  it('31. a failed ship writes NO audit, NO SHIPPED history and NO ledger', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2');
    await ctx.prisma.product.update({ where: { id: f.product.id }, data: { isActive: false } });
    await ship(ctx, f.actor.token, id, freshKey()).expect(422);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ORDER_SHIPPED', entityId: order.id } }),
    ).toBe(0);
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'SHIPPED' },
      }),
    ).toBe(0);
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(0);
  });

  // --- concurrency ----------------------------------------------------------

  it('24. concurrent same-order ship (different keys) → exactly one wins, no duplicate ledger', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2', 50n);
    const [a, b] = await Promise.all([
      ship(ctx, f.actor.token, id, freshKey()),
      ship(ctx, f.actor.token, id, freshKey()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 48n,
      reserved: 0n,
    });
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(1);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(await ctx.prisma.orderShipment.count({ where: { orderId: order.id } })).toBe(1);
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'SHIPPED' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ORDER_SHIPPED', entityId: order.id } }),
    ).toBe(1);
  });

  it('24b. concurrent same-KEY ship is a single commit (replay), never a duplicate', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '2', 50n);
    const key = freshKey();
    const [a, b] = await Promise.all([
      ship(ctx, f.actor.token, id, key),
      ship(ctx, f.actor.token, id, key),
    ]);
    // Both observe success (one commits, the other replays) — never a 409 for the
    // same key, never a duplicate movement.
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await ctx.prisma.stockLedger.count({ where: { changeType: 'SHIPMENT' } })).toBe(1);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(await ctx.prisma.orderShipment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('25. concurrent ship + stock DECREASE cannot lose an update (serialised on the balance)', async () => {
    const f = await fixture(ctx);
    const id = await approvedOrder(ctx, f, '4', 10n); // reserved 4, on_hand 10
    const [shipRes, decreaseRes] = await Promise.all([
      ship(ctx, f.actor.token, id, freshKey()),
      request(ctx.http)
        .post(`${STOCK}/adjustments`)
        .set('Authorization', `Bearer ${f.actor.token}`)
        .set('Idempotency-Key', freshKey())
        .send({
          warehouseId: f.warehouse.publicId,
          productId: f.product.publicId,
          direction: 'DECREASE',
          quantity: '6',
          reason: 'concurrent',
        }),
    ]);
    expect(shipRes.status).toBe(200);
    expect(decreaseRes.status).toBe(201);
    // Either order of serialisation lands on the same final balance: 10 − 4 (ship) −
    // 6 (decrease) = 0 on_hand, reserved fully consumed. Never negative.
    const bal = await balanceOf(ctx, f.product.id, f.warehouse.id);
    expect(bal).toEqual({ onHand: 0n, reserved: 0n });
    expect(bal!.onHand).toBeGreaterThanOrEqual(0n);
  });
});
