import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PermissionGuard } from '../../src/modules/authorization/guards/permission.guard';
import { MergedAuthzProbeController } from '../support/merged-authz-probe.controller';
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
const PROBE = `${BASE}/merged-authz-probe`;

// NestJS stores @UseGuards on the handler under this metadata key.
const GUARDS_METADATA = '__guards__';

async function login(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${AUTH}/login`).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/**
 * Runtime proof (real PostgreSQL, real production AppModule + global APP_GUARD)
 * that controller- and handler-level `@RequirePermissions(...)` are MERGED. The
 * probe controller declares a class-level `order:read` and a handler-level
 * `order:approve`; the route must demand BOTH. The controller applies NO guards
 * of its own, so every decision below comes from the global guard chain.
 */
describe('merged controller + handler permission metadata (integration, real PostgreSQL)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp({ controllers: [MergedAuthzProbeController] });
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
    await seedRbac(ctx.prisma);
  });

  it('rejects an unauthenticated request (401, RFC 7807 + requestId)', async () => {
    const res = await request(ctx.http).get(`${PROBE}/approve`).expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('denies (403) a user holding only the controller permission (order:read)', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:read']);
    const token = await login(ctx, user.email, user.password);

    const res = await request(ctx.http)
      .get(`${PROBE}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId.length).toBeGreaterThan(0);
  });

  it('denies (403) a user holding only the handler permission (order:approve)', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:approve']);
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${PROBE}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('allows a user holding BOTH the controller and handler permissions', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:read', 'order:approve']);
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${PROBE}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('de-duplicates a code declared on both levels (order:read alone passes)', async () => {
    const user = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, user.id, ['order:read']);
    const token = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .get(`${PROBE}/duplicate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('applies only the controller permission when the handler declares none', async () => {
    const denied = await createUser(ctx.prisma); // no permissions
    const deniedToken = await login(ctx, denied.email, denied.password);
    await request(ctx.http)
      .get(`${PROBE}/inherited`)
      .set('Authorization', `Bearer ${deniedToken}`)
      .expect(403);

    const allowed = await createUser(ctx.prisma);
    await grantPermissionsViaRole(ctx.prisma, allowed.id, ['order:read']);
    const allowedToken = await login(ctx, allowed.email, allowed.password);
    await request(ctx.http)
      .get(`${PROBE}/inherited`)
      .set('Authorization', `Bearer ${allowedToken}`)
      .expect(200);
  });

  it('the probe controller applies no PermissionGuard of its own (enforcement is global)', () => {
    const proto = MergedAuthzProbeController.prototype as unknown as Record<string, unknown>;
    for (const name of ['approve', 'duplicate', 'inherited']) {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) ??
        []) as unknown[];
      expect(guards).not.toContain(PermissionGuard);
    }
  });
});
