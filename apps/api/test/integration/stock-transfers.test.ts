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

async function warehousePublicId(ctx: TestApp, id: bigint): Promise<string> {
  const wh = await ctx.prisma.warehouse.findUniqueOrThrow({
    where: { id },
    select: { publicId: true },
  });
  return wh.publicId;
}

/** Seed a starting on-hand balance for (product, warehouse) directly. */
async function seedBalance(
  ctx: TestApp,
  productId: bigint,
  warehouseId: bigint,
  onHand: bigint,
): Promise<void> {
  await ctx.prisma.stockBalance.create({
    data: { productId, warehouseId, onHand, reserved: 0n },
  });
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

function transfer(
  ctx: TestApp,
  token: string,
  body: Record<string, unknown>,
  key: string,
): request.Test {
  return request(ctx.http)
    .post(`${STOCK}/transfers`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body);
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `tkey_${Date.now().toString(36)}_${keySeq}`;
}

interface Fixture {
  companyId: bigint;
  actor: Actor;
  from: { id: bigint; publicId: string };
  to: { id: bigint; publicId: string };
  product: { id: bigint; publicId: string };
}

/** Tenant + two in-scope warehouses + a product, with an EXPLICITLY-scoped actor
 * holding stock:read + stock:transfer, and the source seeded with `sourceStock`. */
async function fixture(ctx: TestApp, sourceStock = 100n): Promise<Fixture> {
  const companyId = await makeTenant(ctx);
  const actor = await makeActor(ctx, companyId, ['stock:read', 'stock:transfer']);
  const from = await createWarehouse(ctx.prisma, companyId, { code: 'FROM' });
  const to = await createWarehouse(ctx.prisma, companyId, { code: 'TO' });
  await assignWarehouseScope(ctx.prisma, actor.userId, from.id, companyId);
  await assignWarehouseScope(ctx.prisma, actor.userId, to.id, companyId);
  const product = await createProduct(ctx.prisma, companyId, { sku: 'P-1' });
  if (sourceStock > 0n) await seedBalance(ctx, product.id, from.id, sourceStock);
  return {
    companyId,
    actor,
    from: { id: from.id, publicId: await warehousePublicId(ctx, from.id) },
    to: { id: to.id, publicId: await warehousePublicId(ctx, to.id) },
    product: { id: product.id, publicId: product.publicId },
  };
}

function body(f: Fixture, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fromWarehouseId: f.from.publicId,
    toWarehouseId: f.to.publicId,
    productId: f.product.publicId,
    quantity: '10',
    reason: 'Warehouse transfer',
    ...over,
  };
}

describe('Stock transfer foundation (integration, real PostgreSQL)', () => {
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

  it('1. a transfer cannot be made without stock:transfer → 403', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ['stock:read'], { global: true }); // no transfer
    const from = await createWarehouse(ctx.prisma, companyId, { code: 'F' });
    const to = await createWarehouse(ctx.prisma, companyId, { code: 'T' });
    const product = await createProduct(ctx.prisma, companyId);
    await seedBalance(ctx, product.id, from.id, 50n);
    await transfer(
      ctx,
      actor.token,
      {
        fromWarehouseId: await warehousePublicId(ctx, from.id),
        toWarehouseId: await warehousePublicId(ctx, to.id),
        productId: product.publicId,
        quantity: '5',
        reason: 'x',
      },
      freshKey(),
    ).expect(403);
  });

  it('1b. an unauthenticated transfer is rejected by the global JwtAuthGuard → 401', async () => {
    await request(ctx.http).post(`${STOCK}/transfers`).send({}).expect(401);
  });

  it('2. no SOURCE warehouse scope → 403', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ['stock:read', 'stock:transfer']);
    const from = await createWarehouse(ctx.prisma, companyId, { code: 'F' });
    const to = await createWarehouse(ctx.prisma, companyId, { code: 'T' });
    await assignWarehouseScope(ctx.prisma, actor.userId, to.id, companyId); // dest only
    const product = await createProduct(ctx.prisma, companyId);
    await seedBalance(ctx, product.id, from.id, 50n);
    await transfer(
      ctx,
      actor.token,
      {
        fromWarehouseId: await warehousePublicId(ctx, from.id),
        toWarehouseId: await warehousePublicId(ctx, to.id),
        productId: product.publicId,
        quantity: '5',
        reason: 'x',
      },
      freshKey(),
    ).expect(403);
  });

  it('3. no DESTINATION warehouse scope → 403', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ['stock:read', 'stock:transfer']);
    const from = await createWarehouse(ctx.prisma, companyId, { code: 'F' });
    const to = await createWarehouse(ctx.prisma, companyId, { code: 'T' });
    await assignWarehouseScope(ctx.prisma, actor.userId, from.id, companyId); // source only
    const product = await createProduct(ctx.prisma, companyId);
    await seedBalance(ctx, product.id, from.id, 50n);
    await transfer(
      ctx,
      actor.token,
      {
        fromWarehouseId: await warehousePublicId(ctx, from.id),
        toWarehouseId: await warehousePublicId(ctx, to.id),
        productId: product.publicId,
        quantity: '5',
        reason: 'x',
      },
      freshKey(),
    ).expect(403);
  });

  it('4. explicit source + destination scope → transfer succeeds', async () => {
    const f = await fixture(ctx, 100n);
    const res = await transfer(ctx, f.actor.token, body(f), freshKey()).expect(201);
    expect(res.body).toMatchObject({
      fromWarehouseId: f.from.publicId,
      toWarehouseId: f.to.publicId,
      productId: f.product.publicId,
      quantity: '10',
      reason: 'Warehouse transfer',
    });
    expect(typeof res.body.id).toBe('string');
  });

  it('5. warehouse:scope:all transfers within the same company succeed', async () => {
    const companyId = await makeTenant(ctx);
    const actor = await makeActor(ctx, companyId, ['stock:read', 'stock:transfer'], {
      global: true,
    });
    const from = await createWarehouse(ctx.prisma, companyId, { code: 'F' });
    const to = await createWarehouse(ctx.prisma, companyId, { code: 'T' });
    const product = await createProduct(ctx.prisma, companyId);
    await seedBalance(ctx, product.id, from.id, 30n);
    await transfer(
      ctx,
      actor.token,
      {
        fromWarehouseId: await warehousePublicId(ctx, from.id),
        toWarehouseId: await warehousePublicId(ctx, to.id),
        productId: product.publicId,
        quantity: '12',
        reason: 'global',
      },
      freshKey(),
    ).expect(201);
    expect(await onHand(ctx, product.id, from.id)).toBe(18n);
    expect(await onHand(ctx, product.id, to.id)).toBe(12n);
  });

  it('6. another company’s warehouse cannot be transferred to/from → 404', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-W' });
    // Destination in another company → 404 (entity hiding).
    await transfer(
      ctx,
      f.actor.token,
      body(f, { toWarehouseId: await warehousePublicId(ctx, whB.id) }),
      freshKey(),
    ).expect(404);
  });

  it('7. another company’s product cannot be transferred → 404', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    const prodB = await createProduct(ctx.prisma, b);
    await transfer(ctx, f.actor.token, body(f, { productId: prodB.publicId }), freshKey()).expect(
      404,
    );
  });

  it('8. same source and destination warehouse → 400', async () => {
    const f = await fixture(ctx);
    await transfer(
      ctx,
      f.actor.token,
      body(f, { toWarehouseId: f.from.publicId }),
      freshKey(),
    ).expect(400);
  });

  it('9. invalid quantities (0, negative, decimal, empty, over-BIGINT) → 400 RFC7807', async () => {
    const f = await fixture(ctx);
    const bad = ['0', '-1', '12.5', '', '9223372036854775808', 'abc'];
    for (const quantity of bad) {
      const res = await transfer(ctx, f.actor.token, body(f, { quantity }), freshKey()).expect(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.status).toBe(400);
    }
  });

  it('10. insufficient source stock → 409 (RFC7807), balances untouched', async () => {
    const f = await fixture(ctx, 5n);
    const res = await transfer(ctx, f.actor.token, body(f, { quantity: '6' }), freshKey()).expect(
      409,
    );
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(await onHand(ctx, f.product.id, f.from.id)).toBe(5n);
    expect(await onHand(ctx, f.product.id, f.to.id)).toBe(null);
    expect(await ctx.prisma.stockTransferRecord.count({ where: { companyId: f.companyId } })).toBe(
      0,
    );
    expect(await ctx.prisma.stockLedger.count({ where: { referenceType: 'STOCK_TRANSFER' } })).toBe(
      0,
    );
  });

  it('11+12. a successful transfer decrements source and increments destination', async () => {
    const f = await fixture(ctx, 50n);
    await transfer(ctx, f.actor.token, body(f, { quantity: '20' }), freshKey()).expect(201);
    expect(await onHand(ctx, f.product.id, f.from.id)).toBe(30n);
    expect(await onHand(ctx, f.product.id, f.to.id)).toBe(20n);
  });

  it('13+14. a transfer writes two ledger movements bound by the same reference', async () => {
    const f = await fixture(ctx, 50n);
    await transfer(ctx, f.actor.token, body(f, { quantity: '15' }), freshKey()).expect(201);

    const record = await ctx.prisma.stockTransferRecord.findFirstOrThrow({
      where: { companyId: f.companyId },
    });
    const movements = await ctx.prisma.stockLedger.findMany({
      where: { referenceType: 'STOCK_TRANSFER', referenceId: record.id },
      orderBy: { id: 'asc' },
    });
    expect(movements).toHaveLength(2);
    const out = movements.find((m) => m.changeType === 'TRANSFER_OUT')!;
    const inn = movements.find((m) => m.changeType === 'TRANSFER_IN')!;
    expect(out.warehouseId).toBe(f.from.id);
    expect(out.quantity).toBe(-15n);
    expect(out.balanceAfter).toBe(35n);
    expect(inn.warehouseId).toBe(f.to.id);
    expect(inn.quantity).toBe(15n);
    expect(inn.balanceAfter).toBe(15n);
    // Both reference the same transfer record (correlation).
    expect(out.referenceId).toBe(record.id);
    expect(inn.referenceId).toBe(record.id);
  });

  it('15. the transfer record is immutable: DB rejects UPDATE and DELETE', async () => {
    const f = await fixture(ctx, 50n);
    await transfer(ctx, f.actor.token, body(f), freshKey()).expect(201);
    const rec = await ctx.prisma.stockTransferRecord.findFirstOrThrow({
      where: { companyId: f.companyId },
    });
    await expect(
      ctx.prisma.stockTransferRecord.update({ where: { id: rec.id }, data: { quantity: 999n } }),
    ).rejects.toThrow(/append.only/i);
    await expect(ctx.prisma.stockTransferRecord.delete({ where: { id: rec.id } })).rejects.toThrow(
      /append.only/i,
    );
  });

  it('16. replaying the same Idempotency-Key returns the same transfer (no duplicate)', async () => {
    const f = await fixture(ctx, 50n);
    const key = freshKey();
    const first = await transfer(ctx, f.actor.token, body(f), key).expect(201);
    const second = await transfer(ctx, f.actor.token, body(f), key).expect(201);
    expect(second.body).toEqual(first.body);
    expect(await onHand(ctx, f.product.id, f.from.id)).toBe(40n);
    expect(await onHand(ctx, f.product.id, f.to.id)).toBe(10n);
    expect(await ctx.prisma.stockTransferRecord.count({ where: { companyId: f.companyId } })).toBe(
      1,
    );
    expect(await ctx.prisma.stockLedger.count({ where: { referenceType: 'STOCK_TRANSFER' } })).toBe(
      2,
    );
  });

  it('17. the same Idempotency-Key with a different payload → 409', async () => {
    const f = await fixture(ctx, 50n);
    const key = freshKey();
    await transfer(ctx, f.actor.token, body(f, { quantity: '10' }), key).expect(201);
    await transfer(ctx, f.actor.token, body(f, { quantity: '11' }), key).expect(409);
    expect(await ctx.prisma.stockTransferRecord.count({ where: { companyId: f.companyId } })).toBe(
      1,
    );
  });

  it('18. concurrent same-key transfers create no duplicate transfer/movements', async () => {
    const f = await fixture(ctx, 50n);
    const key = freshKey();
    const payload = body(f, { quantity: '10' });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => transfer(ctx, f.actor.token, payload, key)),
    );
    // All resolve to the same transfer (no 5xx, no duplicate side effect).
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await ctx.prisma.stockTransferRecord.count({ where: { companyId: f.companyId } })).toBe(
      1,
    );
    expect(await ctx.prisma.stockLedger.count({ where: { referenceType: 'STOCK_TRANSFER' } })).toBe(
      2,
    );
    expect(await onHand(ctx, f.product.id, f.from.id)).toBe(40n);
    expect(await onHand(ctx, f.product.id, f.to.id)).toBe(10n);
  }, 30_000);

  it('19. concurrent distinct transfers do not lose an update', async () => {
    const f = await fixture(ctx, 100n);
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        transfer(ctx, f.actor.token, body(f, { quantity: '10' }), freshKey()),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await onHand(ctx, f.product.id, f.from.id)).toBe(BigInt(100 - N * 10));
    expect(await onHand(ctx, f.product.id, f.to.id)).toBe(BigInt(N * 10));
    expect(await ctx.prisma.stockLedger.count({ where: { referenceType: 'STOCK_TRANSFER' } })).toBe(
      2 * N,
    );
  }, 30_000);

  it('20+21. concurrent DECREASE of the source never races negative → exact split', async () => {
    // Source 30; five parallel transfers of 10 → exactly 3 succeed, 2 conflict.
    const f = await fixture(ctx, 30n);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        transfer(ctx, f.actor.token, body(f, { quantity: '10' }), freshKey()),
      ),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const conflict = results.filter((r) => r.status === 409).length;
    expect(ok).toBe(3);
    expect(conflict).toBe(2);
    const fromFinal = await onHand(ctx, f.product.id, f.from.id);
    expect(fromFinal).toBe(0n);
    expect(fromFinal! >= 0n).toBe(true);
    expect(await onHand(ctx, f.product.id, f.to.id)).toBe(30n);
  }, 30_000);

  it('20b. opposite-direction concurrent transfers do not deadlock and conserve total on-hand', async () => {
    // Two warehouses both seeded; fire A→B and B→A concurrently. No 5xx (deadlock),
    // and the total on_hand across both warehouses is conserved.
    const f = await fixture(ctx, 100n);
    await seedBalance(ctx, f.product.id, f.to.id, 100n);
    const ab = body(f, { quantity: '5' });
    const ba = body(f, {
      fromWarehouseId: f.to.publicId,
      toWarehouseId: f.from.publicId,
      quantity: '5',
    });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => transfer(ctx, f.actor.token, ab, freshKey())),
      ...Array.from({ length: 5 }, () => transfer(ctx, f.actor.token, ba, freshKey())),
    ]);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(results.some((r) => r.status >= 500)).toBe(false);
    const total =
      (await onHand(ctx, f.product.id, f.from.id))! + (await onHand(ctx, f.product.id, f.to.id))!;
    expect(total).toBe(200n);
  }, 30_000);

  it('22. GET /stock/transfers is scope-filtered (source or destination)', async () => {
    const companyId = await makeTenant(ctx);
    // Three warehouses A, B, C. Global admin seeds + performs A→B and B→C transfers.
    const admin = await makeActor(ctx, companyId, ['stock:read', 'stock:transfer'], {
      global: true,
    });
    const a = await createWarehouse(ctx.prisma, companyId, { code: 'A' });
    const b = await createWarehouse(ctx.prisma, companyId, { code: 'B' });
    const c = await createWarehouse(ctx.prisma, companyId, { code: 'C' });
    const product = await createProduct(ctx.prisma, companyId);
    await seedBalance(ctx, product.id, a.id, 100n);
    await seedBalance(ctx, product.id, b.id, 100n);
    const mk = async (fromId: bigint, toId: bigint) =>
      transfer(
        ctx,
        admin.token,
        {
          fromWarehouseId: await warehousePublicId(ctx, fromId),
          toWarehouseId: await warehousePublicId(ctx, toId),
          productId: product.publicId,
          quantity: '5',
          reason: 'x',
        },
        freshKey(),
      ).expect(201);
    await mk(a.id, b.id); // touches A,B
    await mk(b.id, c.id); // touches B,C

    // Actor scoped ONLY to C sees just the B→C transfer.
    const actor = await makeActor(ctx, companyId, ['stock:read']);
    await assignWarehouseScope(ctx.prisma, actor.userId, c.id, companyId);
    const list = await request(ctx.http)
      .get(`${STOCK}/transfers`)
      .set('Authorization', `Bearer ${actor.token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].toWarehouseId).toBe(await warehousePublicId(ctx, c.id));

    // A scopeless actor sees nothing.
    const none = await makeActor(ctx, companyId, ['stock:read']);
    const empty = await request(ctx.http)
      .get(`${STOCK}/transfers`)
      .set('Authorization', `Bearer ${none.token}`)
      .expect(200);
    expect(empty.body.data).toHaveLength(0);
  });

  it('23. GET /stock/transfers/:id requires source or destination scope (else 404)', async () => {
    const f = await fixture(ctx, 50n);
    const created = await transfer(ctx, f.actor.token, body(f), freshKey()).expect(201);
    const id = created.body.id as string;

    // The owning, in-scope actor can read it.
    const ok = await request(ctx.http)
      .get(`${STOCK}/transfers/${id}`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .expect(200);
    expect(ok.body.id).toBe(id);

    // A same-company actor with NO scope to either warehouse gets 404 (entity hiding).
    const stranger = await makeActor(ctx, f.companyId, ['stock:read']);
    const other = await createWarehouse(ctx.prisma, f.companyId, { code: 'OTHER' });
    await assignWarehouseScope(ctx.prisma, stranger.userId, other.id, f.companyId);
    await request(ctx.http)
      .get(`${STOCK}/transfers/${id}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);

    // Another tenant cannot see it either.
    const b = await makeTenant(ctx, 'B');
    const bActor = await makeActor(ctx, b, ['stock:read'], { global: true });
    await request(ctx.http)
      .get(`${STOCK}/transfers/${id}`)
      .set('Authorization', `Bearer ${bActor.token}`)
      .expect(404);
  });

  it('24. a forged company/warehouse/product claim does not change the result', async () => {
    const f = await fixture(ctx, 50n);
    const b = await makeTenant(ctx, 'B');
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-W' });
    const prodB = await createProduct(ctx.prisma, b);
    const forged = forgeTokenFrom(ctx, f.actor.token, {
      companyId: b.toString(),
      warehouseId: whB.id.toString(),
      productId: prodB.id.toString(),
    });
    // Forged tenant cannot reach B's product…
    await transfer(ctx, forged, body(f, { productId: prodB.publicId }), freshKey()).expect(404);
    // …and still operates correctly within A.
    await transfer(ctx, forged, body(f, { quantity: '7' }), freshKey()).expect(201);
    expect(await onHand(ctx, f.product.id, f.from.id)).toBe(43n);
  });

  it('25. a body companyId (unknown field) is rejected → 400', async () => {
    const f = await fixture(ctx);
    const b = await makeTenant(ctx, 'B');
    await transfer(ctx, f.actor.token, body(f, { companyId: b.toString() }), freshKey()).expect(
      400,
    );
  });

  it('22b. a missing Idempotency-Key header is rejected → 400', async () => {
    const f = await fixture(ctx, 50n);
    await request(ctx.http)
      .post(`${STOCK}/transfers`)
      .set('Authorization', `Bearer ${f.actor.token}`)
      .send(body(f))
      .expect(400);
  });

  it('26. a successful transfer writes a same-transaction audit row', async () => {
    const f = await fixture(ctx, 50n);
    await transfer(ctx, f.actor.token, body(f), freshKey()).expect(201);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'STOCK_TRANSFERRED' },
    });
    expect(audit.actorId).toBe(f.actor.userId);
    expect(audit.entityType).toBe('stock_transfer');
    expect(audit.requestId).toBeTruthy();
  });
});
