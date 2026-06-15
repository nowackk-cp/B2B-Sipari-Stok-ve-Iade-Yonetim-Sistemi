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
const NEW_PASSWORD = 'a brand new strong passphrase';

async function login(ctx: TestApp, email: string, password: string) {
  const res = await request(ctx.http).post(`${BASE}/login`).send({ email, password }).expect(200);
  return { access: res.body.accessToken as string, cookie: refreshCookieFrom(res) };
}

describe('auth password change / reset (integration, real PostgreSQL)', () => {
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

  // --- change password ------------------------------------------------------

  it('changes the password with the correct current password', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .post(`${BASE}/change-password`)
      .set('Authorization', `Bearer ${s.access}`)
      .send({ currentPassword: user.password, newPassword: NEW_PASSWORD })
      .expect(200);

    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: user.password })
      .expect(401);
    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(200);
  });

  it('rejects change-password with a wrong current password (422)', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(ctx, user.email, user.password);
    const res = await request(ctx.http)
      .post(`${BASE}/change-password`)
      .set('Authorization', `Bearer ${s.access}`)
      .send({ currentPassword: 'totally wrong password', newPassword: NEW_PASSWORD })
      .expect(422);
    expect(res.body.code).toBe('BUSINESS_RULE');
  });

  it('enforces the password policy on the new password (422)', async () => {
    const user = await createUser(ctx.prisma);
    const s = await login(ctx, user.email, user.password);
    await request(ctx.http)
      .post(`${BASE}/change-password`)
      .set('Authorization', `Bearer ${s.access}`)
      .send({ currentPassword: user.password, newPassword: 'short' })
      .expect(422);
  });

  it('revokes other sessions on change but keeps the current one', async () => {
    const user = await createUser(ctx.prisma);
    const current = await login(ctx, user.email, user.password);
    const other = await login(ctx, user.email, user.password);

    await request(ctx.http)
      .post(`${BASE}/change-password`)
      .set('Authorization', `Bearer ${current.access}`)
      .send({ currentPassword: user.password, newPassword: NEW_PASSWORD })
      .expect(200);

    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', other.cookie).expect(401);
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', current.cookie).expect(200);
  });

  // --- forgot password ------------------------------------------------------

  it('forgot-password returns a generic response for known and unknown emails', async () => {
    const user = await createUser(ctx.prisma);
    const known = await request(ctx.http)
      .post(`${BASE}/forgot-password`)
      .send({ email: user.email })
      .expect(200);
    const unknown = await request(ctx.http)
      .post(`${BASE}/forgot-password`)
      .send({ email: 'nobody@test.local' })
      .expect(200);
    expect(known.body.message).toBe(unknown.body.message);
  });

  it('stores only a digest + sealed token and never a raw token in the outbox', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);

    const event = ctx.email.last();
    expect(event.email).toBe(user.email);
    // The event carries only a reference, never the raw bearer token.
    expect(event).not.toHaveProperty('resetToken');
    expect(event.passwordResetTokenId).toBeTruthy();

    // The raw token is obtainable only via the approved delivery boundary.
    const token = await deliverResetToken(ctx, event);
    expect(token).toBeTruthy();

    // DB stores a digest, never the raw token.
    const row = await ctx.prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toHaveLength(64);

    // The transactional outbox row carries safe references only — no raw token.
    const outbox = await ctx.prisma.outboxEvent.findFirst({
      where: { eventType: 'auth.password_reset.requested', aggregateId: user.id },
    });
    expect(outbox).not.toBeNull();
    expect(JSON.stringify(outbox!.payload)).not.toContain(token);
  });

  // --- reset password -------------------------------------------------------

  it('resets the password with a valid token and revokes all sessions', async () => {
    const user = await createUser(ctx.prisma);
    const session = await login(ctx, user.email, user.password);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
    const token = await deliverResetToken(ctx);

    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);

    // Old password gone, new works; pre-existing sessions revoked.
    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(200);
    await request(ctx.http).post(`${BASE}/refresh`).set('Cookie', session.cookie).expect(401);
  });

  it('rejects a second use of the same reset token (single-use)', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
    const token = await deliverResetToken(ctx);

    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);
    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token, newPassword: 'yet another strong passphrase' })
      .expect(422);
  });

  it('rejects an invalid reset token (422)', async () => {
    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token: 'not-a-valid-token', newPassword: NEW_PASSWORD })
      .expect(422);
  });

  it('invalidates a prior reset token when a new one is requested', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
    const firstEvent = ctx.email.last();
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
    const secondEvent = ctx.email.last();
    const firstToken = await deliverResetToken(ctx, firstEvent);
    const secondToken = await deliverResetToken(ctx, secondEvent);

    // The first token is no longer usable; the second one is.
    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token: firstToken, newPassword: NEW_PASSWORD })
      .expect(422);
    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token: secondToken, newPassword: NEW_PASSWORD })
      .expect(200);
  });
});
