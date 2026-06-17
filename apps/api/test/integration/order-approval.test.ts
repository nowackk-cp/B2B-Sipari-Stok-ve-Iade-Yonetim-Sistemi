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

/** Every order permission (incl. approve) plus the stock permissions the
 * approve-vs-mutation race tests need. */
const ALL_PERMS = [
  'order:read',
  'order:create',
  'order:update',
  'order:cancel',
  'order:approve',
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

/** Create a priced, active product in `companyId` (server pricing reads these). */
async function createPricedProduct(
  ctx: TestApp,
  companyId: bigint,
  over: Partial<{ sku: string; listPriceAmount: bigint; taxRateBp: number }> = {},
): Promise<{ id: bigint; publicId: string }> {
  prodSeq += 1;
  const product = await ctx.prisma.product.create({
    data: {
      companyId,
      sku: over.sku ?? `AP_${Date.now().toString(36)}_${prodSeq}`,
      name: `Approve Product ${prodSeq}`,
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

/** Seed a starting (on_hand, reserved) balance for (product, warehouse) directly. */
async function seedBalance(
  ctx: TestApp,
  productId: bigint,
  warehouseId: bigint,
  onHand: bigint,
  reserved = 0n,
): Promise<void> {
  await ctx.prisma.stockBalance.create({
    data: { productId, warehouseId, onHand, reserved },
  });
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

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `akey_${Date.now().toString(36)}_${keySeq}`;
}

interface Fixture {
  companyId: bigint;
  actor: Actor;
  warehouse: { id: bigint; publicId: string };
  customer: { id: bigint; publicId: string };
  product: { id: bigint; publicId: string };
}

/** Tenant + an in-scope warehouse + a customer + a priced product, with an
 * EXPLICITLY-scoped actor holding all order + stock permissions. */
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

/** Create a DRAFT order for the fixture's product (default qty 2). Returns its public id. */
async function draftOrder(ctx: TestApp, f: Fixture, quantity = '2'): Promise<string> {
  const res = await createOrder(ctx, f.actor.token, {
    customerId: f.customer.publicId,
    warehouseId: f.warehouse.publicId,
    items: [{ productId: f.product.publicId, quantity }],
  }).expect(201);
  return res.body.id as string;
}

describe('Order approval + stock reservation foundation (integration, real PostgreSQL)', () => {
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

  it('1. approve without order:approve → 403', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    const noApprove = await makeActor(ctx, f.companyId, ['order:read'], { global: true });
    await approve(ctx, noApprove.token, id).expect(403);
  });

  it('1b. unauthenticated approve is rejected by the global JwtAuthGuard → 401', async () => {
    await request(ctx.http)
      .post(`${ORDERS}/00000000-0000-0000-0000-000000000000/approve`)
      .send({})
      .expect(401);
  });

  it('2. approving a DRAFT order succeeds → status APPROVED', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    const res = await approve(ctx, f.actor.token, id).expect(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approvedAt).toBeTruthy();
  });

  it('3. approving an already-APPROVED order → 409', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await approve(ctx, f.actor.token, id).expect(200);
    await approve(ctx, f.actor.token, id).expect(409);
  });

  it('4. approving a CANCELLED order → 409', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await request(ctx.http)
      .post(`${ORDERS}/${id}/cancel`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(200);
    await approve(ctx, f.actor.token, id).expect(409);
  });

  // --- tenant + scope -------------------------------------------------------

  it('5. cross-company approve → 404', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await approve(ctx, bActor.token, id).expect(404);
  });

  it('6. approve without warehouse scope → 404 (object-level entity hiding)', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    // Same tenant, has order:approve, but NO scope to the order's warehouse.
    const scopeless = await makeActor(ctx, f.companyId, ALL_PERMS);
    await approve(ctx, scopeless.token, id).expect(404);
  });

  it('7. explicit warehouse scope → approve succeeds', async () => {
    const f = await fixture(ctx); // actor already explicitly scoped to the warehouse
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await approve(ctx, f.actor.token, id).expect(200);
  });

  it('8. warehouse:scope:all in the same company → approve succeeds', async () => {
    const companyId = await makeTenant(ctx);
    const author = await makeActor(ctx, companyId, ALL_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const customer = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    const product = await createPricedProduct(ctx, companyId);
    await ctx.prisma.stockBalance.create({
      data: { productId: product.id, warehouseId: wh.id, onHand: 100n, reserved: 0n },
    });
    const created = await createOrder(ctx, author.token, {
      customerId: customer.publicId,
      warehouseId: await warehousePublicId(ctx, wh.id),
      items: [{ productId: product.publicId, quantity: '3' }],
    }).expect(201);
    await approve(ctx, author.token, created.body.id).expect(200);
  });

  it('9. another company’s warehouse:scope:all cannot approve this order (no bypass) → 404', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    const b = await makeTenant(ctx, 'B');
    const bGlobal = await makeActor(ctx, b, ALL_PERMS, { global: true });
    await approve(ctx, bGlobal.token, id).expect(404);
    // Forged company/warehouse claims do not change the result either.
    const forged = forgeTokenFrom(ctx, bGlobal.token, {
      companyId: f.companyId.toString(),
      warehouseId: f.warehouse.id.toString(),
    });
    await approve(ctx, forged, id).expect(404);
  });

  // --- reservation effect ---------------------------------------------------

  it('10. sufficient available stock → reserved increases by the ordered quantity', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 10n);
    const id = await draftOrder(ctx, f, '4');
    await approve(ctx, f.actor.token, id).expect(200);
    const bal = await balanceOf(ctx, f.product.id, f.warehouse.id);
    expect(bal).toEqual({ onHand: 10n, reserved: 4n });
    const reservations = await ctx.prisma.stockReservation.findMany({
      where: { order: { publicId: id } },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe('ACTIVE');
    expect(reservations[0]?.quantity).toBe(4n);
  });

  it('11. insufficient available stock → 409 and nothing changes', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 3n);
    const id = await draftOrder(ctx, f, '5');
    await approve(ctx, f.actor.token, id).expect(409);
    // Order stays DRAFT; balance untouched; no reservation; no status history append.
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true, status: true, approvedAt: true },
    });
    expect(order.status).toBe('DRAFT');
    expect(order.approvedAt).toBeNull();
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 3n,
      reserved: 0n,
    });
    expect(await ctx.prisma.stockReservation.count({ where: { orderId: order.id } })).toBe(0);
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'APPROVED' },
      }),
    ).toBe(0);
  });

  it('11b. no balance row at all (available = 0) → 409 INSUFFICIENT, nothing reserved', async () => {
    const f = await fixture(ctx); // no seedBalance — the balance row does not exist
    const id = await draftOrder(ctx, f, '1');
    await approve(ctx, f.actor.token, id).expect(409);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { status: true },
    });
    expect(order.status).toBe('DRAFT');
    expect(await ctx.prisma.stockReservation.count()).toBe(0);
  });

  it('12. on_hand is NOT decreased by approval', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 30n);
    const id = await draftOrder(ctx, f, '7');
    await approve(ctx, f.actor.token, id).expect(200);
    const bal = await balanceOf(ctx, f.product.id, f.warehouse.id);
    expect(bal?.onHand).toBe(30n); // unchanged
    expect(bal?.reserved).toBe(7n);
  });

  it('13. approval writes NO stock_ledger movement (a reservation is not physical)', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 50n);
    const id = await draftOrder(ctx, f, '5');
    await approve(ctx, f.actor.token, id).expect(200);
    expect(await ctx.prisma.stockLedger.count()).toBe(0);
  });

  it('14. a multi-item order reserves every line', async () => {
    const f = await fixture(ctx);
    const p2 = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 5000n });
    const p3 = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 7000n });
    await seedBalance(ctx, f.product.id, f.warehouse.id, 10n);
    await seedBalance(ctx, p2.id, f.warehouse.id, 10n);
    await seedBalance(ctx, p3.id, f.warehouse.id, 10n);
    const created = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [
        { productId: f.product.publicId, quantity: '2' },
        { productId: p2.publicId, quantity: '3' },
        { productId: p3.publicId, quantity: '4' },
      ],
    }).expect(201);
    await approve(ctx, f.actor.token, created.body.id).expect(200);
    expect((await balanceOf(ctx, f.product.id, f.warehouse.id))?.reserved).toBe(2n);
    expect((await balanceOf(ctx, p2.id, f.warehouse.id))?.reserved).toBe(3n);
    expect((await balanceOf(ctx, p3.id, f.warehouse.id))?.reserved).toBe(4n);
    expect(
      await ctx.prisma.stockReservation.count({ where: { order: { publicId: created.body.id } } }),
    ).toBe(3);
  });

  it('15. if ONE line is short, NO line is reserved (all-or-nothing)', async () => {
    const f = await fixture(ctx);
    const p2 = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 5000n });
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n); // plenty
    await seedBalance(ctx, p2.id, f.warehouse.id, 1n); // short for qty 3
    const created = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [
        { productId: f.product.publicId, quantity: '2' },
        { productId: p2.publicId, quantity: '3' },
      ],
    }).expect(201);
    await approve(ctx, f.actor.token, created.body.id).expect(409);
    // Neither line moved; order still DRAFT; no reservation rows at all.
    expect((await balanceOf(ctx, f.product.id, f.warehouse.id))?.reserved).toBe(0n);
    expect((await balanceOf(ctx, p2.id, f.warehouse.id))?.reserved).toBe(0n);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: created.body.id },
      select: { id: true, status: true },
    });
    expect(order.status).toBe('DRAFT');
    expect(await ctx.prisma.stockReservation.count({ where: { orderId: order.id } })).toBe(0);
  });

  // --- concurrency ----------------------------------------------------------

  it('16. concurrent approve of the SAME order does not double-reserve', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f, '2');
    const [a, b] = await Promise.all([
      approve(ctx, f.actor.token, id),
      approve(ctx, f.actor.token, id),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]); // exactly one transition wins
    // Reserved increased exactly once; exactly one reservation row exists.
    expect((await balanceOf(ctx, f.product.id, f.warehouse.id))?.reserved).toBe(2n);
    expect(await ctx.prisma.stockReservation.count({ where: { order: { publicId: id } } })).toBe(1);
    // Exactly one APPROVED history row and one ORDER_APPROVED audit row.
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'APPROVED' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ORDER_APPROVED', entityId: order.id } }),
    ).toBe(1);
  });

  it('17. concurrent approve + stock DECREASE cannot exceed available (serialised to the boundary)', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 10n);
    const id = await draftOrder(ctx, f, '6');
    const [approveRes, decreaseRes] = await Promise.all([
      approve(ctx, f.actor.token, id),
      request(ctx.http)
        .post(`${STOCK}/adjustments`)
        .set('Authorization', `Bearer ${f.actor.token}`)
        .set('Idempotency-Key', freshKey())
        .send({
          warehouseId: f.warehouse.publicId,
          productId: f.product.publicId,
          direction: 'DECREASE',
          quantity: '4',
          reason: 'concurrent',
        }),
    ]);
    // Both operations succeed because they serialise on the balance row lock and
    // the result stays valid in either order (10−4 on_hand ≥ 6 reserved).
    expect(approveRes.status).toBe(200);
    expect(decreaseRes.status).toBe(201);
    const bal = await balanceOf(ctx, f.product.id, f.warehouse.id);
    expect(bal).toEqual({ onHand: 6n, reserved: 6n }); // available = 0, never negative
    expect(bal!.onHand - bal!.reserved).toBeGreaterThanOrEqual(0n);
  });

  it('18. concurrent approve + TRANSFER-out cannot exceed available (serialised to the boundary)', async () => {
    const f = await fixture(ctx);
    const dest = await createWarehouse(ctx.prisma, f.companyId, { code: 'DEST' });
    await assignWarehouseScope(ctx.prisma, f.actor.userId, dest.id, f.companyId);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 10n);
    const id = await draftOrder(ctx, f, '6');
    const [approveRes, transferRes] = await Promise.all([
      approve(ctx, f.actor.token, id),
      request(ctx.http)
        .post(`${STOCK}/transfers`)
        .set('Authorization', `Bearer ${f.actor.token}`)
        .set('Idempotency-Key', freshKey())
        .send({
          fromWarehouseId: f.warehouse.publicId,
          toWarehouseId: await warehousePublicId(ctx, dest.id),
          productId: f.product.publicId,
          quantity: '4',
          reason: 'concurrent',
        }),
    ]);
    expect(approveRes.status).toBe(200);
    expect(transferRes.status).toBe(201);
    const src = await balanceOf(ctx, f.product.id, f.warehouse.id);
    expect(src).toEqual({ onHand: 6n, reserved: 6n }); // available = 0, never negative
    expect(src!.onHand - src!.reserved).toBeGreaterThanOrEqual(0n);
    // The transfer moved 4 to the destination (reserved untouched there).
    expect((await balanceOf(ctx, f.product.id, dest.id))?.onHand).toBe(4n);
  });

  // --- history + audit ------------------------------------------------------

  it('19. approval appends an APPROVED order_status_history row', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await approve(ctx, f.actor.token, id).expect(200);
    const history = await ctx.prisma.orderStatusHistory.findMany({
      where: { order: { publicId: id } },
      orderBy: { id: 'asc' },
      select: { fromStatus: true, toStatus: true, changedById: true },
    });
    expect(history.map((h) => h.toStatus)).toEqual(['DRAFT', 'APPROVED']);
    const approved = history.at(-1)!;
    expect(approved.fromStatus).toBe('DRAFT');
    expect(approved.changedById).toBe(f.actor.userId);
  });

  it('20. approval writes a same-transaction ORDER_APPROVED business audit row', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    await approve(ctx, f.actor.token, id).expect(200);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'ORDER_APPROVED', entityId: order.id },
    });
    expect(audit.actorId).toBe(f.actor.userId);
    expect(audit.entityType).toBe('order');
    expect(audit.requestId).toBeTruthy();
  });

  it('21+22. a failed (insufficient-stock) approve writes NO audit and NO status history', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 1n);
    const id = await draftOrder(ctx, f, '9');
    await approve(ctx, f.actor.token, id).expect(409);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true },
    });
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ORDER_APPROVED', entityId: order.id } }),
    ).toBe(0);
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'APPROVED' },
      }),
    ).toBe(0);
  });

  // --- non-regression of the DRAFT slice ------------------------------------

  it('23. an APPROVED order cannot be PATCHed → 409 (and its content is untouched)', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f, '2');
    await approve(ctx, f.actor.token, id).expect(200);
    const p2 = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 5000n });
    await request(ctx.http)
      .patch(`${ORDERS}/${id}`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({ note: 'nope', items: [{ productId: p2.publicId, quantity: '9' }] })
      .expect(409);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { status: true, items: { select: { quantity: true } } },
    });
    expect(order.status).toBe('APPROVED');
    expect(order.items.map((i) => i.quantity)).toEqual([2n]); // unchanged
  });

  it('24. DRAFT cancel still works unchanged (no stock effect)', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f);
    const res = await request(ctx.http)
      .post(`${ORDERS}/${id}/cancel`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({ reason: 'changed mind' })
      .expect(200);
    expect(res.body.status).toBe('CANCELLED');
    // A DRAFT cancel reserves nothing and the seeded balance is untouched.
    expect(await ctx.prisma.stockReservation.count()).toBe(0);
    expect((await balanceOf(ctx, f.product.id, f.warehouse.id))?.reserved).toBe(0n);
  });

  // --- product lifecycle revalidation at approve (ORDER_RULES / ORD-10, T-08) ---
  // A product made inactive or soft-deleted while the order is still DRAFT must
  // make approve fail with 422 and NO reservation. The reservation balance is left
  // generous so the ONLY reason approve can fail in these cases is the product.

  it('25. product deactivated after the draft → approve 422, nothing reserved', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f, '2');
    await ctx.prisma.product.update({ where: { id: f.product.id }, data: { isActive: false } });

    const res = await approve(ctx, f.actor.token, id).expect(422);
    expect(res.body.code).toBe('BUSINESS_RULE');
    expect(res.body.requestId).toBeTruthy();

    // Order stays DRAFT; balance/reservation/history/audit all unchanged.
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true, status: true, approvedAt: true },
    });
    expect(order.status).toBe('DRAFT');
    expect(order.approvedAt).toBeNull();
    expect(await balanceOf(ctx, f.product.id, f.warehouse.id)).toEqual({
      onHand: 100n,
      reserved: 0n,
    });
    expect(await ctx.prisma.stockReservation.count({ where: { orderId: order.id } })).toBe(0);
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'APPROVED' },
      }),
    ).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ORDER_APPROVED', entityId: order.id } }),
    ).toBe(0);
  });

  it('26. product soft-deleted after the draft → approve 422, nothing reserved', async () => {
    const f = await fixture(ctx);
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    const id = await draftOrder(ctx, f, '2');
    await ctx.prisma.product.update({
      where: { id: f.product.id },
      data: { deletedAt: new Date() },
    });

    const res = await approve(ctx, f.actor.token, id).expect(422);
    expect(res.body.code).toBe('BUSINESS_RULE');

    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: id },
      select: { id: true, status: true },
    });
    expect(order.status).toBe('DRAFT');
    expect((await balanceOf(ctx, f.product.id, f.warehouse.id))?.reserved).toBe(0n);
    expect(await ctx.prisma.stockReservation.count({ where: { orderId: order.id } })).toBe(0);
    expect(
      await ctx.prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'APPROVED' },
      }),
    ).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ORDER_APPROVED', entityId: order.id } }),
    ).toBe(0);
  });

  it('27. multi-item order: ONE product inactive ⇒ NO line is reserved (all-or-nothing)', async () => {
    const f = await fixture(ctx);
    const p2 = await createPricedProduct(ctx, f.companyId, { listPriceAmount: 5000n });
    await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
    await seedBalance(ctx, p2.id, f.warehouse.id, 100n);
    const created = await createOrder(ctx, f.actor.token, {
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      items: [
        { productId: f.product.publicId, quantity: '2' },
        { productId: p2.publicId, quantity: '3' },
      ],
    }).expect(201);
    // Deactivate the SECOND line's product after the draft.
    await ctx.prisma.product.update({ where: { id: p2.id }, data: { isActive: false } });

    await approve(ctx, f.actor.token, created.body.id).expect(422);
    // Neither line moved; order still DRAFT; no reservation rows at all.
    expect((await balanceOf(ctx, f.product.id, f.warehouse.id))?.reserved).toBe(0n);
    expect((await balanceOf(ctx, p2.id, f.warehouse.id))?.reserved).toBe(0n);
    const order = await ctx.prisma.order.findUniqueOrThrow({
      where: { publicId: created.body.id },
      select: { id: true, status: true },
    });
    expect(order.status).toBe('DRAFT');
    expect(await ctx.prisma.stockReservation.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('28. concurrent product deactivate vs approve: no inactive product is ever reserved', async () => {
    // Run the race several times. Whichever side wins the product row lock, exactly
    // one of two serialised outcomes must hold (never a half state): approve wins and
    // reserves a then-active product, or the deactivate wins and approve fails 422
    // with nothing reserved.
    for (let i = 0; i < 6; i += 1) {
      const f = await fixture(ctx);
      await seedBalance(ctx, f.product.id, f.warehouse.id, 100n);
      const id = await draftOrder(ctx, f, '2');

      const [approveRes] = await Promise.all([
        approve(ctx, f.actor.token, id),
        ctx.prisma.product.update({ where: { id: f.product.id }, data: { isActive: false } }),
      ]);

      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { publicId: id },
        select: { id: true, status: true },
      });
      const reservations = await ctx.prisma.stockReservation.count({
        where: { orderId: order.id, status: 'ACTIVE' },
      });
      const reserved = (await balanceOf(ctx, f.product.id, f.warehouse.id))?.reserved ?? 0n;

      // Exactly one of two serialised outcomes — never a half state. (The deactivate
      // always commits eventually, so the product ends inactive either way; what
      // matters is whether approve created its reservation BEFORE that, under lock.)
      if (approveRes.status === 200) {
        // Approve won the product lock: it committed while the product was still
        // active, so its reservation is valid and the order is APPROVED.
        expect(order.status).toBe('APPROVED');
        expect(reservations).toBe(1);
        expect(reserved).toBe(2n);
      } else {
        // Deactivate won: approve must fail (422) with the order left DRAFT and
        // absolutely no reservation for the now-inactive product.
        expect(approveRes.status).toBe(422);
        expect(order.status).toBe('DRAFT');
        expect(reservations).toBe(0);
        expect(reserved).toBe(0n);
      }
    }
  }, 60000);
});
