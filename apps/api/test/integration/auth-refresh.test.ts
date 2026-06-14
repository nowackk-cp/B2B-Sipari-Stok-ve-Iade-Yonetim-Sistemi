import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestApp,
  closeTestApp,
  createTestApp,
  createUser,
  refreshCookieFrom,
  resetState,
} from './helpers';

const BASE = '/api/v1/auth';

async function loginCookie(ctx: TestApp, email: string, password: string): Promise<string> {
  const res = await request(ctx.http).post(`${BASE}/login`).send({ email, password }).expect(200);
  return refreshCookieFrom(res);
}

describe('auth refresh + reuse detection (integration, real PostgreSQL)', () => {
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

  it('rotates the refresh token, issuing a new access token + cookie', async () => {
    const user = await createUser(ctx.prisma);
    const cookie0 = await loginCookie(ctx, user.email, user.password);

    const res = await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', cookie0).expect(200);
    expect(typeof res.body.accessToken).toBe('string');
    const cookie1 = refreshCookieFrom(res);
    expect(cookie1).not.toBe(cookie0);

    // The new token works for another rotation.
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', cookie1).expect(200);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const user = await createUser(ctx.prisma);
    const cookie0 = await loginCookie(ctx, user.email, user.password);

    const rotated = await request(ctx.http)
      .post(`${BASE}/refresh`)
      .set('Cookie', cookie0)
      .expect(200);
    const cookie1 = refreshCookieFrom(rotated);

    // Re-presenting the OLD (already rotated) token → reuse → 401.
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', cookie0).expect(401);

    // The whole family is now revoked: even the previously-valid cookie1 fails.
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', cookie1).expect(401);

    const active = await ctx.prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(active).toBe(0);
  });

  it('rejects an unknown / missing refresh token', async () => {
    await request(ctx.http).post(`${BASE}/refresh`).expect(401);
    await request(ctx.http)
      .post(`${BASE}/refresh`)
      .send({ refreshToken: 'not-a-real-token' })
      .expect(401);
  });

  it('rejects refresh for a deactivated user and rolls back the rotation', async () => {
    const user = await createUser(ctx.prisma);
    const cookie0 = await loginCookie(ctx, user.email, user.password);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', cookie0).expect(401);

    // No NEW active token should have been created by the rolled-back rotation.
    const active = await ctx.prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(active).toBe(1); // only the original login token remains
  });

  it('accepts the refresh token via JSON body for pure API clients', async () => {
    const user = await createUser(ctx.prisma);
    const login = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    const raw = refreshCookieFrom(login).split('=')[1]!;

    await request(ctx.http).post(`${BASE}/refresh`).send({ refreshToken: raw }).expect(200);
  });
});
