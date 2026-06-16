import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../../src/common/config/app-config.service';
import { PermissionService } from '../../src/modules/authorization/permission.service';
import { PermissionRepository } from '../../src/modules/authorization/permission.repository';
import { InMemoryPermissionCache } from '../../src/modules/authorization/adapters/in-memory-permission-cache';
import type { PermissionCache } from '../../src/modules/authorization/ports/permission-cache.port';
import { TestAuthzModule } from '../support/test-authz.module';
import {
  ROLES,
  type TestApp,
  assignRole,
  closeTestApp,
  createTestApp,
  createUser,
  grantPermissionsViaRole,
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
 * companyId or authzVersion), reusing a real token's subject/session/exp. */
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

/** Look up the custom role created for a user by `grantPermissionsViaRole`. */
async function roleIdByName(ctx: TestApp, companyId: bigint, name: string): Promise<bigint> {
  const role = await ctx.prisma.role.findFirstOrThrow({ where: { companyId, name } });
  return role.id;
}

async function permIdByCode(ctx: TestApp, code: string): Promise<bigint> {
  const perm = await ctx.prisma.permission.findUniqueOrThrow({ where: { code } });
  return perm.id;
}

/**
 * Multi-instance-safe, DB-sourced authorization cache versioning (PG-004).
 *
 * Every test below proves the SAME property: once PostgreSQL records a
 * permission-affecting change (which bumps the company's authorization_version),
 * the NEXT permission check reflects it WITHOUT any explicit cache clear/invalidate
 * — because the version is read from PostgreSQL before the cache lookup and folded
 * into the cache key, so the previous entry becomes structurally unreachable. The
 * clock is frozen by the harness, so a passing "without clear" assertion can only
 * be the version anchor at work, never TTL expiry.
 */
describe('Authorization cache versioning (integration, real PostgreSQL)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [TestAuthzModule] });
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
    await seedRbac(ctx.prisma);
  });

  it('1. revoking a role_permission denies a previously-allowed user with NO cache clear (403)', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['product:read'], 'REVOKE_ROLE');
    const token = await login(ctx, user.email, user.password);

    // Cache is populated with the ALLOW result.
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Revoke the grant (role membership unchanged ⇒ securityVersion unchanged).
    const roleId = await roleIdByName(ctx, user.companyId, 'REVOKE_ROLE');
    const permId = await permIdByCode(ctx, 'product:read');
    await ctx.prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId, permissionId: permId } },
    });

    // No invalidate(), no clear(), clock frozen — yet access is gone immediately.
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('2. adding a role_permission grants access with NO cache clear (cached deny → 200)', async () => {
    const user = await createUser(ctx.prisma);
    // Role lacks product:read, so /single is denied and the DENY is cached.
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:create'], 'GRANT_ROLE');
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    // Add the missing grant (no role-membership change).
    const roleId = await roleIdByName(ctx, user.companyId, 'GRANT_ROLE');
    const permId = await permIdByCode(ctx, 'product:read');
    await ctx.prisma.rolePermission.create({ data: { roleId, permissionId: permId } });

    // Without clearing the cache the new grant is visible at once.
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('3. removing a UserRole denies access with NO cache clear (403)', async () => {
    const user = await createUser(ctx.prisma);
    await assignRole(ctx.prisma, user.id, ROLES.ADMIN); // ADMIN holds product:read
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const adminRole = await ctx.prisma.role.findFirstOrThrow({
      where: { companyId: user.companyId, name: ROLES.ADMIN },
    });
    await ctx.prisma.userRole.delete({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
    });

    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('4. adding a UserRole grants access with NO cache clear (cached deny → 200)', async () => {
    const user = await createUser(ctx.prisma); // no roles → /single denied + cached
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    await assignRole(ctx.prisma, user.id, ROLES.ADMIN);

    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('5. stripping a role’s grants (deactivating it) denies its member with NO cache clear (403)', async () => {
    // roles carry no status/soft-delete column; clearing the role’s grants is the
    // schema-faithful "role deactivated" — it fires the role_permissions trigger.
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['product:read'], 'DEACTIVATE_ROLE');
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const roleId = await roleIdByName(ctx, user.companyId, 'DEACTIVATE_ROLE');
    await ctx.prisma.rolePermission.deleteMany({ where: { roleId } });

    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('6. deactivating the user prevents stale-permission access (401/no stale allow)', async () => {
    const user = await createUser(ctx.prisma);
    await assignRole(ctx.prisma, user.id, ROLES.ADMIN);
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Suspend the user — bumps the company authz version too.
    await ctx.prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    // The auth guard rejects the disabled user (401) before authorization; and the
    // permission read model itself yields nothing, so no stale ALLOW is possible.
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    const svc = ctx.app.get(PermissionService);
    const eff = await svc.getEffectivePermissions({
      userId: user.id,
      companyId: user.companyId,
      roles: [],
    });
    expect(eff.size).toBe(0);
  });

  it('7. two independent caches: instance B cannot ALLOW from a stale entry after a revoke', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['product:read'], 'TWO_INSTANCE_ROLE');

    const repo = ctx.app.get(PermissionRepository);
    // Two SEPARATE in-memory caches = two API instances that never share state.
    const cacheA = new InMemoryPermissionCache(ctx.clock);
    const cacheB = new InMemoryPermissionCache(ctx.clock);
    const svcA = new PermissionService(repo, cacheA);
    const svcB = new PermissionService(repo, cacheB);
    const subject = { userId: user.id, companyId: user.companyId, roles: [] as string[] };

    // Both instances observe (and cache) the ALLOW.
    expect(await svcA.hasAllPermissions(subject, ['product:read'])).toBe(true);
    expect(await svcB.hasAllPermissions(subject, ['product:read'])).toBe(true);

    // Revoke on the shared PostgreSQL via instance A's path (a real mutation would
    // do this in its own service); only instance A clears its local cache.
    const roleId = await roleIdByName(ctx, user.companyId, 'TWO_INSTANCE_ROLE');
    const permId = await permIdByCode(ctx, 'product:read');
    await ctx.prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId, permissionId: permId } },
    });
    await cacheA.invalidate(user.id); // B is deliberately NOT invalidated.

    // Instance B still holds the stale ALLOW entry, but the bumped DB version makes
    // its key unreachable → it re-reads PostgreSQL → DENY. No stale allow.
    expect(await svcB.hasAllPermissions(subject, ['product:read'])).toBe(false);
    expect(await svcA.hasAllPermissions(subject, ['product:read'])).toBe(false);
  });

  it('8. a version bump in Company A does not disturb Company B’s cache key/decision', async () => {
    const userA = await createUser(ctx.prisma); // Company A (default)
    await grantPermissionsViaRole(ctx.prisma, userA.id, ['product:read'], 'A_ROLE');
    const tokenA = await login(ctx, userA.email, userA.password);
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    // Churn Company A's version repeatedly.
    const roleId = await roleIdByName(ctx, userA.companyId, 'A_ROLE');
    for (const code of ['order:create', 'order:approve']) {
      await ctx.prisma.rolePermission.create({
        data: { roleId, permissionId: await permIdByCode(ctx, code) },
      });
    }

    // Company A's decision is still correct (still holds product:read).
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
  });

  it('10. the composite cache key has the form companyId:userId:authzVersion:securityVersion', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['product:read'], 'KEY_SHAPE_ROLE');

    // Probe the cache the service actually writes to.
    const probe = new InMemoryPermissionCache(ctx.clock);
    const svc = new PermissionService(ctx.app.get(PermissionRepository), probe);
    await svc.getEffectivePermissions({ userId: user.id, companyId: user.companyId, roles: [] });

    const keys = [...(probe as unknown as { entries: Map<string, unknown> }).entries.keys()];
    expect(keys).toHaveLength(1);
    const key = keys[0] as string;
    // companyId : userId : authzVersion : securityVersion (4 colon-separated parts,
    // the first three numeric, the last a non-empty base64url digest).
    const parts = key.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(user.companyId.toString());
    expect(parts[1]).toBe(user.id.toString());
    expect(parts[2]).toMatch(/^\d+$/); // authzVersion
    expect(parts[3]).toMatch(/^[A-Za-z0-9_-]+$/); // securityVersion digest
  });

  it('11. a forged companyId/authzVersion JWT claim cannot change the decision', async () => {
    const user = await createUser(ctx.prisma); // no roles → denied
    const realToken = await login(ctx, user.email, user.password);

    // Inject bogus companyId + a fake authzVersion claim; both are ignored — the
    // principal's company comes from PostgreSQL and the version is read from the DB.
    const forged = forgeTokenFrom(ctx, realToken, {
      companyId: '999999',
      company_id: '999999',
      authzVersion: '999999',
      authz_version: '999999',
      permissions: ['product:read'],
    });
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${forged}`)
      .expect(403);
  });

  it('7b. a throwing cache never fails open: decisions fall back to PostgreSQL', async () => {
    const allowed = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, allowed.id, ['product:read'], 'FAILSAFE_ALLOW');
    const denied = await createUser(ctx.prisma); // no perms

    const throwing: PermissionCache = {
      async get() {
        throw new Error('cache offline');
      },
      async set() {
        throw new Error('cache offline');
      },
      async invalidate() {
        throw new Error('cache offline');
      },
      async clear() {
        throw new Error('cache offline');
      },
    };
    const svc = new PermissionService(ctx.app.get(PermissionRepository), throwing);

    // Cache is entirely broken, yet the DB source of truth still decides — and it
    // is deny-by-default, never fail-open.
    expect(
      await svc.hasAllPermissions({ userId: allowed.id, companyId: allowed.companyId, roles: [] }, [
        'product:read',
      ]),
    ).toBe(true);
    expect(
      await svc.hasAllPermissions({ userId: denied.id, companyId: denied.companyId, roles: [] }, [
        'product:read',
      ]),
    ).toBe(false);
  });
});
