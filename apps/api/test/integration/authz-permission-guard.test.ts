import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSION_MATRIX } from '@b2b/domain';
import { AppConfigService } from '../../src/common/config/app-config.service';
import { PermissionService } from '../../src/modules/authorization/permission.service';
import { TestAuthzModule } from '../support/test-authz.module';
import {
  ROLES,
  type TestApp,
  assignRole,
  addPermissionToRole,
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

/** Forge a validly-signed access token carrying arbitrary EXTRA claims (e.g. a
 * fake `permissions` array), reusing a real token's subject/session/exp. Proves
 * the guard ignores JWT-supplied authorization and trusts only PostgreSQL. */
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

describe('PermissionGuard (integration, real PostgreSQL)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [TestAuthzModule] });
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    // resetState (in helpers) truncates + clears caches; then reseed the RBAC catalog.
    await resetState(ctx);
    await seedRbac(ctx.prisma);
  });

  it('1. grants access to a user holding the required permission', async () => {
    const user = await createUser(ctx.prisma);
    await assignRole(ctx.prisma, user.id, ROLES.ADMIN); // ADMIN holds product:read
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('2. denies (403) a user lacking the required permission', async () => {
    const user = await createUser(ctx.prisma); // no roles → no permissions
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('3. rejects an unauthenticated request (401)', async () => {
    await request(ctx.http).get(`${BASE}/test-authz/single`).expect(401);
  });

  it('4. denies (403) when only some of several required permissions are held', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:create']); // missing order:approve
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${BASE}/test-authz/multiple`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('5. merges permissions arriving through two different roles', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:create']);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:approve']);
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${BASE}/test-authz/multiple`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('6. a permission granted by two roles still grants access (duplicates are harmless)', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['product:read']);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['product:read']);
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const service = ctx.app.get(PermissionService);
    const effective = await service.getEffectivePermissions({ userId: user.id, roles: [] });
    expect([...effective].filter((c) => c === 'product:read')).toHaveLength(1);
  });

  it('7. denies a deactivated user even with a previously valid token', async () => {
    const user = await createUser(ctx.prisma);
    await assignRole(ctx.prisma, user.id, ROLES.ADMIN);
    const token = await login(ctx, user.email, user.password);
    // Confirm the token worked while active, then deactivate.
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    // And the effective-permission read model returns nothing for a disabled user.
    const service = ctx.app.get(PermissionService);
    const effective = await service.getEffectivePermissions({ userId: user.id, roles: [] });
    expect(effective.size).toBe(0);
  });

  it('8. ignores a forged permission claim in the JWT (authz comes from the DB)', async () => {
    const user = await createUser(ctx.prisma); // no permissions at all
    const realToken = await login(ctx, user.email, user.password);
    const forged = forgeTokenFrom(ctx, realToken, {
      permissions: ['product:read', 'system:read'],
      roles: ['SYSTEM_ADMIN'],
    });

    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${forged}`)
      .expect(403);
  });

  it('9. denies an ADMIN-role user a permission ADMIN does not hold (no role-name shortcut)', async () => {
    const user = await createUser(ctx.prisma);
    await assignRole(ctx.prisma, user.id, ROLES.ADMIN);
    const token = await login(ctx, user.email, user.password);

    // system:read is protected (SYSTEM_ADMIN only); ADMIN must be denied.
    await request(ctx.http)
      .get(`${BASE}/test-authz/system`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('10. VIEWER receives exactly the seeded read-only permission set', async () => {
    const user = await createUser(ctx.prisma);
    await assignRole(ctx.prisma, user.id, ROLES.VIEWER);
    const token = await login(ctx, user.email, user.password);

    // VIEWER has product:read…
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // …but not order:create.
    await request(ctx.http)
      .get(`${BASE}/test-authz/multiple`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    const service = ctx.app.get(PermissionService);
    const effective = await service.getEffectivePermissions({ userId: user.id, roles: [] });
    expect([...effective].sort()).toEqual([...ROLE_PERMISSION_MATRIX[ROLES.VIEWER]].sort());
  });

  it('11. uses the PostgreSQL result when the cache is cold', async () => {
    const user = await createUser(ctx.prisma);
    await assignRole(ctx.prisma, user.id, ROLES.ADMIN);
    const token = await login(ctx, user.email, user.password);

    await ctx.permissionCache.clear(); // ensure a cold cache
    await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('12. surfaces a permission change once the cache is invalidated', async () => {
    const user = await createUser(ctx.prisma);
    // Stable role so its security-version (cache key) stays constant across the test.
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:create'], 'CACHE_ROLE');
    const token = await login(ctx, user.email, user.password);

    // Missing order:approve → 403, and the (stale) negative result is cached.
    await request(ctx.http)
      .get(`${BASE}/test-authz/multiple`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    // Grant the missing permission WITHOUT changing role membership.
    await addPermissionToRole(ctx.prisma, 'CACHE_ROLE', 'order:approve');

    // Still denied while the cache holds the old set (clock frozen ⇒ no TTL expiry).
    await request(ctx.http)
      .get(`${BASE}/test-authz/multiple`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    // After invalidation the fresh PostgreSQL state is visible.
    await ctx.permissionCache.invalidate(user.id);
    await request(ctx.http)
      .get(`${BASE}/test-authz/multiple`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('13. returns a 403 as RFC 7807 problem+json with a stable code', async () => {
    const user = await createUser(ctx.prisma);
    const token = await login(ctx, user.email, user.password);

    const res = await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(typeof res.body.type).toBe('string');
    expect(typeof res.body.title).toBe('string');
  });

  it('14. includes the correlation requestId in the error response', async () => {
    const user = await createUser(ctx.prisma);
    const token = await login(ctx, user.email, user.password);

    const res = await request(ctx.http)
      .get(`${BASE}/test-authz/single`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('allows the public route without authentication and the authenticated route with a token', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).get(`${BASE}/test-authz/public`).expect(200);
    await request(ctx.http).get(`${BASE}/test-authz/authenticated`).expect(401);
    const token = await login(ctx, user.email, user.password);
    await request(ctx.http)
      .get(`${BASE}/test-authz/authenticated`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
