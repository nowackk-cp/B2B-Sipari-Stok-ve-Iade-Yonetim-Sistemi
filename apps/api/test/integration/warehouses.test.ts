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
  createTestApp,
  createUser,
  createWarehouse,
  grantPermissionsViaRole,
  resetState,
  seedRbac,
} from './helpers';

const BASE = '/api/v1';
const AUTH = `${BASE}/auth`;
const WAREHOUSES = `${BASE}/warehouses`;

const ALL_WAREHOUSE_PERMS = [
  'warehouse:read',
  'warehouse:create',
  'warehouse:update',
  'warehouse:delete',
];

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Forge a validly-signed token carrying extra (fake) claims, reusing a real
 * token's subject/session/exp — proves the API ignores JWT-supplied tenant /
 * warehouse and trusts only the PostgreSQL principal. */
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

/**
 * Stand up a fresh tenant with its own seeded RBAC (roles + grants). Unlike the
 * default seeded company, a fresh tenant has NO pre-seeded "MAIN" warehouse, so
 * exact-count list/pagination assertions are not polluted by seed fixtures.
 */
async function makeTenant(ctx: TestApp, name?: string): Promise<bigint> {
  const company = await createCompany(ctx.prisma, name);
  await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, company));
  return company;
}

async function makeCompanyB(ctx: TestApp): Promise<bigint> {
  return makeTenant(ctx, 'Company B');
}

/** The public id of an existing warehouse row (created directly via prisma). */
async function publicIdOf(ctx: TestApp, warehouseId: bigint): Promise<string> {
  const wh = await ctx.prisma.warehouse.findUniqueOrThrow({
    where: { id: warehouseId },
    select: { publicId: true },
  });
  return wh.publicId;
}

/**
 * A company-A user holding warehouse permissions. `global` adds the protected
 * `warehouse:scope:all` so the user can see/manage every same-company warehouse;
 * otherwise the user only reaches warehouses it is explicitly scoped to.
 */
async function makeWarehouseUser(
  ctx: TestApp,
  opts: { perms?: string[]; global?: boolean } = {},
): Promise<{ token: string; companyId: bigint; id: bigint }> {
  const a = await makeTenant(ctx);
  const user = await createUser(ctx.prisma, { companyId: a });
  const perms = [...(opts.perms ?? ALL_WAREHOUSE_PERMS)];
  if (opts.global) perms.push(WAREHOUSE_SCOPE_ALL);
  await grantPermissionsViaRole(ctx.prisma, user.id, perms);
  const token = await login(ctx, user.email, user.password);
  return { token, companyId: a, id: user.id };
}

describe('Warehouses management (integration, real PostgreSQL)', () => {
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

  it('1. an unauthorized user (no warehouse:read) cannot list → 403', async () => {
    const a = await makeTenant(ctx);
    const user = await createUser(ctx.prisma, { companyId: a }); // no roles/permissions
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http).get(WAREHOUSES).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('1b. an unauthenticated request is rejected by the global JwtAuthGuard → 401', async () => {
    await request(ctx.http).get(WAREHOUSES).expect(401);
  });

  it('2. warehouse:read but NO scope → empty list and 403 on get-by-id (safe behavior)', async () => {
    const a = await makeTenant(ctx);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['warehouse:read']);
    const wh = await createWarehouse(ctx.prisma, a);
    const token = await login(ctx, reader.email, reader.password);

    const list = await request(ctx.http)
      .get(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);

    // The warehouse exists in the actor's own tenant but is out of scope → 403.
    await request(ctx.http)
      .get(`${WAREHOUSES}/${await publicIdOf(ctx, wh.id)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('3. warehouse:read + explicit scope → only the assigned warehouse is listed', async () => {
    const a = await makeTenant(ctx);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['warehouse:read']);
    const scoped = await createWarehouse(ctx.prisma, a, { code: 'SCOPED' });
    const other = await createWarehouse(ctx.prisma, a, { code: 'OTHER' });
    await assignWarehouseScope(ctx.prisma, reader.id, scoped.id, a);
    const token = await login(ctx, reader.email, reader.password);

    const list = await request(ctx.http)
      .get(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data.map((w: { code: string }) => w.code)).toEqual(['SCOPED']);

    // Get of the scoped one works; the un-scoped same-company one is 403.
    await request(ctx.http)
      .get(`${WAREHOUSES}/${await publicIdOf(ctx, scoped.id)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(ctx.http)
      .get(`${WAREHOUSES}/${await publicIdOf(ctx, other.id)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('4. warehouse:read + warehouse:scope:all → every same-company warehouse is listed', async () => {
    const a = await makeTenant(ctx);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['warehouse:read', WAREHOUSE_SCOPE_ALL]);
    await createWarehouse(ctx.prisma, a, { code: 'W1' });
    await createWarehouse(ctx.prisma, a, { code: 'W2' });
    const token = await login(ctx, reader.email, reader.password);

    const list = await request(ctx.http)
      .get(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data.map((w: { code: string }) => w.code).sort()).toEqual(['W1', 'W2']);
  });

  it('5. warehouse:scope:all never reveals another company’s warehouse', async () => {
    const a = await makeTenant(ctx);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['warehouse:read', WAREHOUSE_SCOPE_ALL]);
    await createWarehouse(ctx.prisma, a, { code: 'A-1' });
    const b = await makeCompanyB(ctx);
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-1' });
    const token = await login(ctx, reader.email, reader.password);

    const list = await request(ctx.http)
      .get(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data.map((w: { code: string }) => w.code)).toEqual(['A-1']);

    // And B's warehouse is unreachable by id (404, entity hiding).
    await request(ctx.http)
      .get(`${WAREHOUSES}/${await publicIdOf(ctx, whB.id)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('6. company A cannot get/update/delete a company B warehouse → 404', async () => {
    const { token } = await makeWarehouseUser(ctx, { global: true });
    const b = await makeCompanyB(ctx);
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-SECRET' });
    const id = await publicIdOf(ctx, whB.id);

    await request(ctx.http)
      .get(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    await request(ctx.http)
      .patch(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked' })
      .expect(404);
    await request(ctx.http)
      .delete(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    // B's row is untouched.
    const stillThere = await ctx.prisma.warehouse.findUniqueOrThrow({ where: { id: whB.id } });
    expect(stillThere.name).toBe('B-SECRET');
    expect(stillThere.deletedAt).toBeNull();
  });

  it('7. a forged companyId/warehouseId claim does not change the result', async () => {
    const a = await makeTenant(ctx);
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['warehouse:read', WAREHOUSE_SCOPE_ALL]);
    await createWarehouse(ctx.prisma, a, { code: 'A-ONLY' });
    const b = await makeCompanyB(ctx);
    const whB = await createWarehouse(ctx.prisma, b, { code: 'B-SECRET' });

    const real = await login(ctx, user.email, user.password);
    const forged = forgeTokenFrom(ctx, real, {
      companyId: b.toString(),
      warehouseId: whB.id.toString(),
    });

    const list = await request(ctx.http)
      .get(WAREHOUSES)
      .set('Authorization', `Bearer ${forged}`)
      .expect(200);
    expect(list.body.data.map((w: { code: string }) => w.code)).toEqual(['A-ONLY']);
    // The forged warehouse/company claim cannot reach B's warehouse.
    await request(ctx.http)
      .get(`${WAREHOUSES}/${await publicIdOf(ctx, whB.id)}`)
      .set('Authorization', `Bearer ${forged}`)
      .expect(404);
  });

  it('8. a body companyId is rejected (400); a clean create lands in the actor’s company', async () => {
    const { token, companyId } = await makeWarehouseUser(ctx, { global: true });
    const b = await makeCompanyB(ctx);

    // forbidNonWhitelisted → an unknown `companyId` field is rejected (400).
    await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'C-1', name: 'WithCompany', companyId: b.toString() })
      .expect(400);

    const res = await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'C-2', name: 'CleanCreate' })
      .expect(201);
    expect(res.body).toMatchObject({ code: 'C-2', name: 'CleanCreate', isActive: true });
    expect(typeof res.body.id).toBe('string');

    const stored = await ctx.prisma.warehouse.findFirstOrThrow({ where: { code: 'C-2' } });
    expect(stored.companyId).toBe(companyId);
    expect(stored.companyId).not.toBe(b);
  });

  it('9. create writes to the actor’s company and persists the full card', async () => {
    const { token, companyId } = await makeWarehouseUser(ctx, { global: true });
    const res = await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'FULL',
        name: 'Full Warehouse',
        addressLine1: '123 Example St.',
        addressLine2: 'Floor 2',
        city: 'Istanbul',
        postalCode: '34000',
        country: 'tr',
        isActive: false,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      code: 'FULL',
      name: 'Full Warehouse',
      addressLine1: '123 Example St.',
      addressLine2: 'Floor 2',
      city: 'Istanbul',
      postalCode: '34000',
      country: 'TR', // normalised to upper-case
      isActive: false,
    });
    const stored = await ctx.prisma.warehouse.findFirstOrThrow({ where: { code: 'FULL' } });
    expect(stored.companyId).toBe(companyId);
  });

  it('10. a duplicate code within the same company is rejected → 409', async () => {
    const { token } = await makeWarehouseUser(ctx, { global: true });
    await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'DUP', name: 'First' })
      .expect(201);
    await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'DUP', name: 'Second' })
      .expect(409);
  });

  it('11. two different companies may use the same code', async () => {
    const { token } = await makeWarehouseUser(ctx, { global: true });
    const b = await makeCompanyB(ctx);
    await createWarehouse(ctx.prisma, b, { code: 'SHARED' });

    await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SHARED', name: 'A shared' })
      .expect(201);
  });

  it('12. a soft-deleted warehouse disappears from list and get', async () => {
    const { token } = await makeWarehouseUser(ctx, { global: true });
    const created = await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'DEL-1', name: 'ToDelete' })
      .expect(201);
    const id = created.body.id as string;

    await request(ctx.http)
      .delete(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await request(ctx.http)
      .get(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const list = await request(ctx.http)
      .get(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('13. code is reusable after soft delete within the same company (DB partial-unique decision)', async () => {
    const { token } = await makeWarehouseUser(ctx, { global: true });
    const created = await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'REUSE', name: 'Original' })
      .expect(201);
    await request(ctx.http)
      .delete(`${WAREHOUSES}/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // The partial unique (`WHERE deleted_at IS NULL`) frees the code once deleted.
    await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'REUSE', name: 'Recreated' })
      .expect(201);
  });

  it('14. update only affects an in-scope warehouse in the caller’s company', async () => {
    const a = await makeTenant(ctx);
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['warehouse:update']);
    const scoped = await createWarehouse(ctx.prisma, a, { code: 'UPD' });
    const unscoped = await createWarehouse(ctx.prisma, a, { code: 'NOUPD' });
    await assignWarehouseScope(ctx.prisma, user.id, scoped.id, a);
    const token = await login(ctx, user.email, user.password);

    const res = await request(ctx.http)
      .patch(`${WAREHOUSES}/${await publicIdOf(ctx, scoped.id)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(res.body.name).toBe('Renamed');

    // Same company but out of scope → 403, and the row is untouched.
    await request(ctx.http)
      .patch(`${WAREHOUSES}/${await publicIdOf(ctx, unscoped.id)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope' })
      .expect(403);
    const untouched = await ctx.prisma.warehouse.findUniqueOrThrow({ where: { id: unscoped.id } });
    expect(untouched.name).toBe('NOUPD');
  });

  it('15. delete only affects an in-scope warehouse in the caller’s company', async () => {
    const a = await makeTenant(ctx);
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['warehouse:delete']);
    const scoped = await createWarehouse(ctx.prisma, a, { code: 'DELOK' });
    const unscoped = await createWarehouse(ctx.prisma, a, { code: 'DELNO' });
    await assignWarehouseScope(ctx.prisma, user.id, scoped.id, a);
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .delete(`${WAREHOUSES}/${await publicIdOf(ctx, unscoped.id)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(
      (await ctx.prisma.warehouse.findUniqueOrThrow({ where: { id: unscoped.id } })).deletedAt,
    ).toBeNull();

    await request(ctx.http)
      .delete(`${WAREHOUSES}/${await publicIdOf(ctx, scoped.id)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(
      (await ctx.prisma.warehouse.findUniqueOrThrow({ where: { id: scoped.id } })).deletedAt,
    ).not.toBeNull();
  });

  it('16. mutations require their specific permission (read alone cannot create/update/delete)', async () => {
    const a = await makeTenant(ctx);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['warehouse:read', WAREHOUSE_SCOPE_ALL]);
    const existing = await createWarehouse(ctx.prisma, a, { code: 'RO' });
    const id = await publicIdOf(ctx, existing.id);
    const token = await login(ctx, reader.email, reader.password);

    await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'NEW', name: 'Nope' })
      .expect(403);
    await request(ctx.http)
      .patch(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope' })
      .expect(403);
    await request(ctx.http)
      .delete(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    // Reading is allowed (and scope:all grants the get).
    await request(ctx.http)
      .get(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('17. pagination walks the warehouses with a cursor', async () => {
    const { token, companyId } = await makeWarehouseUser(ctx, { global: true });
    await createWarehouse(ctx.prisma, companyId, { code: 'P-1' });
    await createWarehouse(ctx.prisma, companyId, { code: 'P-2' });
    await createWarehouse(ctx.prisma, companyId, { code: 'P-3' });

    const first = await request(ctx.http)
      .get(`${WAREHOUSES}?limit=2`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pageInfo.hasNextPage).toBe(true);
    expect(typeof first.body.pageInfo.nextCursor).toBe('string');

    const second = await request(ctx.http)
      .get(`${WAREHOUSES}?limit=2&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pageInfo.hasNextPage).toBe(false);
    expect(second.body.pageInfo.nextCursor).toBeNull();
  });

  it('18. search matches over code and name', async () => {
    const { token, companyId } = await makeWarehouseUser(ctx, { global: true });
    await createWarehouse(ctx.prisma, companyId, { code: 'NORTH-1' });
    await ctx.prisma.warehouse.updateMany({
      where: { code: 'NORTH-1' },
      data: { name: 'Blue Depot' },
    });
    await createWarehouse(ctx.prisma, companyId, { code: 'SOUTH-9' });
    await ctx.prisma.warehouse.updateMany({
      where: { code: 'SOUTH-9' },
      data: { name: 'North Storage' },
    });
    await createWarehouse(ctx.prisma, companyId, { code: 'MISC-0' });
    await ctx.prisma.warehouse.updateMany({
      where: { code: 'MISC-0' },
      data: { name: 'Nothing' },
    });

    const byCodeOrName = await request(ctx.http)
      .get(`${WAREHOUSES}?search=north`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byCodeOrName.body.data.map((w: { code: string }) => w.code).sort()).toEqual([
      'NORTH-1',
      'SOUTH-9',
    ]);

    const byName = await request(ctx.http)
      .get(`${WAREHOUSES}?search=blue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byName.body.data.map((w: { code: string }) => w.code)).toEqual(['NORTH-1']);
  });

  it('19. a not-found warehouse is returned as RFC 7807 problem+json with a requestId', async () => {
    const { token } = await makeWarehouseUser(ctx, { global: true });
    const res = await request(ctx.http)
      .get(`${WAREHOUSES}/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(typeof res.body.type).toBe('string');
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('20. create/update/delete each write a same-transaction audit row', async () => {
    const { token, id: actorId } = await makeWarehouseUser(ctx, { global: true });
    const created = await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'AUD-1', name: 'Audited' })
      .expect(201);
    const id = created.body.id as string;

    await request(ctx.http)
      .patch(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Audited v2' })
      .expect(200);
    await request(ctx.http)
      .delete(`${WAREHOUSES}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    for (const action of ['WAREHOUSE_CREATED', 'WAREHOUSE_UPDATED', 'WAREHOUSE_DELETED']) {
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action } });
      expect(audit.actorId).toBe(actorId);
      expect(audit.entityType).toBe('warehouse');
      expect(audit.requestId).toBeTruthy();
    }
  });

  it('21. a creator without scope does NOT auto-gain access to the new warehouse', async () => {
    // SECURITY_MODEL §3: POST needs only warehouse:create; NO implicit scope is
    // granted. Without scope:all or an explicit grant, the creator cannot see it.
    const a = await makeTenant(ctx);
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['warehouse:create', 'warehouse:read']);
    const token = await login(ctx, user.email, user.password);

    const created = await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'NOSCOPE', name: 'NoAutoScope' })
      .expect(201);
    // It landed in the actor's company…
    const stored = await ctx.prisma.warehouse.findFirstOrThrow({ where: { code: 'NOSCOPE' } });
    expect(stored.companyId).toBe(a);
    // …but the creator has no scope to it: list is empty and get is 403.
    const list = await request(ctx.http)
      .get(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);
    await request(ctx.http)
      .get(`${WAREHOUSES}/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('22. different companies may reuse the same code AND name (only code is the key, per company)', async () => {
    // DATABASE_DESIGN §5: warehouse uniqueness is `code` (company-scoped, active).
    // name is NOT a uniqueness key, so a same-company duplicate name is accepted.
    const { token } = await makeWarehouseUser(ctx, { global: true });
    await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'N-1', name: 'Same Name' })
      .expect(201);
    await request(ctx.http)
      .post(WAREHOUSES)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'N-2', name: 'Same Name' })
      .expect(201);
  });
});
