import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PermissionGuard } from '../../src/modules/authorization/guards/permission.guard';
import { GlobalAuthzProbeController } from '../support/global-authz-probe.controller';
import {
  type TestApp,
  closeTestApp,
  createTestApp,
  createUser,
  grantPermissionsViaRole,
  resetState,
  seedRbac,
} from './helpers';

const BASE = '/api/v1';
const AUTH = `${BASE}/auth`;
const PROBE = `${BASE}/global-authz-probe`;

// NestJS stores @UseGuards on the handler under this metadata key.
const GUARDS_METADATA = '__guards__';

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/**
 * Runtime proof that PermissionGuard is bound into the REAL production request
 * chain. The app boots the unmodified production AppModule; the probe controller
 * applies NO guards of its own, so any enforcement here comes purely from the
 * global APP_GUARD registration.
 */
describe('global guard chain via production AppModule (integration, real PostgreSQL)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ controllers: [GlobalAuthzProbeController] });
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
    await seedRbac(ctx.prisma);
  });

  it('serves a @Public no-permission route without any token', async () => {
    await request(ctx.http).get(`${PROBE}/open`).expect(200);
  });

  it('1+2. enforces a @RequirePermissions route with no manual guard: no token → 401', async () => {
    const res = await request(ctx.http).get(`${PROBE}/needs-permission`).expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('3. authenticated user lacking the permission → 403 (RFC 7807 + requestId)', async () => {
    const user = await createUser(ctx.prisma); // no roles / permissions
    const token = await login(ctx, user.email, user.password);

    const res = await request(ctx.http)
      .get(`${PROBE}/needs-permission`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('4. user holding the permission → 200', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['product:read']);
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${PROBE}/needs-permission`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('preserves existing behavior when no permission metadata is present', async () => {
    const user = await createUser(ctx.prisma); // authenticated, zero permissions
    const token = await login(ctx, user.email, user.password);

    // No @RequirePermissions ⇒ PermissionGuard is a no-op; auth still required.
    await request(ctx.http).get(`${PROBE}/authed-no-permission`).expect(401);
    await request(ctx.http)
      .get(`${PROBE}/authed-no-permission`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('5+6. the probe controller applies no PermissionGuard of its own (enforcement is global)', () => {
    // If this controller carried @UseGuards(PermissionGuard), the 403 test above
    // would not actually prove the global binding. It must NOT — and removing the
    // APP_GUARD PermissionGuard registration would flip the 403 case to 200.
    const proto = GlobalAuthzProbeController.prototype as unknown as Record<string, unknown>;
    for (const name of ['open', 'authedNoPermission', 'needsPermission']) {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) ??
        []) as unknown[];
      expect(guards).not.toContain(PermissionGuard);
    }
  });
});
