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
  createProduct,
  createTestApp,
  createUser,
  createWarehouse,
  grantPermissionsViaRole,
  resetState,
  seedRbac,
} from './helpers';

const BASE = '/api/v1';
const AUTH = `${BASE}/auth`;
const STOCK = `${BASE}/stock`;

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Forge a validly-signed token carrying extra (fake) claims — proves the API
 * ignores JWT-supplied tenant/warehouse/product and trusts only PostgreSQL. */
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

/** A fresh tenant with its own seeded RBAC (no pre-seeded MAIN warehouse → clean counts). */
async function makeTenant(ctx: TestApp, name?: string): Promise<bigint> {
  const company = await createCompany(ctx.prisma, name);
  await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, company));
  return company;
}

interface Actor {
  token: string;
  userId: bigint;
}

/** Create a user in `companyId` with `perms` (plus optional global scope) and log in. */
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

async function warehousePublicId(ctx: TestApp, id: bigint): Promise<string> {
  const wh = await ctx.prisma.warehouse.findUniqueOrThrow({
    where: { id },
    select: { publicId: true },
  });
  return wh.publicId;
}

function adjust(
  ctx: TestApp,
  token: string,
  body: Record<string, unknown>,
  key: string,
): request.Test {
  return request(ctx.http)
    .post(`${STOCK}/adjustments`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body);
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `idem_${Date.now().toString(36)}_${keySeq}`;
}

/** Stand up a tenant + an in-scope warehouse + a product, with a global-scope
 * actor holding both stock permissions. The common happy-path fixture. */
async function fixture(ctx: TestApp): Promise<{
  companyId: bigint;
  actor: Actor;
  warehouse: { id: bigint; publicId: string };
  product: { id: bigint; publicId: string };
}> {
  const companyId = await makeTenant(ctx);
  const actor = await makeActor(ctx, companyId, ['stock:read', 'stock:adjust'], { global: true });
  const wh = await createWarehouse(ctx.prisma, companyId, { code: 'WH-1' });
  const product = await createProduct(ctx.prisma, companyId, { sku: 'SKU-1' });
  return {
    companyId,
    actor,
    warehouse: { id: wh.id, publicId: await warehousePublicId(ctx, wh.id) },
    product: { id: product.id, publicId: product.publicId },
  };
}

async function onHand(
  ctx: TestApp,
  productId: bigint,
  warehouseId: bigint,
): Promise<bigint | null> {
  const bal = await ctx.prisma.stockBalance.findFirst({
    where: { productId, warehouseId },
    select: { onHand: true },
  });
  return bal?.onHand ?? null;
}

describe('Stock ledger foundation (integration, real PostgreSQL)', () => {
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

  it('1. balances cannot be read without stock:read → 403', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, [], { global: true }); // no stock:read
    await request(ctx.http)
      .get(`${STOCK}/balances`)
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(403);
  });

  it('1b. an unauthenticated request is rejected by the global JwtAuthGuard → 401', async () => {
    await request(ctx.http).get(`${STOCK}/balances`).expect(401);
  });

  it('2. an adjustment cannot be made without stock:adjust → 403', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ['stock:read'], { global: true }); // no adjust
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const product = await createProduct(ctx.prisma, companyId);
    await adjust(
      ctx,
      actor.token,
      {
        warehouseId: await warehousePublicId(ctx, wh.id),
        productId: product.publicId,
        direction: 'INCREASE',
        quantity: '5',
        reason: 'x',
      },
      freshKey(),
    ).expect(403);
  });

  it('3. base permission but NO warehouse scope → safe behavior (empty balances; adjust 403)', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ['stock:read', 'stock:adjust']); // no scope
    const wh = await createWarehouse(ctx.prisma, companyId, { code: 'W' });
    const product = await createProduct(ctx.prisma, companyId);

    const list = await request(ctx.http)
      .get(`${STOCK}/balances`)
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);

    await adjust(
      ctx,
      actor.token,
      {
        warehouseId: await warehousePublicId(ctx, wh.id),
        productId: product.publicId,
        direction: 'INCREASE',
        quantity: '5',
        reason: 'x',
      },
      freshKey(),
    ).expect(403);
  });

  it('4. explicit warehouse scope → only that warehouse’s balances are read', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ['stock:read', 'stock:adjust']);
    const scoped = await createWarehouse(ctx.prisma, companyId, { code: 'SCOPED' });
    const other = await createWarehouse(ctx.prisma, companyId, { code: 'OTHER' });
    await assignWarehouseScope(ctx.prisma, actor.userId, scoped.id, companyId);
    const product = await createProduct(ctx.prisma, companyId);

    // Seed both warehouses' balances with a global admin so they exist.
    const admin = await makeActor(ctx, companyId, ['stock:adjust'], { global: true });
    for (const wh of [scoped, other]) {
      await adjust(
        ctx,
        admin.token,
        {
          warehouseId: await warehousePublicId(ctx, wh.id),
          productId: product.publicId,
          direction: 'INCREASE',
          quantity: '7',
          reason: 'seed',
        },
        freshKey(),
      ).expect(201);
    }

    const list = await request(ctx.http)
      .get(`${STOCK}/balances`)
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].warehouseId).toBe(await warehousePublicId(ctx, scoped.id));
  });

  it('5. warehouse:scope:all → every same-company balance is read', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ['stock:read', 'stock:adjust'], { global: true });
    const w1 = await createWarehouse(ctx.prisma, companyId, { code: 'W1' });
    const w2 = await createWarehouse(ctx.prisma, companyId, { code: 'W2' });
    const product = await createProduct(ctx.prisma, companyId);
    for (const wh of [w1, w2]) {
      await adjust(
        ctx,
        actor.token,
        {
          warehouseId: await warehousePublicId(ctx, wh.id),
          productId: product.publicId,
          direction: 'INCREASE',
          quantity: '3',
          reason: 'seed',
        },
        freshKey(),
      ).expect(201);
    }

    const list = await request(ctx.http)
      .get(`${STOCK}/balances`)
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(2);
  });

  it('6. another company’s balances are never visible (scope:all stays in-tenant)', async () => {
    const a = await makeTenant(ctx, 'A');
    const actor = await makeActor(ctx, a, ['stock:read', 'stock:adjust'], { global: true });
    const whA = await createWarehouse(ctx.prisma, a, { code: 'A-1' });
    const prodA = await createProduct(ctx.prisma, a);
    await adjust(
      ctx,
      actor.token,
      {
        warehouseId: await warehousePublicId(ctx, whA.id),
        productId: prodA.publicId,
        direction: 'INCREASE',
        quantity: '4',
        reason: 'a',
      },
      freshKey(),
    ).expect(201);

    // Company B with its own balance (seeded directly).
    const b = await makeTenant(ctx, 'B');
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-1' });
    const prodB = await createProduct(ctx.prisma, b);
    await ctx.prisma.stockBalance.create({
      data: { productId: prodB.id, warehouseId: whB.id, onHand: 99n, reserved: 0n },
    });

    const list = await request(ctx.http)
      .get(`${STOCK}/balances`)
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].warehouseId).toBe(await warehousePublicId(ctx, whA.id));
  });

  it('7. INCREASE from a zero/absent balance produces the correct balance', async () => {
    const f = await fixture(ctx);
    const res = await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '10',
        reason: 'in',
      },
      freshKey(),
    ).expect(201);
    expect(res.body).toMatchObject({
      direction: 'INCREASE',
      quantity: '10',
      balanceBefore: '0',
      balanceAfter: '10',
      type: 'ADJUSTMENT',
    });
    expect(await onHand(ctx, f.product.id, f.warehouse.id)).toBe(10n);
  });

  it('8. DECREASE lowers the balance correctly', async () => {
    const f = await fixture(ctx);
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '10',
        reason: 'in',
      },
      freshKey(),
    ).expect(201);
    const res = await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'DECREASE',
        quantity: '4',
        reason: 'out',
      },
      freshKey(),
    ).expect(201);
    expect(res.body).toMatchObject({
      direction: 'DECREASE',
      quantity: '4',
      balanceBefore: '10',
      balanceAfter: '6',
    });
    expect(await onHand(ctx, f.product.id, f.warehouse.id)).toBe(6n);
  });

  it('9. a DECREASE that would go negative is rejected → 409 (RFC7807)', async () => {
    const f = await fixture(ctx);
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '5',
        reason: 'in',
      },
      freshKey(),
    ).expect(201);
    const res = await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'DECREASE',
        quantity: '6',
        reason: 'out',
      },
      freshKey(),
    ).expect(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 409, code: 'CONFLICT' });
    // The balance is untouched and no extra movement was written.
    expect(await onHand(ctx, f.product.id, f.warehouse.id)).toBe(5n);
    const movements = await ctx.prisma.stockLedger.count({
      where: { productId: f.product.id, warehouseId: f.warehouse.id },
    });
    expect(movements).toBe(1);
  });

  it('10. concurrent INCREASE adjustments do not lose an update', async () => {
    const f = await fixture(ctx);
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        adjust(
          ctx,
          f.actor.token,
          {
            warehouseId: f.warehouse.publicId,
            productId: f.product.publicId,
            direction: 'INCREASE',
            quantity: '10',
            reason: 'c',
          },
          freshKey(),
        ),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await onHand(ctx, f.product.id, f.warehouse.id)).toBe(BigInt(N * 10));
    const movements = await ctx.prisma.stockLedger.count({
      where: { productId: f.product.id, warehouseId: f.warehouse.id },
    });
    expect(movements).toBe(N);
  }, 30_000);

  it('11. concurrent DECREASE never drives the balance negative (no race)', async () => {
    const f = await fixture(ctx);
    // Start at 30; five parallel DECREASE of 10 each → exactly 3 succeed, 2 conflict.
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '30',
        reason: 'seed',
      },
      freshKey(),
    ).expect(201);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        adjust(
          ctx,
          f.actor.token,
          {
            warehouseId: f.warehouse.publicId,
            productId: f.product.publicId,
            direction: 'DECREASE',
            quantity: '10',
            reason: 'c',
          },
          freshKey(),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const conflict = results.filter((r) => r.status === 409).length;
    expect(ok).toBe(3);
    expect(conflict).toBe(2);
    const final = await onHand(ctx, f.product.id, f.warehouse.id);
    expect(final).toBe(0n);
    expect(final! >= 0n).toBe(true);
  }, 30_000);

  it('12. an adjustment appends a movement visible via GET /stock/movements', async () => {
    const f = await fixture(ctx);
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '8',
        reason: 'm',
      },
      freshKey(),
    ).expect(201);

    const list = await request(ctx.http)
      .get(`${STOCK}/movements`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      warehouseId: f.warehouse.publicId,
      productId: f.product.publicId,
      direction: 'INCREASE',
      quantity: '8',
      balanceAfter: '8',
      reason: 'm',
    });
  });

  it('13. the append-only ledger rejects UPDATE and DELETE at the DB level', async () => {
    const f = await fixture(ctx);
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '8',
        reason: 'm',
      },
      freshKey(),
    ).expect(201);
    const row = await ctx.prisma.stockLedger.findFirstOrThrow({
      where: { productId: f.product.id, warehouseId: f.warehouse.id },
    });
    await expect(
      ctx.prisma.stockLedger.update({ where: { id: row.id }, data: { quantity: 999n } }),
    ).rejects.toThrow(/append.only/i);
    await expect(ctx.prisma.stockLedger.delete({ where: { id: row.id } })).rejects.toThrow(
      /append.only/i,
    );
  });

  it('14. balance and movement stay consistent (balanceAfter == stored on_hand)', async () => {
    const f = await fixture(ctx);
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '15',
        reason: 'a',
      },
      freshKey(),
    ).expect(201);
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'DECREASE',
        quantity: '5',
        reason: 'b',
      },
      freshKey(),
    ).expect(201);

    const last = await ctx.prisma.stockLedger.findFirstOrThrow({
      where: { productId: f.product.id, warehouseId: f.warehouse.id },
      orderBy: { id: 'desc' },
    });
    expect(last.balanceAfter).toBe(await onHand(ctx, f.product.id, f.warehouse.id));
    expect(last.balanceAfter).toBe(10n);
  });

  it('15. replaying the same Idempotency-Key returns the same movement (no duplicate)', async () => {
    const f = await fixture(ctx);
    const key = freshKey();
    const body = {
      warehouseId: f.warehouse.publicId,
      productId: f.product.publicId,
      direction: 'INCREASE',
      quantity: '10',
      reason: 'once',
    };
    const first = await adjust(ctx, f.actor.token, body, key).expect(201);
    const second = await adjust(ctx, f.actor.token, body, key).expect(201);
    expect(second.body).toEqual(first.body);

    expect(await onHand(ctx, f.product.id, f.warehouse.id)).toBe(10n);
    const movements = await ctx.prisma.stockLedger.count({
      where: { productId: f.product.id, warehouseId: f.warehouse.id },
    });
    expect(movements).toBe(1);
  });

  it('16. the same Idempotency-Key with a different payload → 409 conflict', async () => {
    const f = await fixture(ctx);
    const key = freshKey();
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '10',
        reason: 'a',
      },
      key,
    ).expect(201);
    // Same key, different quantity → mismatch.
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '11',
        reason: 'a',
      },
      key,
    ).expect(409);
    // No duplicate / extra movement created.
    const movements = await ctx.prisma.stockLedger.count({
      where: { productId: f.product.id, warehouseId: f.warehouse.id },
    });
    expect(movements).toBe(1);
  });

  it('17. a product from another company is not adjustable → 404 (entity hiding)', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const prodB = await createProduct(ctx.prisma, b);
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: prodB.publicId,
        direction: 'INCREASE',
        quantity: '1',
        reason: 'x',
      },
      freshKey(),
    ).expect(404);
  });

  it('18. a warehouse from another company is not adjustable → 404 (entity hiding)', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-W' });
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: await warehousePublicId(ctx, whB.id),
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '1',
        reason: 'x',
      },
      freshKey(),
    ).expect(404);
  });

  it('19. an inactive/soft-deleted product is rejected → 404', async () => {
    const f = await fixture(ctx);
    const inactive = await createProduct(ctx.prisma, f.companyId, {
      sku: 'INACT',
      isActive: false,
    });
    const deleted = await createProduct(ctx.prisma, f.companyId, {
      sku: 'DEL',
      deletedAt: new Date(),
    });
    for (const p of [inactive, deleted]) {
      await adjust(
        ctx,
        f.actor.token,
        {
          warehouseId: f.warehouse.publicId,
          productId: p.publicId,
          direction: 'INCREASE',
          quantity: '1',
          reason: 'x',
        },
        freshKey(),
      ).expect(404);
    }
  });

  it('20. an inactive/soft-deleted warehouse is rejected → 404', async () => {
    const f = await fixture(ctx);
    const inactive = await createWarehouse(ctx.prisma, f.companyId, {
      code: 'INACT',
      isActive: false,
    });
    const deleted = await createWarehouse(ctx.prisma, f.companyId, {
      code: 'DEL',
      deletedAt: new Date(),
    });
    for (const wh of [inactive, deleted]) {
      await adjust(
        ctx,
        f.actor.token,
        {
          warehouseId: await warehousePublicId(ctx, wh.id),
          productId: f.product.publicId,
          direction: 'INCREASE',
          quantity: '1',
          reason: 'x',
        },
        freshKey(),
      ).expect(404);
    }
  });

  it('21. a body companyId (unknown field) is rejected → 400', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '5',
        reason: 'x',
        companyId: b.toString(),
      },
      freshKey(),
    ).expect(400);
  });

  it('22. invalid quantities (0, negative, decimal, over-BIGINT) → 400 RFC7807', async () => {
    const f = await fixture(ctx);
    const bad = ['0', '-1', '12.5', '9223372036854775808', '', 'abc'];
    for (const quantity of bad) {
      const res = await adjust(
        ctx,
        f.actor.token,
        {
          warehouseId: f.warehouse.publicId,
          productId: f.product.publicId,
          direction: 'INCREASE',
          quantity,
          reason: 'x',
        },
        freshKey(),
      ).expect(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
  });

  it('22b. a missing Idempotency-Key header is rejected → 400', async () => {
    const f = await fixture(ctx);
    await request(ctx.http)
      .post(`${STOCK}/adjustments`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send({
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '5',
        reason: 'x',
      })
      .expect(400);
  });

  it('23. a not-found resource is RFC 7807 problem+json with a requestId', async () => {
    const f = await fixture(ctx);
    const res = await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: '00000000-0000-0000-0000-000000000000',
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '1',
        reason: 'x',
      },
      freshKey(),
    ).expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('24. a successful adjustment writes a same-transaction audit row', async () => {
    const f = await fixture(ctx);
    await adjust(
      ctx,
      f.actor.token,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '9',
        reason: 'audited',
      },
      freshKey(),
    ).expect(201);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'STOCK_ADJUSTED' },
    });
    expect(audit.actorId).toBe(f.actor.userId);
    expect(audit.entityType).toBe('stock_movement');
    expect(audit.requestId).toBeTruthy();
  });

  it('25. a forged companyId/warehouseId/productId claim does not change the result', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-W' });
    const prodB = await createProduct(ctx.prisma, b);
    const forged = forgeTokenFrom(ctx, f.actor.token, {
      companyId: b.toString(),
      warehouseId: whB.id.toString(),
      productId: prodB.id.toString(),
    });

    // The forged tenant cannot reach B's warehouse/product…
    await adjust(
      ctx,
      forged,
      {
        warehouseId: await warehousePublicId(ctx, whB.id),
        productId: prodB.publicId,
        direction: 'INCREASE',
        quantity: '1',
        reason: 'x',
      },
      freshKey(),
    ).expect(404);

    // …and still operates within A.
    await adjust(
      ctx,
      forged,
      {
        warehouseId: f.warehouse.publicId,
        productId: f.product.publicId,
        direction: 'INCREASE',
        quantity: '2',
        reason: 'ok',
      },
      freshKey(),
    ).expect(201);
    expect(await onHand(ctx, f.product.id, f.warehouse.id)).toBe(2n);
  });
});
