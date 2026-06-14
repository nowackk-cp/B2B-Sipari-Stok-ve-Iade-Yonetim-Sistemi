import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestApp,
  closeTestApp,
  createTestApp,
  createUser,
  refreshCookieFrom,
  refreshCookieCleared,
  resetState,
} from './helpers';

const BASE = '/api/v1/auth';

interface Session {
  access: string;
  cookie: string;
}

async function login(ctx: TestApp, email: string, password: string): Promise<Session> {
  const res = await request(ctx.http).post(`${BASE}/login`).send({ email, password }).expect(200);
  return { access: res.body.accessToken, cookie: refreshCookieFrom(res) };
}

describe('auth sessions + logout (integration, real PostgreSQL)', () => {
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

  it('lists active sessions and flags the current one', async () => {
    const user = await createUser(ctx.prisma);
    const s1 = await login(ctx, user.email, user.password);
    await login(ctx, user.email, user.password); // second session

    const res = await request(ctx.http)
      .get(`${BASE}/sessions`)
      .set('Authorization', `Bearer ${s1.access}`)
      .expect(200);
    expect(res.body).toHaveLength(2);
    const current = res.body.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    // No token digests leak into the listing.
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');
  });

  it('revokes a single session by id', async () => {
    const user = await createUser(ctx.prisma);
    const s1 = await login(ctx, user.email, user.password);
    const s2 = await login(ctx, user.email, user.password);

    const list = await request(ctx.http)
      .get(`${BASE}/sessions`)
      .set('Authorization', `Bearer ${s1.access}`)
      .expect(200);
    const other = list.body.find((s: { current: boolean; id: string }) => !s.current)!;

    await request(ctx.http)
      .delete(`${BASE}/sessions/${other.id}`)
      .set('Authorization', `Bearer ${s1.access}`)
      .expect(204);

    // The revoked session's refresh token no longer works.
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', s2.cookie).expect(401);
    // The current session still works.
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', s1.cookie).expect(200);
  });

  it('cannot revoke another user’s session (404, no cross-user access)', async () => {
    const victim = await createUser(ctx.prisma);
    const attacker = await createUser(ctx.prisma);
    const vSession = await login(ctx, victim.email, victim.password);
    const aSession = await login(ctx, attacker.email, attacker.password);

    const vList = await request(ctx.http)
      .get(`${BASE}/sessions`)
      .set('Authorization', `Bearer ${vSession.access}`)
      .expect(200);
    const victimSessionId = vList.body[0].id;

    await request(ctx.http)
      .delete(`${BASE}/sessions/${victimSessionId}`)
      .set('Authorization', `Bearer ${aSession.access}`)
      .expect(404);

    // Victim session is intact.
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', vSession.cookie).expect(200);
  });

  it('logout revokes the current session and clears the cookie', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(ctx, user.email, user.password);

    const res = await request(ctx.http).post(`${BASE}/logout`).set('Cookie', s.cookie).expect(200);
    expect(refreshCookieCleared(res)).toBe(true);
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', s.cookie).expect(401);
  });

  it('logout is idempotent without a cookie', async () => {
    await request(ctx.http).post(`${BASE}/logout`).expect(200);
  });

  it('logout-all revokes every session for the user', async () => {
    const user = await createUser(ctx.prisma);
    const s1 = await login(ctx, user.email, user.password);
    const s2 = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .post(`${BASE}/logout-all`)
      .set('Authorization', `Bearer ${s1.access}`)
      .expect(200);

    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', s1.cookie).expect(401);
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', s2.cookie).expect(401);
    const active = await ctx.prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(active).toBe(0);
  });
});
