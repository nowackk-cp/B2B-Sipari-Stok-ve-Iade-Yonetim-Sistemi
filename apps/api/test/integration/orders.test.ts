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

const ALL_ORDER_PERMS = ['order:read', 'order:create', 'order:update', 'order:cancel'];

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Forge a validly-signed token carrying extra (fake) claims — proves the API
 * ignores JWT-supplied tenant/customer/warehouse/product and trusts only PostgreSQL. */
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
  over: Partial<{
    sku: string;
    listPriceAmount: bigint;
    currency: string;
    taxRateBp: number;
    isActive: boolean;
    deletedAt: Date | null;
  }> = {},
): Promise<{ id: bigint; publicId: string }> {
  prodSeq += 1;
  const product = await ctx.prisma.product.create({
    data: {
      companyId,
      sku: over.sku ?? `OP_${Date.now().toString(36)}_${prodSeq}`,
      name: `Order Product ${prodSeq}`,
      listPriceAmount: over.listPriceAmount ?? 10000n,
      currency: over.currency ?? 'TRY',
      taxRateBp: over.taxRateBp ?? 2000,
      isActive: over.isActive ?? true,
      deletedAt: over.deletedAt ?? null,
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

function post(ctx: TestApp, token: string, body: Record<string, unknown>): request.Test {
  return request(ctx.http).post(ORDERS).set('Authorization', `Bearer ${token}`).send(body);
}

interface Fixture {
  companyId: bigint;
  actor: Actor;
  warehouse: { id: bigint; publicId: string };
  customer: { id: bigint; publicId: string };
  product: { id: bigint; publicId: string };
}

/** Tenant + an in-scope warehouse + a customer + a priced product, with an
 * EXPLICITLY-scoped actor holding all order permissions. */
async function fixture(ctx: TestApp): Promise<Fixture> {
  const companyId = await makeTenant(ctx);
  const actor = await makeActor(ctx, companyId, ALL_ORDER_PERMS);
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

function body(f: Fixture, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: f.customer.publicId,
    warehouseId: f.warehouse.publicId,
    items: [{ productId: f.product.publicId, quantity: '2' }],
    note: 'A note',
    ...over,
  };
}

describe('Order draft foundation (integration, real PostgreSQL)', () => {
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

  // --- permission matrix ----------------------------------------------------

  it('1. create without order:create → 403', async () => {
    const f = await fixture(ctx);
    const actor = await makeActor(ctx, f.companyId, ['order:read'], { global: true });
    await post(ctx, actor.token, body(f)).expect(403);
  });

  it('1b. unauthenticated create is rejected by the global JwtAuthGuard → 401', async () => {
    await request(ctx.http).post(ORDERS).send({}).expect(401);
  });

  it('2. list/get without order:read → 403', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    const noRead = await makeActor(ctx, f.companyId, ['order:create'], { global: true });
    await request(ctx.http).get(ORDERS).set('Authorization', `Bearer ${noRead.token}`).expect(403);
    await request(ctx.http)
      .get(`${ORDERS}/${created.body.id}`)
      .set('Authorization', `Bearer ${noRead.token}`)
      .expect(403);
  });

  it('3. patch without order:update → 403', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    const noUpdate = await makeActor(ctx, f.companyId, ['order:read'], { global: true });
    await request(ctx.http)
      .patch(`${ORDERS}/${created.body.id}`)
      .set('Authorization', `Bearer ${noUpdate.token}`)
      .send({ note: 'x' })
      .expect(403);
  });

  it('4. cancel without order:cancel → 403', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    const noCancel = await makeActor(ctx, f.companyId, ['order:read'], { global: true });
    await request(ctx.http)
      .post(`${ORDERS}/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${noCancel.token}`)
      .send({})
      .expect(403);
  });

  // --- tenant isolation -----------------------------------------------------

  it('5. a body companyId (unknown field) is rejected → 400', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    await post(ctx, f.actor.token, body(f, { companyId: b.toString() })).expect(400);
  });

  it('6. forged company/customer/warehouse/product claims do not change the result', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const prodB = await createPricedProduct(ctx, b);
    const forged = forgeTokenFrom(ctx, f.actor.token, {
      companyId: b.toString(),
      customerId: 'deadbeef',
      warehouseId: '999',
      productId: prodB.id.toString(),
    });
    // Forged tenant cannot reach B's product…
    await post(
      ctx,
      forged,
      body(f, { items: [{ productId: prodB.publicId, quantity: '1' }] }),
    ).expect(404);
    // …and still operates correctly within A.
    await post(ctx, forged, body(f)).expect(201);
  });

  it('7. cross-company customer → 404', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const custB = await createCustomer(ctx.prisma, b, { code: 'BC' });
    await post(ctx, f.actor.token, body(f, { customerId: custB.publicId })).expect(404);
  });

  it('8. cross-company product → 404', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const prodB = await createPricedProduct(ctx, b);
    await post(
      ctx,
      f.actor.token,
      body(f, { items: [{ productId: prodB.publicId, quantity: '1' }] }),
    ).expect(404);
  });

  it('9. cross-company warehouse → 404', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const whB = await createWarehouse(ctx.prisma, b, { code: 'BW' });
    await post(
      ctx,
      f.actor.token,
      body(f, { warehouseId: await warehousePublicId(ctx, whB.id) }),
    ).expect(404);
  });

  // --- warehouse scope ------------------------------------------------------

  it('10. no warehouse scope → create 403', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_ORDER_PERMS); // no scope grant
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const customer = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    const product = await createPricedProduct(ctx, companyId);
    await post(ctx, actor.token, {
      customerId: customer.publicId,
      warehouseId: await warehousePublicId(ctx, wh.id),
      items: [{ productId: product.publicId, quantity: '1' }],
    }).expect(403);
  });

  it('11. explicit warehouse scope → create succeeds', async () => {
    const f = await fixture(ctx);
    const res = await post(ctx, f.actor.token, body(f)).expect(201);
    expect(res.body).toMatchObject({
      customerId: f.customer.publicId,
      warehouseId: f.warehouse.publicId,
      status: 'DRAFT',
    });
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.orderNo).toBe('string');
  });

  it('12. warehouse:scope:all in the same company → create succeeds', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ALL_ORDER_PERMS, { global: true });
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const customer = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    const product = await createPricedProduct(ctx, companyId);
    await post(ctx, actor.token, {
      customerId: customer.publicId,
      warehouseId: await warehousePublicId(ctx, wh.id),
      items: [{ productId: product.publicId, quantity: '1' }],
    }).expect(201);
  });

  // --- validation -----------------------------------------------------------

  it('13. at least one item is required → 400', async () => {
    const f = await fixture(ctx);
    await post(ctx, f.actor.token, body(f, { items: [] })).expect(400);
  });

  it('14. invalid quantities (0, negative, decimal, empty, over-BIGINT) → 400 RFC7807', async () => {
    const f = await fixture(ctx);
    const bad = ['0', '-1', '2.5', '', '9223372036854775808', 'abc'];
    for (const quantity of bad) {
      const res = await post(
        ctx,
        f.actor.token,
        body(f, { items: [{ productId: f.product.publicId, quantity }] }),
      ).expect(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    }
  });

  it('15. a client-supplied unit price on a line is rejected (mass-assignment) → 400', async () => {
    const f = await fixture(ctx);
    await post(
      ctx,
      f.actor.token,
      body(f, {
        items: [
          {
            productId: f.product.publicId,
            quantity: '1',
            unitPrice: { amount: '1', currency: 'TRY' },
          },
        ],
      }),
    ).expect(400);
  });

  it('16. mixed-currency lines → 400', async () => {
    const f = await fixture(ctx);
    const usd = await createPricedProduct(ctx, f.companyId, {
      currency: 'USD',
      listPriceAmount: 500n,
    });
    await post(
      ctx,
      f.actor.token,
      body(f, {
        items: [
          { productId: f.product.publicId, quantity: '1' },
          { productId: usd.publicId, quantity: '1' },
        ],
      }),
    ).expect(400);
  });

  it('17. a body total/subtotal field is rejected → 400', async () => {
    const f = await fixture(ctx);
    await post(ctx, f.actor.token, body(f, { total: '1' })).expect(400);
    await post(ctx, f.actor.token, body(f, { subtotal: '1' })).expect(400);
  });

  // --- totals + lifecycle ---------------------------------------------------

  it('18. create produces correct server-computed subtotal/vat/total', async () => {
    const f = await fixture(ctx); // listPrice 10000, taxRateBp 2000 (20%), qty 2
    const res = await post(ctx, f.actor.token, body(f)).expect(201);
    expect(res.body.currency).toBe('TRY');
    expect(res.body.subtotal).toEqual({ amount: '20000', currency: 'TRY' });
    expect(res.body.vat).toEqual({ amount: '4000', currency: 'TRY' });
    expect(res.body.total).toEqual({ amount: '24000', currency: 'TRY' });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      productId: f.product.publicId,
      quantity: '2',
      vatRate: 2000,
      unitPrice: { amount: '10000', currency: 'TRY' },
      lineSubtotal: { amount: '20000', currency: 'TRY' },
      lineVat: { amount: '4000', currency: 'TRY' },
      lineTotal: { amount: '24000', currency: 'TRY' },
    });
  });

  it('19. update replaces draft items and recomputes totals', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    const p2 = await createPricedProduct(ctx, f.companyId, {
      listPriceAmount: 5000n,
      taxRateBp: 1000,
    });
    const res = await request(ctx.http)
      .patch(`${ORDERS}/${created.body.id}`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({ items: [{ productId: p2.publicId, quantity: '3' }], note: 'changed' })
      .expect(200);
    // 5000 * 3 = 15000 subtotal; vat = floor(15000 * 1000/10000) = 1500; total 16500.
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].productId).toBe(p2.publicId);
    expect(res.body.subtotal.amount).toBe('15000');
    expect(res.body.vat.amount).toBe('1500');
    expect(res.body.total.amount).toBe('16500');
    expect(res.body.note).toBe('changed');
  });

  it('20. a non-DRAFT order cannot be patched → 409', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    await request(ctx.http)
      .post(`${ORDERS}/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(200);
    await request(ctx.http)
      .patch(`${ORDERS}/${created.body.id}`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({ note: 'nope' })
      .expect(409);
  });

  it('21. cancel transitions a DRAFT order to CANCELLED', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    const res = await request(ctx.http)
      .post(`${ORDERS}/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({ reason: 'changed mind' })
      .expect(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.cancelledAt).toBeTruthy();
    const history = await ctx.prisma.orderStatusHistory.findMany({
      where: { order: { publicId: created.body.id } },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => h.toStatus)).toEqual(['DRAFT', 'CANCELLED']);
  });

  it('22. cancel writes no stock ledger or balance row', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    await request(ctx.http)
      .post(`${ORDERS}/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(200);
    expect(await ctx.prisma.stockLedger.count()).toBe(0);
    expect(await ctx.prisma.stockBalance.count()).toBe(0);
    expect(await ctx.prisma.stockReservation.count()).toBe(0);
  });

  it('23. a cancelled order cannot be cancelled again → 409', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    const cancel = () =>
      request(ctx.http)
        .post(`${ORDERS}/${created.body.id}/cancel`)
        .set('Authorization', `Bearer ${f.actor.token}`)
        .send({});
    await cancel().expect(200);
    await cancel().expect(409);
  });

  it('24. cross-company get/update/cancel → 404', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ALL_ORDER_PERMS, { global: true });
    const id = created.body.id as string;
    await request(ctx.http)
      .get(`${ORDERS}/${id}`)
      .set('Authorization', `Bearer ${bActor.token}`)
      .expect(404);
    await request(ctx.http)
      .patch(`${ORDERS}/${id}`)
      .set('Authorization', `Bearer ${bActor.token}`)
      .send({ note: 'x' })
      .expect(404);
    await request(ctx.http)
      .post(`${ORDERS}/${id}/cancel`)
      .set('Authorization', `Bearer ${bActor.token}`)
      .send({})
      .expect(404);
  });

  it('25. list is warehouse-scope filtered', async () => {
    const companyId = await makeTenant(ctx);
    const admin = await makeActor(ctx, companyId, ALL_ORDER_PERMS, { global: true });
    const whA = await createWarehouse(ctx.prisma, companyId, { code: 'A' });
    const whB = await createWarehouse(ctx.prisma, companyId, { code: 'B' });
    const customer = await createCustomer(ctx.prisma, companyId, { code: 'C' });
    const product = await createPricedProduct(ctx, companyId);
    const mk = async (whId: bigint) =>
      post(ctx, admin.token, {
        customerId: customer.publicId,
        warehouseId: await warehousePublicId(ctx, whId),
        items: [{ productId: product.publicId, quantity: '1' }],
      }).expect(201);
    await mk(whA.id);
    await mk(whB.id);

    // An actor scoped only to A sees just the A order.
    const scoped = await makeActor(ctx, companyId, ['order:read']);
    await assignWarehouseScope(ctx.prisma, scoped.userId, whA.id, companyId);
    const list = await request(ctx.http)
      .get(ORDERS)
      .set('Authorization', `Bearer ${scoped.token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].warehouseId).toBe(await warehousePublicId(ctx, whA.id));

    // A scopeless actor sees nothing.
    const none = await makeActor(ctx, companyId, ['order:read']);
    const empty = await request(ctx.http)
      .get(ORDERS)
      .set('Authorization', `Bearer ${none.token}`)
      .expect(200);
    expect(empty.body.data).toHaveLength(0);

    // The global admin sees both.
    const all = await request(ctx.http)
      .get(ORDERS)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(all.body.data).toHaveLength(2);
  });

  it('26. soft-deleted/inactive customer, product or warehouse → create rejected (404)', async () => {
    const f = await fixture(ctx);
    // soft-deleted customer
    const delCustomer = await createCustomer(ctx.prisma, f.companyId, {
      code: 'DEL',
      deletedAt: new Date(),
    });
    await post(ctx, f.actor.token, body(f, { customerId: delCustomer.publicId })).expect(404);
    // inactive product
    const inactiveProduct = await createPricedProduct(ctx, f.companyId, { isActive: false });
    await post(
      ctx,
      f.actor.token,
      body(f, { items: [{ productId: inactiveProduct.publicId, quantity: '1' }] }),
    ).expect(404);
    // soft-deleted warehouse (also drops scope target → still 404, entity hiding before scope)
    const delWh = await createWarehouse(ctx.prisma, f.companyId, {
      code: 'DWH',
      deletedAt: new Date(),
    });
    await assignWarehouseScope(ctx.prisma, f.actor.userId, delWh.id, f.companyId);
    await post(
      ctx,
      f.actor.token,
      body(f, { warehouseId: await warehousePublicId(ctx, delWh.id) }),
    ).expect(404);
  });

  // --- audit + RFC7807 ------------------------------------------------------

  it('27. create/update/cancel each write a same-transaction business audit row', async () => {
    const f = await fixture(ctx);
    const created = await post(ctx, f.actor.token, body(f)).expect(201);
    await request(ctx.http)
      .patch(`${ORDERS}/${created.body.id}`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({ note: 'edited' })
      .expect(200);
    await request(ctx.http)
      .post(`${ORDERS}/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({})
      .expect(200);

    for (const action of ['ORDER_CREATED', 'ORDER_UPDATED', 'ORDER_CANCELLED']) {
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action } });
      expect(audit.actorId).toBe(f.actor.userId);
      expect(audit.entityType).toBe('order');
      expect(audit.requestId).toBeTruthy();
    }
  });

  it('28. a not-found order returns RFC7807 problem+json with a requestId', async () => {
    const f = await fixture(ctx);
    const res = await request(ctx.http)
      .get(`${ORDERS}/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(res.body.requestId).toBeTruthy();
  });
});
