import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCompanyRbac } from '@b2b/database';
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
const IMPORTS = `${BASE}/products/imports`;
const EXPORT = `${BASE}/products/export`;
const PRODUCTS = `${BASE}/products`;

const HEADER = 'sku,name,currency,listPriceAmount,taxRateBp';

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** A company-A user holding the given catalog permissions, plus its token. */
async function makeUserWith(
  ctx: TestApp,
  perms: string[],
): Promise<{ token: string; companyId: bigint; id: bigint }> {
  const a = await ensureDefaultCompany(ctx.prisma);
  const user = await createUser(ctx.prisma, { companyId: a });
  if (perms.length > 0) await grantPermissionsViaRole(ctx.prisma, user.id, perms);
  const token = await login(ctx, user.email, user.password);
  return { token, companyId: a, id: user.id };
}

async function makeCompanyB(ctx: TestApp): Promise<bigint> {
  const companyB = await createCompany(ctx.prisma, 'Company B');
  await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, companyB));
  return companyB;
}

/** POST a CSV buffer as the multipart `file` field. */
function postImport(ctx: TestApp, token: string, csv: string, filename = 'products.csv') {
  return request(ctx.http)
    .post(IMPORTS)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(csv, 'utf8'), { filename, contentType: 'text/csv' });
}

describe('Product import/export (integration, real PostgreSQL)', () => {
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

  // --- permissions ---------------------------------------------------------

  it('1. import without product:import → 403', async () => {
    const { token } = await makeUserWith(ctx, ['product:read']);
    await postImport(ctx, token, `${HEADER}\nA-1,Alpha,TRY,1000,2000`).expect(403);
  });

  it('2. export without product:export → 403', async () => {
    const { token } = await makeUserWith(ctx, ['product:read']);
    await request(ctx.http).get(EXPORT).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('1b. unauthenticated import/export → 401', async () => {
    await request(ctx.http).get(EXPORT).expect(401);
    await request(ctx.http).post(IMPORTS).expect(401);
  });

  // --- import success ------------------------------------------------------

  it('3+4. a valid file imports and writes the products correctly', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    const csv =
      `sku,name,currency,listPriceAmount,taxRateBp,description,criticalStockThreshold,isActive\n` +
      `A-1,Alpha,TRY,1000,2000,First,5,true\n` +
      `A-2,Beta,USD,250,1000,,,false`;
    const res = await postImport(ctx, token, csv).expect(201);
    expect(res.body).toMatchObject({
      status: 'COMPLETED',
      totalRows: 2,
      validRows: 2,
      invalidRows: 0,
      appliedRows: 2,
      errors: [],
    });
    expect(typeof res.body.id).toBe('string');
    expect(res.body.checksum).toBe(
      createHash('sha256').update(Buffer.from(csv, 'utf8')).digest('hex'),
    );

    const rows = await ctx.prisma.product.findMany({
      where: { companyId },
      orderBy: { sku: 'asc' },
    });
    expect(rows.map((r) => r.sku)).toEqual(['A-1', 'A-2']);
    const a1 = rows[0]!;
    expect(a1).toMatchObject({
      name: 'Alpha',
      currency: 'TRY',
      listPriceAmount: 1000n,
      taxRateBp: 2000,
      description: 'First',
      criticalStockThreshold: 5n,
      isActive: true,
    });
    const a2 = rows[1]!;
    expect(a2).toMatchObject({
      currency: 'USD',
      listPriceAmount: 250n,
      isActive: false,
      description: null,
      criticalStockThreshold: null,
    });
  });

  it('GET /imports/:id returns a completed import', async () => {
    const { token } = await makeUserWith(ctx, ['product:import']);
    const created = await postImport(ctx, token, `${HEADER}\nG-1,Gamma,TRY,500,2000`).expect(201);
    const id = created.body.id as string;
    const res = await request(ctx.http)
      .get(`${IMPORTS}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({ id, status: 'COMPLETED', appliedRows: 1, totalRows: 1 });
  });

  it('GET /imports/:id for an unknown id → 404 problem+json', async () => {
    const { token } = await makeUserWith(ctx, ['product:import']);
    const res = await request(ctx.http)
      .get(`${IMPORTS}/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  // --- duplicate SKU -------------------------------------------------------

  it('5. duplicate SKU within the same company import fails (422), nothing written', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    // existing product with the same SKU
    await createProduct(ctx.prisma, companyId, { sku: 'DUP', name: 'Existing' });
    const res = await postImport(ctx, token, `${HEADER}\nDUP,New,TRY,100,2000`).expect(422);
    expect(res.body).toMatchObject({ status: 422, code: 'BUSINESS_RULE' });
    expect(await ctx.prisma.product.count({ where: { companyId, name: 'New' } })).toBe(0);
  });

  it('5b. duplicate SKU within the FILE fails (422), nothing written', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    const csv = `${HEADER}\nX-1,One,TRY,100,2000\nX-1,Two,TRY,200,2000`;
    await postImport(ctx, token, csv).expect(422);
    expect(await ctx.prisma.product.count({ where: { companyId } })).toBe(0);
  });

  it('6. the same SKU in a DIFFERENT company imports fine', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    const b = await makeCompanyB(ctx);
    await createProduct(ctx.prisma, b, { sku: 'SHARED', name: 'B shared' });
    await postImport(ctx, token, `${HEADER}\nSHARED,A shared,TRY,100,2000`).expect(201);
    expect(await ctx.prisma.product.count({ where: { companyId, sku: 'SHARED' } })).toBe(1);
  });

  // --- structural / row validation ----------------------------------------

  it('7. a missing required column → 400, nothing written', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    const res = await postImport(
      ctx,
      token,
      `sku,name,currency,listPriceAmount\nA-1,Alpha,TRY,100`,
    ).expect(400);
    expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(await ctx.prisma.product.count({ where: { companyId } })).toBe(0);
  });

  it('8. an over-range listPriceAmount → 422 (NOT 500), nothing written', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    const over = '99999999999999999999';
    const res = await postImport(ctx, token, `${HEADER}\nA-1,Alpha,TRY,${over},2000`);
    expect(res.status).toBe(422);
    expect(await ctx.prisma.product.count({ where: { companyId } })).toBe(0);
  });

  it('9. an invalid taxRateBp → 422, nothing written', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    await postImport(ctx, token, `${HEADER}\nA-1,Alpha,TRY,100,99999`).expect(422);
    await postImport(ctx, token, `${HEADER}\nA-2,Beta,TRY,100,abc`).expect(422);
    expect(await ctx.prisma.product.count({ where: { companyId } })).toBe(0);
  });

  it('10. an invalid currency → 422, nothing written', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    await postImport(ctx, token, `${HEADER}\nA-1,Alpha,TRYX,100,2000`).expect(422);
    await postImport(ctx, token, `${HEADER}\nA-2,Beta,12,100,2000`).expect(422);
    expect(await ctx.prisma.product.count({ where: { companyId } })).toBe(0);
  });

  it('11. one bad row in a multi-row file rolls back ALL rows (all-or-nothing)', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    const csv =
      `${HEADER}\n` +
      `OK-1,Good,TRY,100,2000\n` +
      `BAD-1,Bad,TRY,-5,2000\n` + // negative price → invalid
      `OK-2,Good2,TRY,200,2000`;
    const res = await postImport(ctx, token, csv).expect(422);
    // The per-row error mentions the offending row.
    expect(JSON.stringify(res.body.errors)).toContain('Row 2');
    expect(await ctx.prisma.product.count({ where: { companyId } })).toBe(0);
  });

  // --- forged tenant -------------------------------------------------------

  it('12. a companyId column is rejected → 400', async () => {
    const { token } = await makeUserWith(ctx, ['product:import']);
    const csv = `${HEADER},companyId\nA-1,Alpha,TRY,100,2000,999`;
    await postImport(ctx, token, csv).expect(400);
  });

  it('12b. a companyId multipart field is rejected → 400', async () => {
    const { token } = await makeUserWith(ctx, ['product:import']);
    await request(ctx.http)
      .post(IMPORTS)
      .set('Authorization', `Bearer ${token}`)
      .field('companyId', '999')
      .attach('file', Buffer.from(`${HEADER}\nA-1,Alpha,TRY,100,2000`, 'utf8'), {
        filename: 'p.csv',
        contentType: 'text/csv',
      })
      .expect(400);
  });

  it('12c. a missing file → 400', async () => {
    const { token } = await makeUserWith(ctx, ['product:import']);
    await request(ctx.http).post(IMPORTS).set('Authorization', `Bearer ${token}`).expect(400);
  });

  // --- audit ---------------------------------------------------------------

  it('13. a successful import writes a same-transaction business audit row', async () => {
    const { token, id: actorId } = await makeUserWith(ctx, ['product:import']);
    await postImport(ctx, token, `${HEADER}\nA-1,Alpha,TRY,100,2000`).expect(201);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'PRODUCT_IMPORTED' },
    });
    expect(audit.actorId).toBe(actorId);
    expect(audit.entityType).toBe('product_import');
    expect(audit.requestId).toBeTruthy();
  });

  it('14. a failed import leaves NO products and NO audit row', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    await postImport(ctx, token, `${HEADER}\nA-1,Alpha,TRY,-5,2000`).expect(422);
    expect(await ctx.prisma.product.count({ where: { companyId } })).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_IMPORTED' } })).toBe(0);
    expect(await ctx.prisma.importJob.count()).toBe(0);
  });

  // --- duplicate file checksum --------------------------------------------

  it('15. re-importing the exact same file → 409 (duplicate checksum policy)', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:import']);
    const csv = `${HEADER}\nDUP-FILE,Once,TRY,100,2000`;
    await postImport(ctx, token, csv).expect(201);
    const res = await postImport(ctx, token, csv).expect(409);
    expect(res.body).toMatchObject({ status: 409, code: 'CONFLICT' });
    // Still exactly one product (the second import wrote nothing).
    expect(await ctx.prisma.product.count({ where: { companyId, sku: 'DUP-FILE' } })).toBe(1);
  });

  // --- export --------------------------------------------------------------

  it('16+17. export contains only the actor company products (no cross-tenant leak)', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:export']);
    await createProduct(ctx.prisma, companyId, { sku: 'A-EXP', name: 'Mine' });
    const b = await makeCompanyB(ctx);
    await createProduct(ctx.prisma, b, { sku: 'B-EXP', name: 'Theirs' });

    const res = await request(ctx.http)
      .get(EXPORT)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.text).toContain('A-EXP');
    expect(res.text).not.toContain('B-EXP');
  });

  it('18. export sets the CSV content-type and an attachment filename', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:export']);
    await createProduct(ctx.prisma, companyId, { sku: 'A-CT', name: 'Mine' });
    const res = await request(ctx.http)
      .get(EXPORT)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="products-\d{8}\.csv"/,
    );
    // The header row mirrors the import schema.
    expect(res.text.split('\r\n')[0]).toBe(
      'sku,name,description,currency,listPriceAmount,taxRateBp,criticalStockThreshold,isActive',
    );
  });

  it('19. export honours the same filters as the product list (default active, search, isActive)', async () => {
    const { token, companyId } = await makeUserWith(ctx, ['product:export']);
    await createProduct(ctx.prisma, companyId, {
      sku: 'ACT-1',
      name: 'Active One',
      isActive: true,
    });
    await createProduct(ctx.prisma, companyId, { sku: 'INA-1', name: 'Inactive', isActive: false });
    await createProduct(ctx.prisma, companyId, {
      sku: 'DEL-1',
      name: 'Deleted',
      deletedAt: new Date(),
    });

    // Default: active only; soft-deleted always excluded.
    const def = await request(ctx.http)
      .get(EXPORT)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(def.text).toContain('ACT-1');
    expect(def.text).not.toContain('INA-1');
    expect(def.text).not.toContain('DEL-1');

    // isActive=false → only inactive.
    const inactive = await request(ctx.http)
      .get(`${EXPORT}?isActive=false`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(inactive.text).toContain('INA-1');
    expect(inactive.text).not.toContain('ACT-1');

    // search over sku/name.
    const search = await request(ctx.http)
      .get(`${EXPORT}?search=Active`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(search.text).toContain('ACT-1');
    expect(search.text).not.toContain('INA-1');
  });

  it('round-trip: an export can be re-imported into another company', async () => {
    const { token: tokA, companyId: a } = await makeUserWith(ctx, ['product:export']);
    await createProduct(ctx.prisma, a, { sku: 'RT-1', name: 'RoundTrip' });
    const exp = await request(ctx.http)
      .get(EXPORT)
      .set('Authorization', `Bearer ${tokA}`)
      .expect(200);

    const b = await makeCompanyB(ctx);
    const userB = await createUser(ctx.prisma, { companyId: b });
    await grantPermissionsViaRole(ctx.prisma, userB.id, ['product:import']);
    const tokB = await login(ctx, userB.email, userB.password);

    await request(ctx.http)
      .post(IMPORTS)
      .set('Authorization', `Bearer ${tokB}`)
      .attach('file', Buffer.from(exp.text, 'utf8'), {
        filename: 're.csv',
        contentType: 'text/csv',
      })
      .expect(201);
    expect(await ctx.prisma.product.count({ where: { companyId: b, sku: 'RT-1' } })).toBe(1);
  });

  // --- existing catalog CRUD is untouched ----------------------------------

  it('20. existing catalog CRUD still works alongside the new routes', async () => {
    const { token } = await makeUserWith(ctx, ['product:create', 'product:read']);
    const created = await request(ctx.http)
      .post(PRODUCTS)
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'CRUD-1', name: 'StillWorks' })
      .expect(201);
    await request(ctx.http)
      .get(`${PRODUCTS}/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
