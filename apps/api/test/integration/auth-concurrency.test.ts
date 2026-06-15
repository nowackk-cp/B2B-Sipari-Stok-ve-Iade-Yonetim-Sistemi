import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestApp,
  closeTestApp,
  createTestApp,
  createUser,
  deliverResetToken,
  refreshCookieFrom,
  resetState,
} from './helpers';

const BASE = '/api/v1/auth';

/** Run `n` identical request factories in parallel, returning their statuses. */
async function parallelStatuses(factory: () => request.Test, n: number): Promise<number[]> {
  const results = await Promise.allSettled(Array.from({ length: n }, () => factory()));
  return results.map((r) =>
    r.status === 'fulfilled'
      ? r.value.status
      : Number((r.reason as { status?: number }).status ?? 500),
  );
}

describe('auth concurrency (integration, real PostgreSQL)', () => {
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

  it('two concurrent refreshes of the same token → exactly one succeeds', async () => {
    const user = await createUser(ctx.prisma);
    const login = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    const cookie = refreshCookieFrom(login);

    const statuses = await parallelStatuses(
      () => request(ctx.http).post(`${BASE}/refresh`).set('Cookie', cookie),
      5,
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);
  });

  it('two concurrent uses of the same reset token → exactly one succeeds', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
    const token = await deliverResetToken(ctx);

    const statuses = await parallelStatuses(
      () =>
        request(ctx.http)
          .post(`${BASE}/reset-password`)
          .send({ token, newPassword: 'a brand new strong passphrase' }),
      5,
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 422)).toHaveLength(4);
  });

  it('parallel failed logins do not lose lockout increments', async () => {
    const user = await createUser(ctx.prisma);
    await parallelStatuses(
      () =>
        request(ctx.http)
          .post(`${BASE}/login`)
          .send({ email: user.email, password: 'wrong password value' }),
      5,
    );
    const locked = await ctx.prisma.user.findUnique({ where: { id: user.id } });
    expect(locked?.lockedUntil).not.toBeNull();
    // The lock is recorded exactly once despite the race.
    const lockAudits = await ctx.prisma.auditLog.count({
      where: { action: 'ACCOUNT_LOCKED', actorId: user.id },
    });
    expect(lockAudits).toBe(1);
  });

  it('logout racing refresh resolves safely (no error, ≤ 1 active token)', async () => {
    const user = await createUser(ctx.prisma);
    const login = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    const cookie = refreshCookieFrom(login);

    const [a, b] = await Promise.allSettled([
      request(ctx.http).post(`${BASE}/refresh`).set('Cookie', cookie),
      request(ctx.http).post(`${BASE}/logout`).set('Cookie', cookie),
    ]);
    for (const r of [a, b]) {
      const status =
        r.status === 'fulfilled'
          ? r.value.status
          : Number((r.reason as { status?: number }).status);
      expect(status).not.toBe(500);
    }
    const active = await ctx.prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(active).toBeLessThanOrEqual(1);
  });
});
