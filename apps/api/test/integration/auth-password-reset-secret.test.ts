import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@b2b/database';
import {
  type TestApp,
  closeTestApp,
  createTestApp,
  createUser,
  deliverResetToken,
  resetState,
} from './helpers';

const BASE = '/api/v1/auth';
const NEW_PASSWORD = 'a brand new strong passphrase';

/**
 * Literal (non-LIKE, so base64url `_`/`-` are not treated as wildcards) substring
 * scan for the raw token across every table that could plausibly hold a payload
 * or audit trail. Returns the total number of rows that contain it.
 */
async function countRawTokenRows(prisma: PrismaClient, token: string): Promise<number> {
  const scans = [
    `SELECT count(*)::int AS n FROM password_reset_tokens t WHERE strpos(t::text, $1) > 0`,
    `SELECT count(*)::int AS n FROM outbox_events o WHERE strpos(o.payload::text, $1) > 0`,
    `SELECT count(*)::int AS n FROM audit_logs a WHERE strpos(a::text, $1) > 0`,
    `SELECT count(*)::int AS n FROM email_messages e WHERE strpos(e::text, $1) > 0`,
  ];
  let total = 0;
  for (const sql of scans) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(sql, token);
    total += rows[0]?.n ?? 0;
  }
  return total;
}

describe('password reset delivery secret (AUTH-BLOCK-001, real PostgreSQL)', () => {
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

  it('never persists the raw reset token in any column (outbox/digest/audit)', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);

    // The event reference carries no raw token.
    const event = ctx.email.last();
    expect(event).not.toHaveProperty('resetToken');

    // The deliverable token is sealed on the row before any delivery.
    const before = await ctx.prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(before).not.toBeNull();
    expect(before!.deliveryCiphertext).not.toBeNull();
    expect(before!.deliveryNonce).not.toBeNull();
    expect(before!.deliveryAuthTag).not.toBeNull();

    // The plaintext token exists only after decrypting at the delivery boundary.
    const token = await deliverResetToken(ctx, event);
    expect(token).toBeTruthy();

    // The stored ciphertext is not the raw token, and the digest is sha256 ≠ token.
    expect(before!.deliveryCiphertext!.toString('utf8')).not.toBe(token);
    expect(before!.deliveryCiphertext!.toString('base64')).not.toContain(token);
    expect(before!.tokenHash).not.toBe(token);

    // The outbox payload itself contains no raw token.
    const outbox = await ctx.prisma.outboxEvent.findFirst({
      where: { eventType: 'auth.password_reset.requested', aggregateId: user.id },
    });
    expect(JSON.stringify(outbox!.payload)).not.toContain(token);

    // Complete a real reset so audit rows are written, then scan every table.
    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);

    expect(await countRawTokenRows(ctx.prisma, token)).toBe(0);
  });

  it('erases the sealed secret after delivery and is idempotent on redelivery', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
    const event = ctx.email.last();

    const beforeRow = await ctx.prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(beforeRow!.deliveryConsumedAt).toBeNull();

    const first = await ctx.delivery.deliver(event.passwordResetTokenId);
    expect(first.delivered).toBe(true);

    // Ciphertext/nonce/tag are NULLed and the delivery is stamped consumed.
    const afterRow = await ctx.prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(afterRow!.deliveryCiphertext).toBeNull();
    expect(afterRow!.deliveryNonce).toBeNull();
    expect(afterRow!.deliveryAuthTag).toBeNull();
    expect(afterRow!.deliveryConsumedAt).not.toBeNull();

    // An at-least-once outbox redelivery does not send a second email.
    const second = await ctx.delivery.deliver(event.passwordResetTokenId);
    expect(second.delivered).toBe(false);
  });

  it('still resets the password via the stored digest after the secret is erased', async () => {
    const user = await createUser(ctx.prisma);
    await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
    const token = await deliverResetToken(ctx);

    // The delivery secret is gone, but digest-based verification still works.
    await request(ctx.http)
      .post(`${BASE}/reset-password`)
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);
    await request(ctx.http)
      .post(`${BASE}/login`)
      .send({ email: user.email, password: NEW_PASSWORD })
      .expect(200);
  });
});
