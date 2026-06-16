import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCompanyRbac } from '@b2b/database';
import { AppConfigService } from '../../src/common/config/app-config.service';
import {
  type TestApp,
  closeTestApp,
  createCompany,
  createProduct,
  createTestApp,
  createUser,
  ensureDefaultCompany,
  grantPermissionsViaRole,
  resetState,
  seedRbac,
} from './helpers';

const BASE = '/api/v1';
const AUTH = `${BASE}/auth`;
const PRODUCTS = `${BASE}/products`;

const ALL_PRODUCT_PERMS = ['product:read', 'product:create', 'product:update', 'product:delete'];

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Forge a validly-signed token carrying an extra (fake) `companyId` claim, reusing
 * a real token's subject/session/exp — proves the API ignores JWT-supplied tenant
 * and trusts only the PostgreSQL principal. */
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

/** A company-A user holding every product permission, plus its bearer token. */
async function makeCatalogUser(
  ctx: TestApp,
): Promise<{ token: string; companyId: bigint; id: bigint }> {
  const a = await ensureDefaultCompany(ctx.prisma);
  const user = await createUser(ctx.prisma, { companyId: a });
  await grantPermissionsViaRole(ctx.prisma, user.id, ALL_PRODUCT_PERMS);
  const token = await login(ctx, user.email, user.password);
  return { token, companyId: a, id: user.id };
}

async function makeCompanyB(ctx: TestApp): Promise<bigint> {
  const companyB = await createCompany(ctx.prisma, 'Company B');
  await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, companyB));
  return companyB;
}

describe('Products catalog (integration, real PostgreSQL)', () => {
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

  it('1. an unauthorized user (no product:read) cannot list → 403', async () => {
    const a = await ensureDefaultCompany(ctx.prisma);
    const user = await createUser(ctx.prisma, { companyId: a }); // no roles/permissions
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http).get(PRODUCTS).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('1b. an unauthenticated request is rejected by the global JwtAuthGuard → 401', async () => {
    await request(ctx.http).get(PRODUCTS).expect(401);
  });

  it('2. a product:read user lists its own company products', async () => {
    const a = await ensureDefaultCompany(ctx.prisma);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['product:read']);
    await createProduct(ctx.prisma, a, { sku: 'A-1', name: 'Alpha' });
    await createProduct(ctx.prisma, a, { sku: 'A-2', name: 'Beta' });
    const token = await login(ctx, reader.email, reader.password);

    const res = await request(ctx.http)
      .get(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((p: { sku: string }) => p.sku).sort()).toEqual(['A-1', 'A-2']);
    expect(res.body.pageInfo).toMatchObject({ hasNextPage: false });
  });

  it('3. company A cannot see company B products', async () => {
    const { token } = await makeCatalogUser(ctx);
    const b = await makeCompanyB(ctx);
    await createProduct(ctx.prisma, b, { sku: 'B-1', name: 'Bravo' });

    const res = await request(ctx.http)
      .get(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('4. a forged companyId claim for company B does NOT reveal company B products', async () => {
    const a = await ensureDefaultCompany(ctx.prisma);
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['product:read']);
    await createProduct(ctx.prisma, a, { sku: 'A-only', name: 'OwnTenant' });
    const b = await makeCompanyB(ctx);
    const bProduct = await createProduct(ctx.prisma, b, { sku: 'B-secret', name: 'OtherTenant' });

    const real = await login(ctx, user.email, user.password);
    const forged = forgeTokenFrom(ctx, real, { companyId: b.toString() });

    const res = await request(ctx.http)
      .get(PRODUCTS)
      .set('Authorization', `Bearer ${forged}`)
      .expect(200);
    const skus = res.body.data.map((p: { sku: string }) => p.sku);
    expect(skus).toEqual(['A-only']);
    // And the B product is unreachable by id too (404, not 200).
    await request(ctx.http)
      .get(`${PRODUCTS}/${bProduct.publicId}`)
      .set('Authorization', `Bearer ${forged}`)
      .expect(404);
  });

  it('5. a body companyId is rejected; a clean create lands in the actor’s company', async () => {
    const { token, companyId } = await makeCatalogUser(ctx);
    const b = await makeCompanyB(ctx);

    // forbidNonWhitelisted → an unknown `companyId` field is rejected (400).
    await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'C-1', name: 'WithCompany', companyId: b.toString() })
      .expect(400);

    // A clean create succeeds and is stored under the ACTOR's real company.
    const res = await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'C-2', name: 'CleanCreate' })
      .expect(201);
    expect(res.body).toMatchObject({ sku: 'C-2', name: 'CleanCreate', isActive: true });
    expect(typeof res.body.id).toBe('string');

    const stored = await ctx.prisma.product.findFirstOrThrow({ where: { sku: 'C-2' } });
    expect(stored.companyId).toBe(companyId);
    expect(stored.companyId).not.toBe(b);
  });

  it('6. a duplicate SKU within the same company is rejected → 409', async () => {
    const { token } = await makeCatalogUser(ctx);
    await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'DUP', name: 'First' })
      .expect(201);
    await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'DUP', name: 'Second' })
      .expect(409);
  });

  it('7. two different companies may use the same SKU', async () => {
    const { token } = await makeCatalogUser(ctx);
    const b = await makeCompanyB(ctx);
    await createProduct(ctx.prisma, b, { sku: 'SHARED', name: 'B shared' });

    await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'SHARED', name: 'A shared' })
      .expect(201);
  });

  it('8. a soft-deleted product disappears from list and get', async () => {
    const { token } = await makeCatalogUser(ctx);
    const created = await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'DEL-1', name: 'ToDelete' })
      .expect(201);
    const id = created.body.id as string;

    await request(ctx.http)
      .delete(`${PRODUCTS}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await request(ctx.http)
      .get(`${PRODUCTS}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const list = await request(ctx.http)
      .get(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('9. SKU is reusable after soft delete within the same company (DB partial-unique decision)', async () => {
    const { token } = await makeCatalogUser(ctx);
    const created = await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'REUSE', name: 'Original' })
      .expect(201);
    await request(ctx.http)
      .delete(`${PRODUCTS}/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // The partial unique (`WHERE deleted_at IS NULL`) frees the SKU once deleted.
    await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'REUSE', name: 'Recreated' })
      .expect(201);
  });

  it('10. update only affects the caller’s own company product (cross-tenant → 404)', async () => {
    const { token } = await makeCatalogUser(ctx);
    const b = await makeCompanyB(ctx);
    const own = await createProduct(ctx.prisma, await ensureDefaultCompany(ctx.prisma), {
      sku: 'OWN',
      name: 'Mine',
    });
    const other = await createProduct(ctx.prisma, b, { sku: 'OTHER', name: 'Theirs' });

    const res = await request(ctx.http)
      .patch(`${PRODUCTS}/${own.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(res.body.name).toBe('Renamed');

    await request(ctx.http)
      .patch(`${PRODUCTS}/${other.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked' })
      .expect(404);
    // The other tenant's row is untouched.
    const otherRow = await ctx.prisma.product.findUniqueOrThrow({ where: { id: other.id } });
    expect(otherRow.name).toBe('Theirs');
  });

  it('11. delete only affects the caller’s own company product (cross-tenant → 404)', async () => {
    const { token } = await makeCatalogUser(ctx);
    const b = await makeCompanyB(ctx);
    const other = await createProduct(ctx.prisma, b, { sku: 'OTHER-DEL', name: 'Theirs' });

    await request(ctx.http)
      .delete(`${PRODUCTS}/${other.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const stillThere = await ctx.prisma.product.findUniqueOrThrow({ where: { id: other.id } });
    expect(stillThere.deletedAt).toBeNull();
  });

  it('12. pagination walks the catalog with a cursor', async () => {
    const { token, companyId } = await makeCatalogUser(ctx);
    await createProduct(ctx.prisma, companyId, { sku: 'P-1', name: 'One' });
    await createProduct(ctx.prisma, companyId, { sku: 'P-2', name: 'Two' });
    await createProduct(ctx.prisma, companyId, { sku: 'P-3', name: 'Three' });

    const first = await request(ctx.http)
      .get(`${PRODUCTS}?limit=2`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pageInfo.hasNextPage).toBe(true);
    expect(typeof first.body.pageInfo.nextCursor).toBe('string');

    const second = await request(ctx.http)
      .get(`${PRODUCTS}?limit=2&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pageInfo.hasNextPage).toBe(false);
    expect(second.body.pageInfo.nextCursor).toBeNull();
  });

  it('13. search matches over SKU and name', async () => {
    const { token, companyId } = await makeCatalogUser(ctx);
    await createProduct(ctx.prisma, companyId, { sku: 'WIDGET-1', name: 'Blue Gadget' });
    await createProduct(ctx.prisma, companyId, { sku: 'TOOL-9', name: 'Red Widget' });
    await createProduct(ctx.prisma, companyId, { sku: 'MISC-0', name: 'Nothing' });

    const bySku = await request(ctx.http)
      .get(`${PRODUCTS}?search=widget`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(bySku.body.data.map((p: { sku: string }) => p.sku).sort()).toEqual([
      'TOOL-9',
      'WIDGET-1',
    ]);

    const byName = await request(ctx.http)
      .get(`${PRODUCTS}?search=gadget`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byName.body.data.map((p: { sku: string }) => p.sku)).toEqual(['WIDGET-1']);
  });

  it('14. a not-found product is returned as RFC 7807 problem+json with a requestId', async () => {
    const { token } = await makeCatalogUser(ctx);
    const res = await request(ctx.http)
      .get(`${PRODUCTS}/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(typeof res.body.type).toBe('string');
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('15. mutations require their specific permission (read alone cannot create/update/delete)', async () => {
    const a = await ensureDefaultCompany(ctx.prisma);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['product:read']);
    const existing = await createProduct(ctx.prisma, a, { sku: 'RO', name: 'ReadOnly' });
    const token = await login(ctx, reader.email, reader.password);

    await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'NEW', name: 'Nope' })
      .expect(403);
    await request(ctx.http)
      .patch(`${PRODUCTS}/${existing.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope' })
      .expect(403);
    await request(ctx.http)
      .delete(`${PRODUCTS}/${existing.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    // Reading is allowed.
    await request(ctx.http)
      .get(`${PRODUCTS}/${existing.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('16. create accepts the full product card and writes a same-transaction audit row', async () => {
    const { token, id: actorId } = await makeCatalogUser(ctx);
    const res = await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({
        sku: 'FULL-1',
        name: 'Full Card',
        description: 'A complete product',
        barcode: '8690000000017',
        unit: 'KG',
        vatRate: 1000,
        listPrice: { amount: '12345', currency: 'TRY' },
        criticalStockThreshold: '5',
        isActive: false,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      sku: 'FULL-1',
      name: 'Full Card',
      description: 'A complete product',
      barcode: '8690000000017',
      unit: 'KG',
      vatRate: 1000,
      listPrice: { amount: '12345', currency: 'TRY' },
      criticalStockThreshold: '5',
      isActive: false,
    });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'PRODUCT_CREATED' },
    });
    expect(audit.actorId).toBe(actorId);
    expect(audit.entityType).toBe('product');
    expect(audit.requestId).toBeTruthy();
  });
});
