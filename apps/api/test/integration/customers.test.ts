import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCompanyRbac } from '@b2b/database';
import { AppConfigService } from '../../src/common/config/app-config.service';
import {
  type TestApp,
  closeTestApp,
  createCompany,
  createCustomer,
  createTestApp,
  createUser,
  ensureDefaultCompany,
  grantPermissionsViaRole,
  resetState,
  seedRbac,
} from './helpers';

const BASE = '/api/v1';
const AUTH = `${BASE}/auth`;
const CUSTOMERS = `${BASE}/customers`;

const ALL_CUSTOMER_PERMS = [
  'customer:read',
  'customer:create',
  'customer:update',
  'customer:delete',
];

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

/** A company-A user holding every customer permission, plus its bearer token. */
async function makeCustomerUser(
  ctx: TestApp,
): Promise<{ token: string; companyId: bigint; id: bigint }> {
  const a = await ensureDefaultCompany(ctx.prisma);
  const user = await createUser(ctx.prisma, { companyId: a });
  await grantPermissionsViaRole(ctx.prisma, user.id, ALL_CUSTOMER_PERMS);
  const token = await login(ctx, user.email, user.password);
  return { token, companyId: a, id: user.id };
}

async function makeCompanyB(ctx: TestApp): Promise<bigint> {
  const companyB = await createCompany(ctx.prisma, 'Company B');
  await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, companyB));
  return companyB;
}

describe('Customers (integration, real PostgreSQL)', () => {
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

  it('1. an unauthorized user (no customer:read) cannot list → 403', async () => {
    const a = await ensureDefaultCompany(ctx.prisma);
    const user = await createUser(ctx.prisma, { companyId: a }); // no roles/permissions
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http).get(CUSTOMERS).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('1b. an unauthenticated request is rejected by the global JwtAuthGuard → 401', async () => {
    await request(ctx.http).get(CUSTOMERS).expect(401);
  });

  it('2. a customer:read user lists its own company customers', async () => {
    const a = await ensureDefaultCompany(ctx.prisma);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['customer:read']);
    await createCustomer(ctx.prisma, a, { code: 'A-1', name: 'Alpha' });
    await createCustomer(ctx.prisma, a, { code: 'A-2', name: 'Beta' });
    const token = await login(ctx, reader.email, reader.password);

    const res = await request(ctx.http)
      .get(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((c: { code: string }) => c.code).sort()).toEqual(['A-1', 'A-2']);
    expect(res.body.pageInfo).toMatchObject({ hasNextPage: false });
  });

  it('3. company A cannot see company B customers', async () => {
    const { token } = await makeCustomerUser(ctx);
    const b = await makeCompanyB(ctx);
    await createCustomer(ctx.prisma, b, { code: 'B-1', name: 'Bravo' });

    const res = await request(ctx.http)
      .get(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('4. a forged companyId claim for company B does NOT reveal company B customers', async () => {
    const a = await ensureDefaultCompany(ctx.prisma);
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['customer:read']);
    await createCustomer(ctx.prisma, a, { code: 'A-only', name: 'OwnTenant' });
    const b = await makeCompanyB(ctx);
    const bCustomer = await createCustomer(ctx.prisma, b, {
      code: 'B-secret',
      name: 'OtherTenant',
    });

    const real = await login(ctx, user.email, user.password);
    const forged = forgeTokenFrom(ctx, real, { companyId: b.toString() });

    const res = await request(ctx.http)
      .get(CUSTOMERS)
      .set('Authorization', `Bearer ${forged}`)
      .expect(200);
    const codes = res.body.data.map((c: { code: string }) => c.code);
    expect(codes).toEqual(['A-only']);
    // And the B customer is unreachable by id too (404, not 200).
    await request(ctx.http)
      .get(`${CUSTOMERS}/${bCustomer.publicId}`)
      .set('Authorization', `Bearer ${forged}`)
      .expect(404);
  });

  it('5. a body companyId is rejected; a clean create lands in the actor’s company', async () => {
    const { token, companyId } = await makeCustomerUser(ctx);
    const b = await makeCompanyB(ctx);

    // forbidNonWhitelisted → an unknown `companyId` field is rejected (400).
    await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'C-1', name: 'WithCompany', companyId: b.toString() })
      .expect(400);

    // A clean create succeeds and is stored under the ACTOR's real company.
    const res = await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'C-2', name: 'CleanCreate' })
      .expect(201);
    expect(res.body).toMatchObject({ code: 'C-2', name: 'CleanCreate', type: 'COMPANY' });
    expect(typeof res.body.id).toBe('string');

    const stored = await ctx.prisma.customer.findFirstOrThrow({ where: { code: 'C-2' } });
    expect(stored.companyId).toBe(companyId);
    expect(stored.companyId).not.toBe(b);
  });

  it('6. a duplicate code within the same company is rejected → 409', async () => {
    const { token } = await makeCustomerUser(ctx);
    await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'DUP', name: 'First' })
      .expect(201);
    await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'DUP', name: 'Second' })
      .expect(409);
  });

  it('7. two different companies may use the same code', async () => {
    const { token } = await makeCustomerUser(ctx);
    const b = await makeCompanyB(ctx);
    await createCustomer(ctx.prisma, b, { code: 'SHARED', name: 'B shared' });

    await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SHARED', name: 'A shared' })
      .expect(201);
  });

  it('8. a soft-deleted customer disappears from list and get', async () => {
    const { token } = await makeCustomerUser(ctx);
    const created = await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'DEL-1', name: 'ToDelete' })
      .expect(201);
    const id = created.body.id as string;

    await request(ctx.http)
      .delete(`${CUSTOMERS}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await request(ctx.http)
      .get(`${CUSTOMERS}/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const list = await request(ctx.http)
      .get(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('9/10. code is reusable after soft delete within the same company (DB partial-unique decision)', async () => {
    const { token } = await makeCustomerUser(ctx);
    const created = await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'REUSE', name: 'Original' })
      .expect(201);
    await request(ctx.http)
      .delete(`${CUSTOMERS}/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // The partial unique (`WHERE deleted_at IS NULL`) frees the code once deleted.
    const recreated = await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'REUSE', name: 'Recreated' })
      .expect(201);
    // It is a genuinely new row (the soft-deleted original is left untouched).
    expect(recreated.body.id).not.toBe(created.body.id);
  });

  it('11. update only affects the caller’s own company customer (cross-tenant → 404)', async () => {
    const { token } = await makeCustomerUser(ctx);
    const b = await makeCompanyB(ctx);
    const own = await createCustomer(ctx.prisma, await ensureDefaultCompany(ctx.prisma), {
      code: 'OWN',
      name: 'Mine',
    });
    const other = await createCustomer(ctx.prisma, b, { code: 'OTHER', name: 'Theirs' });

    const res = await request(ctx.http)
      .patch(`${CUSTOMERS}/${own.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(res.body.name).toBe('Renamed');

    await request(ctx.http)
      .patch(`${CUSTOMERS}/${other.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked' })
      .expect(404);
    // The other tenant's row is untouched.
    const otherRow = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: other.id } });
    expect(otherRow.name).toBe('Theirs');
  });

  it('12/13. delete only affects the caller’s own company customer (cross-tenant → 404)', async () => {
    const { token } = await makeCustomerUser(ctx);
    const b = await makeCompanyB(ctx);
    const other = await createCustomer(ctx.prisma, b, { code: 'OTHER-DEL', name: 'Theirs' });

    await request(ctx.http)
      .delete(`${CUSTOMERS}/${other.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const stillThere = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: other.id } });
    expect(stillThere.deletedAt).toBeNull();
  });

  it('14. pagination walks the customers with a cursor', async () => {
    const { token, companyId } = await makeCustomerUser(ctx);
    await createCustomer(ctx.prisma, companyId, { code: 'P-1', name: 'One' });
    await createCustomer(ctx.prisma, companyId, { code: 'P-2', name: 'Two' });
    await createCustomer(ctx.prisma, companyId, { code: 'P-3', name: 'Three' });

    const first = await request(ctx.http)
      .get(`${CUSTOMERS}?limit=2`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pageInfo.hasNextPage).toBe(true);
    expect(typeof first.body.pageInfo.nextCursor).toBe('string');

    const second = await request(ctx.http)
      .get(`${CUSTOMERS}?limit=2&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pageInfo.hasNextPage).toBe(false);
    expect(second.body.pageInfo.nextCursor).toBeNull();
  });

  it('15. search matches over code, name, email and taxNumber', async () => {
    const { token, companyId } = await makeCustomerUser(ctx);
    await createCustomer(ctx.prisma, companyId, {
      code: 'ACME-1',
      name: 'Blue Trading',
      email: 'hello@blue.example',
      taxNumber: '111222333',
    });
    await createCustomer(ctx.prisma, companyId, {
      code: 'TOOL-9',
      name: 'Red Acme Co',
      email: 'sales@red.example',
      taxNumber: '999888777',
    });
    await createCustomer(ctx.prisma, companyId, { code: 'MISC-0', name: 'Nothing' });

    const byCode = await request(ctx.http)
      .get(`${CUSTOMERS}?search=acme`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byCode.body.data.map((c: { code: string }) => c.code).sort()).toEqual([
      'ACME-1',
      'TOOL-9',
    ]);

    const byEmail = await request(ctx.http)
      .get(`${CUSTOMERS}?search=blue.example`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byEmail.body.data.map((c: { code: string }) => c.code)).toEqual(['ACME-1']);

    const byTax = await request(ctx.http)
      .get(`${CUSTOMERS}?search=999888`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byTax.body.data.map((c: { code: string }) => c.code)).toEqual(['TOOL-9']);
  });

  it('16. a not-found customer is returned as RFC 7807 problem+json with a requestId', async () => {
    const { token } = await makeCustomerUser(ctx);
    const res = await request(ctx.http)
      .get(`${CUSTOMERS}/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(typeof res.body.type).toBe('string');
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('17. mutations require their specific permission (read alone cannot create/update/delete)', async () => {
    const a = await ensureDefaultCompany(ctx.prisma);
    const reader = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, reader.id, ['customer:read']);
    const existing = await createCustomer(ctx.prisma, a, { code: 'RO', name: 'ReadOnly' });
    const token = await login(ctx, reader.email, reader.password);

    await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'NEW', name: 'Nope' })
      .expect(403);
    await request(ctx.http)
      .patch(`${CUSTOMERS}/${existing.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope' })
      .expect(403);
    await request(ctx.http)
      .delete(`${CUSTOMERS}/${existing.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    // Reading is allowed.
    await request(ctx.http)
      .get(`${CUSTOMERS}/${existing.publicId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('18. create accepts the full customer card and writes a same-transaction audit row', async () => {
    const { token, id: actorId } = await makeCustomerUser(ctx);
    const res = await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'FULL-1',
        name: 'Full Card',
        type: 'INDIVIDUAL',
        taxNumber: '1234567890',
        email: 'full@card.example',
        phone: '+90 212 000 0000',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      code: 'FULL-1',
      name: 'Full Card',
      type: 'INDIVIDUAL',
      taxNumber: '1234567890',
      email: 'full@card.example',
      phone: '+90 212 000 0000',
    });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'CUSTOMER_CREATED' },
    });
    expect(audit.actorId).toBe(actorId);
    expect(audit.entityType).toBe('customer');
    expect(audit.requestId).toBeTruthy();
  });

  it('19. an invalid email and an unknown type are rejected with 400 (not 500)', async () => {
    const { token } = await makeCustomerUser(ctx);
    const bad = await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'BAD-EMAIL', name: 'X', email: 'not-an-email' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });

    await request(ctx.http)
      .post(CUSTOMERS)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'BAD-TYPE', name: 'X', type: 'ROBOT' })
      .expect(400);
  });
});
