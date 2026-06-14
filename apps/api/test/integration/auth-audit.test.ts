import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@b2b/database';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/common/config/app-config.service';
import { configureApp } from '../../src/bootstrap';
import { AuditWriter } from '../../src/common/audit/audit-writer.service';
import { CLOCK } from '../../src/common/time/clock';
import { EMAIL_OUTBOX, RATE_LIMITER } from '../../src/modules/auth/auth.constants';
import { InMemoryRateLimiter } from '../../src/modules/auth/adapters/in-memory-rate-limiter';
import {
  CapturingEmailOutbox,
  MutableClock,
  type TestApp,
  closeTestApp,
  createTestApp,
  createUser,
  refreshCookieFrom,
  resetDatabase,
  resetState,
} from './helpers';

const BASE = '/api/v1/auth';
const NEW_PASSWORD = 'a brand new strong passphrase';

describe('auth business audit (integration, real PostgreSQL)', () => {
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

  async function login(email: string, password: string) {
    const res = await request(ctx.http).post(`${BASE}/login`).send({ email, password }).expect(200);
    return { access: res.body.accessToken as string, cookie: refreshCookieFrom(res) };
  }
  const auditCount = (action: string, actorId: bigint) =>
    ctx.prisma.auditLog.count({ where: { action, actorId } });

  it('writes PASSWORD_CHANGED with an actor snapshot and no secrets', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(user.email, user.password);
    await request(ctx.http)
      .post(`${BASE}/change-password`)
      .set('Authorization', `Bearer ${s.access}`)
      .send({ currentPassword: user.password, newPassword: NEW_PASSWORD })
      .expect(200);

    const row = await ctx.prisma.auditLog.findFirst({
      where: { action: 'PASSWORD_CHANGED', actorId: user.id },
    });
    expect(row).not.toBeNull();
    expect(row!.actorEmail).toBe(user.email);
    expect(row!.requestId).toBeTruthy();
    expect(JSON.stringify(row!.after)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(row!.after)).not.toContain('argon2');
  });

  it('writes ACCOUNT_LOCKED on lockout', async () => {
    const user = await createUser(ctx.prisma);
    for (let i = 0; i < 5; i++) {
      await request(ctx.http)
        .post(`${BASE}/login`)
        .send({ email: user.email, password: 'wrong password value' })
        .expect(401);
    }
    expect(await auditCount('ACCOUNT_LOCKED', user.id)).toBe(1);
  });

  it('writes TOKEN_REUSE_DETECTED on refresh reuse', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(user.email, user.password);
    const rotated = await request(ctx.http)
      .post(`${BASE}/refresh`)
      .set('Cookie', s.cookie)
      .expect(200);
    refreshCookieFrom(rotated);
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', s.cookie).expect(401);
    expect(await auditCount('TOKEN_REUSE_DETECTED', user.id)).toBe(1);
  });

  it('writes SESSION_REVOKED on logout and ALL_SESSIONS_REVOKED on logout-all', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(user.email, user.password);
    await request(ctx.http).post(`${BASE}/logout`).set('Cookie', s.cookie).expect(200);
    expect(await auditCount('SESSION_REVOKED', user.id)).toBe(1);

    const s2 = await login(user.email, user.password);
    await request(ctx.http)
      .post(`${BASE}/logout-all`)
      .set('Authorization', `Bearer ${s2.access}`)
      .expect(200);
    expect(await auditCount('ALL_SESSIONS_REVOKED', user.id)).toBe(1);
  });

  it('writes PASSWORD_RESET_COMPLETED after a reset', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
    const token = ctx.email.last().resetToken;
    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);
    expect(await auditCount('PASSWORD_RESET_COMPLETED', user.id)).toBe(1);
  });

  it('does NOT write an audit row when the business operation fails (same-tx rollback)', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(user.email, user.password);
    // Wrong current password → 422, no PASSWORD_CHANGED audit.
    await request(ctx.http)
      .post(`${BASE}/change-password`)
      .set('Authorization', `Bearer ${s.access}`)
      .send({ currentPassword: 'totally wrong password', newPassword: NEW_PASSWORD })
      .expect(422);
    expect(await auditCount('PASSWORD_CHANGED', user.id)).toBe(0);

    // Invalid reset token → 422, no PASSWORD_RESET_COMPLETED audit.
    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token: 'invalid', newPassword: NEW_PASSWORD })
      .expect(422);
    expect(await auditCount('PASSWORD_RESET_COMPLETED', user.id)).toBe(0);
  });

  it('never stores a raw password or token in any audit row', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(user.email, user.password);
    await request(ctx.http)
      .post(`${BASE}/change-password`)
      .set('Authorization', `Bearer ${s.access}`)
      .send({ currentPassword: user.password, newPassword: NEW_PASSWORD })
      .expect(200);
    const rows = await ctx.prisma.auditLog.findMany();
    const blob = JSON.stringify(rows.map((r) => ({ b: r.before, a: r.after })));
    expect(blob).not.toContain(NEW_PASSWORD);
    expect(blob).not.toContain(user.password);
  });
});

describe('audit-failure rolls back the mutation (same transaction)', () => {
  let app: import('@nestjs/common').INestApplication;
  let http: import('http').Server;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const throwingWriter = {
      write: async () => {
        throw new Error('injected audit failure');
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(new MutableClock())
      .overrideProvider(RATE_LIMITER)
      .useClass(InMemoryRateLimiter)
      .overrideProvider(EMAIL_OUTBOX)
      .useValue(new CapturingEmailOutbox())
      .overrideProvider(AuditWriter)
      .useValue(throwingWriter)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(AppConfigService));
    await app.init();
    prisma = new PrismaClient();
    await resetDatabase(prisma);
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it('keeps the old password when the audit insert throws', async () => {
    const user = await createUser(prisma, { password: 'correct horse battery staple' });
    const login = await request(http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);

    await request(http)
      .post(`${BASE}/change-password`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ currentPassword: user.password, newPassword: NEW_PASSWORD })
      .expect(500);

    // The mutation rolled back with the failed audit: old password still valid.
    await request(http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(200);
    await request(http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(401);
  });
});
