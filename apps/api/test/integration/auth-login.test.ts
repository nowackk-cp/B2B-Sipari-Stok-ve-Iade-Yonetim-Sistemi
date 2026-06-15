import { randomBytes } from 'node:crypto';
import { argon2id } from 'hash-wasm';
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

describe('auth login (integration, real PostgreSQL)', () => {
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

  it('logs in with valid credentials and sets an HttpOnly refresh cookie', async () => {
    const user = await createUser(ctx.prisma);
    const res = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);

    expect(res.body.tokenType).toBe('Bearer');
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.user.id).toBe(user.publicId);
    expect(res.body.user.email).toBe(user.email);
    // No refresh token, hash or internal id in the JSON body.
    expect(res.body.refreshToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const refresh = setCookie.find((c) => c.startsWith('b2b_refresh_token='))!;
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Strict/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('returns the SAME generic 401 for wrong password, unknown user and disabled user', async () => {
    const active = await createUser(ctx.prisma, { password: 'correct horse battery staple' });
    const disabled = await createUser(ctx.prisma, { status: 'SUSPENDED' });

    const wrong = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: active.email, password: 'wrong password value' })
      .expect(401);
    const unknown = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: 'nobody@test.local', password: 'whatever password' })
      .expect(401);
    const inactive = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: disabled.email, password: disabled.password })
      .expect(401);

    for (const res of [wrong, unknown, inactive]) {
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(res.body.detail).toBe('Invalid email or password');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('locks the account after the failed-attempt threshold and rejects even valid creds', async () => {
    const user = await createUser(ctx.prisma);
    for (let i = 0; i < 5; i++) {
      await request(ctx.http)
        .post(`${BASE}/login`)
        .send({ email: user.email, password: 'wrong password value' })
        .expect(401);
    }
    const locked = await ctx.prisma.user.findUnique({ where: { id: user.id } });
    expect(locked?.lockedUntil).not.toBeNull();

    // Correct password while locked is still rejected generically.
    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(401);
  });

  it('allows login again after the lockout window elapses', async () => {
    const user = await createUser(ctx.prisma);
    for (let i = 0; i < 5; i++) {
      await request(ctx.http)
        .post(`${BASE}/login`)
        .send({ email: user.email, password: 'wrong password value' })
        .expect(401);
    }
    // Advance past the 15-minute lockout window.
    ctx.clock.advanceMinutes(16);
    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
  });

  it('transparently rehashes a weak stored hash on successful login', async () => {
    const password = 'correct horse battery staple';
    const weakHash = await argon2id({
      password: password.normalize('NFKC'),
      salt: randomBytes(16),
      memorySize: 8192,
      iterations: 1, // below the policy target (2) → needs rehash
      parallelism: 1,
      hashLength: 32,
      outputType: 'encoded',
    });
    const user = await ctx.prisma.user.create({
      data: {
        email: 'rehash@test.local',
        passwordHash: weakHash,
        fullName: 'Rehash',
        status: 'ACTIVE',
        // Users are company-scoped (company_id NOT NULL); attach a fresh tenant.
        company: { create: { name: 'Rehash Co' } },
      },
      select: { id: true },
    });

    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: 'rehash@test.local', password })
      .expect(200);

    const after = await ctx.prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.passwordHash).not.toBe(weakHash);
    expect(after?.passwordHash).toMatch(/m=8192,t=2/);
  });

  it('resets the failed counter after a successful login', async () => {
    const user = await createUser(ctx.prisma);
    for (let i = 0; i < 3; i++) {
      await request(ctx.http)
        .post(`${BASE}/login`)
        .send({ email: user.email, password: 'wrong password value' })
        .expect(401);
    }
    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    const after = await ctx.prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.failedLoginCount).toBe(0);
    expect(after?.lastLoginAt).not.toBeNull();
  });

  it('rate-limits repeated attempts from the same client with 429', async () => {
    // LOGIN_RATE_LIMIT_MAX defaults to 10 in the test env.
    for (let i = 0; i < 10; i++) {
      await request(ctx.http)
        .post(`${BASE}/login`)
        .send({ email: 'flood@test.local', password: 'wrong password value' })
        .expect(401);
    }
    const limited = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: 'flood@test.local', password: 'wrong password value' })
      .expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  it('GET /auth/me returns the profile for a valid access token', async () => {
    const user = await createUser(ctx.prisma);
    const login = await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    refreshCookieFrom(login); // a cookie was set

    const me = await request(ctx.http)
      .get(`${BASE}/me`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(me.body.id).toBe(user.publicId);
    expect(me.body.email).toBe(user.email);
    expect(me.body.passwordHash).toBeUndefined();
  });

  it('rejects /auth/me without a token', async () => {
    await request(ctx.http).get(`${BASE}/me`).expect(401);
  });
});
