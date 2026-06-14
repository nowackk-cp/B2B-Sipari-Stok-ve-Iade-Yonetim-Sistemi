import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@b2b/contracts';
import {
  type TestApp,
  closeTestApp,
  createTestApp,
  createUser,
  refreshCookieFrom,
  resetState,
} from './helpers';

const BASE = '/api/v1/auth';

describe('auth API contract (integration, real PostgreSQL)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
  });

  it('rejects unknown body fields (DTO whitelist → 400)', async () => {
    const res = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: 'a@b.c', password: 'x'.repeat(12), role: 'ADMIN', isAdmin: true })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('validates the email format', async () => {
    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: 'not-an-email', password: 'x' })
      .expect(400);
  });

  it('returns RFC 7807 problem+json with a requestId on auth errors', async () => {
    const res = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: 'nobody@test.local', password: 'wrong password value' })
      .expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(typeof res.body.type).toBe('string');
    expect(typeof res.body.title).toBe('string');
    expect(res.body.requestId).toBeTruthy();
  });

  it('echoes a client-provided X-Request-Id', async () => {
    const res = await request(ctx.http)
      .post(`${BASE}/login`)
      .set(REQUEST_ID_HEADER, 'auth-req-1')
      .send({ email: 'nobody@test.local', password: 'wrong password value' })
      .expect(401);
    expect(res.headers[REQUEST_ID_HEADER]).toBe('auth-req-1');
    expect(res.body.requestId).toBe('auth-req-1');
  });

  it('rejects malformed / wrong-scheme Authorization headers', async () => {
    await request(ctx.http).get(`${BASE}/me`).set('Authorization', 'Bearer not-a-jwt').expect(401);
    await request(ctx.http).get(`${BASE}/me`).set('Authorization', 'Basic abc123').expect(401);
    await request(ctx.http).get(`${BASE}/me`).set('Authorization', 'Bearer').expect(401);
  });

  it('rejects an expired access token', async () => {
    const user = await createUser(ctx.prisma);
    const login = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    // Past the 900s TTL.
    ctx.clock.advanceMs(901_000);
    await request(ctx.http)
      .get(`${BASE}/me`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(401);
  });

  it('rejects a token whose user was deactivated/deleted after issue', async () => {
    const user = await createUser(ctx.prisma);
    const login = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    refreshCookieFrom(login);

    await ctx.prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    await request(ctx.http)
      .get(`${BASE}/me`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(401);
  });

  it('marks the refresh cookie HttpOnly + Secure-aware + SameSite=Strict', async () => {
    const user = await createUser(ctx.prisma);
    const res = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('b2b_refresh_token='),
    )!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });
});
