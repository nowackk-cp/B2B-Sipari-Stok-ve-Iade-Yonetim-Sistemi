import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCompanyRbac } from '@b2b/database';
import { AppConfigService } from '../../src/common/config/app-config.service';
import { PermissionRepository } from '../../src/modules/authorization/permission.repository';
import { TestAuthzModule } from '../support/test-authz.module';
import {
  ROLES,
  type TestApp,
  addPermissionToRole,
  assignRole,
  closeTestApp,
  createCompany,
  createTestApp,
  createUser,
  resetState,
  seedRbac,
} from './helpers';

const BASE = '/api/v1';
const AUTH = `${BASE}/auth`;

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Forge a validly-signed token carrying arbitrary EXTRA claims (e.g. a fake
 * companyId), reusing a real token's subject/session/exp. */
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

/** Stand up a second, fully-seeded company (its own SYSTEM_ADMIN/ADMIN rows). */
async function makeCompanyB(ctx: TestApp): Promise<bigint> {
  const companyB = await createCompany(ctx.prisma, 'Company B');
  await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, companyB));
  return companyB;
}

describe('RBAC tenant isolation (integration, real PostgreSQL)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [TestAuthzModule] });
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
    await seedRbac(ctx.prisma); // Company A = the default seeded company.
  });

  it('1. grants a Company A user holding a Company A role', async () => {
    const user = await createUser(ctx.prisma); // default (Company A)
    await assignRole(ctx.prisma, user.id, ROLES.ADMIN); // Company A ADMIN holds product:read
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('4. a permission added to Company A ADMIN does not reach a Company B user', async () => {
    const companyB = await makeCompanyB(ctx);

    const userA = await createUser(ctx.prisma); // Company A
    await assignRole(ctx.prisma, userA.id, ROLES.ADMIN);
    const userB = await createUser(ctx.prisma, { companyId: companyB });
    await assignRole(ctx.prisma, userB.id, ROLES.ADMIN); // Company B's own ADMIN

    // Grant system:read to Company A's ADMIN only.
    await addPermissionToRole(ctx.prisma, ROLES.ADMIN, 'system:read');

    const tokenA = await login(ctx, userA.email, userA.password);
    const tokenB = await login(ctx, userB.email, userB.password);

    // A sees the new permission…
    await request(ctx.http)
      .get(`${BASE}/test-authz/system`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    // …B (different tenant, same role name) does not.
    await request(ctx.http)
      .get(`${BASE}/test-authz/system`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
  });

  it('6. a forged companyId claim does not reach another tenant’s permissions', async () => {
    const companyB = await makeCompanyB(ctx);
    // A user in Company B with NO roles.
    const userB = await createUser(ctx.prisma, { companyId: companyB });
    const realToken = await login(ctx, userB.email, userB.password);

    // Find Company A's id (the default company) to forge it into the token.
    const companyA = await ctx.prisma.company.findFirstOrThrow({
      where: { name: 'Default Company' },
    });
    const forged = forgeTokenFrom(ctx, realToken, {
      companyId: companyA.id.toString(),
      company_id: companyA.id.toString(),
    });

    // The principal's company comes from PostgreSQL, so the forged claim is ignored.
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${forged}`)
      .expect(403);
  });

  it('7. a Company A SYSTEM_ADMIN grants nothing to a Company B user', async () => {
    const companyB = await makeCompanyB(ctx);

    const adminA = await createUser(ctx.prisma); // Company A
    await assignRole(ctx.prisma, adminA.id, ROLES.SYSTEM_ADMIN); // protected, holds system:read
    const plainB = await createUser(ctx.prisma, { companyId: companyB }); // no roles

    const tokenA = await login(ctx, adminA.email, adminA.password);
    const tokenB = await login(ctx, plainB.email, plainB.password);

    await request(ctx.http)
      .get(`${BASE}/test-authz/system`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    await request(ctx.http)
      .get(`${BASE}/test-authz/system`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
  });

  it('8. being a protected SYSTEM_ADMIN never bypasses the company filter', async () => {
    const companyB = await makeCompanyB(ctx);
    const adminB = await createUser(ctx.prisma, { companyId: companyB });
    await assignRole(ctx.prisma, adminB.id, ROLES.SYSTEM_ADMIN); // Company B's protected SYSTEM_ADMIN

    const repo = ctx.app.get(PermissionRepository);
    const companyA = await ctx.prisma.company.findFirstOrThrow({
      where: { name: 'Default Company' },
    });

    // In their own tenant the SYSTEM_ADMIN resolves the full catalog…
    const inB = await repo.loadEffectivePermissionCodes(adminB.id, companyB);
    expect(inB).toContain('system:read');
    // …but asking for the SAME user scoped to Company A yields nothing — protected
    // status does not cross the tenant boundary.
    const inA = await repo.loadEffectivePermissionCodes(adminB.id, companyA.id);
    expect(inA).toEqual([]);
  });

  it('9. PermissionRepository excludes cross-company relations', async () => {
    const companyB = await makeCompanyB(ctx);
    const userA = await createUser(ctx.prisma); // Company A
    await assignRole(ctx.prisma, userA.id, ROLES.ADMIN);

    const repo = ctx.app.get(PermissionRepository);
    // Scoped to the user's real company → their grants.
    const inA = await repo.loadEffectivePermissionCodes(userA.id, userA.companyId);
    expect(inA).toContain('product:read');
    // Scoped to a foreign company → empty (no cross-company leakage).
    const inB = await repo.loadEffectivePermissionCodes(userA.id, companyB);
    expect(inB).toEqual([]);
  });

  it('10. the cache key never collides across companies for the same userId', async () => {
    const cache = ctx.permissionCache;
    const userId = 12345n;
    const version = 'v1';
    await cache.set(1n, userId, version, new Set(['product:read']));
    // Same userId + version but a different company must miss.
    expect(await cache.get(2n, userId, version)).toBeNull();
    // The original tenant entry is intact.
    const same = await cache.get(1n, userId, version);
    expect(same && [...same]).toEqual(['product:read']);
  });
});
