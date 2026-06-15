import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestApp, closeTestApp, createTestApp, createUser, resetState } from './helpers';
import { DELIVERY_LEASE_MS } from '../../src/modules/security/password-reset-delivery.service';
import type {
  ResetEmailProvider,
  SendResetEmailCommand,
  SendResetEmailResult,
} from '../../src/modules/security/ports/reset-email-provider.port';
import { SmtpResetEmailProvider } from '../../src/modules/security/adapters/smtp-reset-email-provider';
import { FakeResetEmailProvider } from '../support/fake-reset-email-provider';

const BASE = '/api/v1/auth';

/** Mint a reset row via the public endpoint; return its id (the outbox ref). */
async function requestReset(ctx: TestApp): Promise<bigint> {
  const user = await createUser(ctx.prisma);
  await request(ctx.http).post(`${BASE}/forgot-password`).send({ email: user.email }).expect(200);
  return ctx.email.last().passwordResetTokenId;
}

async function rowOf(ctx: TestApp, id: bigint) {
  const row = await ctx.prisma.passwordResetToken.findUnique({ where: { id } });
  if (!row) throw new Error(`reset row ${id} not found`);
  return row;
}

/**
 * Idempotent fake provider: records exactly one real delivery per idempotency
 * key (a retry with the same key collapses to the first), while counting every
 * send attempt — so a crash-retry can be distinguished from a duplicate email.
 */
class CountingIdempotentProvider implements ResetEmailProvider {
  readonly supportsIdempotency = true;
  readonly delivered = new Map<string, string>();
  sendCalls = 0;
  async send(cmd: SendResetEmailCommand): Promise<SendResetEmailResult> {
    this.sendCalls += 1;
    const existing = this.delivered.get(cmd.idempotencyKey);
    if (existing) return { providerMessageId: existing };
    const providerMessageId = `msg-${this.delivered.size + 1}`;
    this.delivered.set(cmd.idempotencyKey, providerMessageId);
    return { providerMessageId };
  }
  get realDeliveries(): number {
    return this.delivered.size;
  }
  reset(): void {
    this.delivered.clear();
    this.sendCalls = 0;
  }
}

class FailingIdempotentProvider implements ResetEmailProvider {
  readonly supportsIdempotency = true;
  async send(): Promise<SendResetEmailResult> {
    throw new Error('smtp temporarily unavailable');
  }
}

class FailingNonIdempotentProvider implements ResetEmailProvider {
  readonly supportsIdempotency = false;
  async send(): Promise<SendResetEmailResult> {
    throw new Error('ambiguous gateway timeout');
  }
}

/**
 * Non-idempotent provider (like SMTP) that counts sends so a crash-after-send can
 * be told apart from a duplicate. With no native dedup, every send IS a real
 * delivery, so `realDeliveries === sendCalls`. An optional `onSend` hook lets a
 * test inspect DB state at the instant the provider is invoked.
 */
class CountingNonIdempotentProvider implements ResetEmailProvider {
  readonly supportsIdempotency = false;
  sendCalls = 0;
  onSend: () => Promise<void> = async () => {};
  async send(_command: SendResetEmailCommand): Promise<SendResetEmailResult> {
    this.sendCalls += 1;
    await this.onSend();
    return { providerMessageId: `smtp-${this.sendCalls}` };
  }
  get realDeliveries(): number {
    return this.sendCalls;
  }
  reset(): void {
    this.sendCalls = 0;
    this.onSend = async () => {};
  }
}

/**
 * Idempotent provider that runs a test hook DURING send() — used to simulate a
 * newer worker re-claiming the row while the current worker is mid-send, so the
 * current worker's fenced markDelivered later loses the race.
 */
class HookedDuringSendProvider implements ResetEmailProvider {
  readonly supportsIdempotency = true;
  hook: () => Promise<void> = async () => {};
  async send(): Promise<SendResetEmailResult> {
    await this.hook();
    return { providerMessageId: 'pmid-during-send' };
  }
}

describe('password reset delivery lease/crash safety (real PostgreSQL)', () => {
  // --- production wiring binds the REAL SMTP provider, never a fake ----------
  describe('production provider wiring', () => {
    it('binds the real SmtpResetEmailProvider (no logging/fake placeholder)', async () => {
      const ctx = await createTestApp({ keepRealEmailProvider: true });
      try {
        expect(ctx.emailProvider).toBeInstanceOf(SmtpResetEmailProvider);
        expect(ctx.emailProvider).not.toBeInstanceOf(FakeResetEmailProvider);
        // SMTP cannot dedup — the real provider must say so honestly.
        expect(ctx.emailProvider.supportsIdempotency).toBe(false);
      } finally {
        await closeTestApp(ctx);
      }
    });
  });

  // --- a delivery is proven ONLY by the fake provider's recorded store -------
  describe('recorded delivery (test fake)', () => {
    let ctx: TestApp;
    beforeAll(async () => {
      ctx = await createTestApp();
    });
    afterAll(async () => {
      await closeTestApp(ctx);
    });
    beforeEach(async () => {
      await resetState(ctx);
      (ctx.emailProvider as FakeResetEmailProvider).reset();
    });

    it('records the real recipient + token and only then erases the secret', async () => {
      const id = await requestReset(ctx);
      const fake = ctx.emailProvider as FakeResetEmailProvider;

      const result = await ctx.delivery.deliver(id);
      expect(result.delivered).toBe(true);

      // The claim that a delivery happened rests on the fake's record, not on a
      // fabricated status.
      expect(fake.sent).toHaveLength(1);
      const sent = fake.last();
      const row = await rowOf(ctx, id);
      expect(sent.email).toBe((await ctx.prisma.user.findFirstOrThrow()).email);
      expect(sent.token).toBeTruthy();
      expect(sent.idempotencyKey).toBe(`password-reset:${id}`);
      // Secret erased only after the provider recorded the send.
      expect(row.deliveryStatus).toBe('SUCCEEDED');
      expect(row.providerMessageId).toBe(sent.providerMessageId);
      expect(row.deliveryCiphertext).toBeNull();
    });
  });

  // --- default (test fake) provider lifecycle -----------------------------
  describe('claim + lease lifecycle', () => {
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

    it('claim leases the row WITHOUT erasing the ciphertext (secret survives)', async () => {
      const id = await requestReset(ctx);
      const now = ctx.clock.now();
      const claim = await ctx.resets.claimForDelivery(
        id,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
      );
      expect(claim).not.toBeNull();

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('IN_PROGRESS');
      expect(row.deliveryLeaseUntil).not.toBeNull();
      expect(row.deliveryAttemptCount).toBe(1);
      expect(row.providerIdempotencyKey).toBe(`password-reset:${id}`);
      // The secret is still fully present after a claim.
      expect(row.deliveryCiphertext).not.toBeNull();
      expect(row.deliveryNonce).not.toBeNull();
      expect(row.deliveryAuthTag).not.toBeNull();
    });

    it('preserves the secret when a worker crashes after decrypt, before send', async () => {
      const id = await requestReset(ctx);
      const now = ctx.clock.now();
      const claim = await ctx.resets.claimForDelivery(
        id,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
      );
      expect(claim).not.toBeNull();
      // The worker decrypts in memory then "crashes" — no markDelivered runs.
      const token = ctx.deliveryCipher.decrypt(claim!.sealed);
      expect(token).toBeTruthy();

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('IN_PROGRESS');
      expect(row.deliveryCiphertext).not.toBeNull();
      expect(row.deliveredAt).toBeNull();
    });

    it('blocks re-claim under a live lease but allows it after the lease lapses', async () => {
      const id = await requestReset(ctx);
      const now = ctx.clock.now();
      // Worker A claims and crashes (in-flight under a live lease).
      await ctx.resets.claimForDelivery(id, now, new Date(now.getTime() + DELIVERY_LEASE_MS));

      // Worker B cannot steal a live lease.
      const blocked = await ctx.delivery.deliver(id);
      expect(blocked.delivered).toBe(false);
      expect(blocked).toMatchObject({ reason: 'not_claimable' });

      // Once the lease lapses, a retry re-claims and actually sends.
      ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      const retry = await ctx.delivery.deliver(id);
      expect(retry.delivered).toBe(true);

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('SUCCEEDED');
      expect(row.deliveryAttemptCount).toBe(2);
    });

    it('NULLs the secret only after a successful provider send', async () => {
      const id = await requestReset(ctx);
      const result = await ctx.delivery.deliver(id);
      expect(result.delivered).toBe(true);

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('SUCCEEDED');
      expect(row.deliveredAt).not.toBeNull();
      expect(row.providerMessageId).not.toBeNull();
      expect(row.deliveryCiphertext).toBeNull();
      expect(row.deliveryNonce).toBeNull();
      expect(row.deliveryAuthTag).toBeNull();
    });

    it('never re-sends a SUCCEEDED row', async () => {
      const id = await requestReset(ctx);
      expect((await ctx.delivery.deliver(id)).delivered).toBe(true);
      const second = await ctx.delivery.deliver(id);
      expect(second.delivered).toBe(false);
      expect(second).toMatchObject({ reason: 'not_claimable' });
    });

    it('lets only ONE of two concurrent workers win the claim', async () => {
      const id = await requestReset(ctx);
      const now = ctx.clock.now();
      const lease = new Date(now.getTime() + DELIVERY_LEASE_MS);
      const [a, b] = await Promise.all([
        ctx.resets.claimForDelivery(id, now, lease),
        ctx.resets.claimForDelivery(id, now, lease),
      ]);
      const winners = [a, b].filter((c) => c !== null);
      expect(winners).toHaveLength(1);

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('IN_PROGRESS');
      // Exactly one claim took effect.
      expect(row.deliveryAttemptCount).toBe(1);
      // The winner's token is the one persisted on the row.
      expect(row.deliveryClaimToken).toBe(winners[0]!.deliveryClaimToken);
    });

    it('mints a fresh, distinct claim token on every re-claim', async () => {
      const id = await requestReset(ctx);
      const tokens = new Set<string>();
      for (let i = 0; i < 3; i += 1) {
        const now = ctx.clock.now();
        const claim = await ctx.resets.claimForDelivery(
          id,
          now,
          new Date(now.getTime() + DELIVERY_LEASE_MS),
        );
        expect(claim).not.toBeNull();
        tokens.add(claim!.deliveryClaimToken);
        // Let the lease lapse so the next claim is allowed.
        ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      }
      expect(tokens.size).toBe(3);
    });

    it('fences a stale worker out of overwriting a newer claim', async () => {
      const id = await requestReset(ctx);
      const t0 = ctx.clock.now();

      // Worker A claims the row.
      const claimA = await ctx.resets.claimForDelivery(
        id,
        t0,
        new Date(t0.getTime() + DELIVERY_LEASE_MS),
      );
      expect(claimA).not.toBeNull();

      // A's lease lapses; Worker B re-claims with a fresh, different token.
      ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      const tB = ctx.clock.now();
      const claimB = await ctx.resets.claimForDelivery(
        id,
        tB,
        new Date(tB.getTime() + DELIVERY_LEASE_MS),
      );
      expect(claimB).not.toBeNull();
      expect(claimB!.deliveryClaimToken).not.toBe(claimA!.deliveryClaimToken);

      // A returns late and tries to mutate with its STALE token — markSendStarted
      // and every finalizer must update zero rows.
      expect(
        await ctx.resets.markSendStarted(id, claimA!.deliveryClaimToken, ctx.clock.now()),
      ).toBe(0);
      expect(
        await ctx.resets.markDelivered(
          id,
          claimA!.deliveryClaimToken,
          ctx.clock.now(),
          'stale-msg',
        ),
      ).toBe(0);
      expect(await ctx.resets.markFailed(id, claimA!.deliveryClaimToken, 'stale')).toBe(0);
      expect(await ctx.resets.markUnknown(id, claimA!.deliveryClaimToken, 'stale')).toBe(0);
      // The stale markSendStarted left no mark on B's claim.
      expect((await rowOf(ctx, id)).deliverySendStartedAt).toBeNull();

      // B's claim is untouched: still IN_PROGRESS, secret intact, B's token.
      const mid = await rowOf(ctx, id);
      expect(mid.deliveryStatus).toBe('IN_PROGRESS');
      expect(mid.deliveryClaimToken).toBe(claimB!.deliveryClaimToken);
      expect(mid.deliveryCiphertext).not.toBeNull();
      expect(mid.deliveredAt).toBeNull();

      // B finalizes with ITS token — succeeds, and only NOW is the secret erased.
      expect(
        await ctx.resets.markDelivered(id, claimB!.deliveryClaimToken, ctx.clock.now(), 'msg-b'),
      ).toBe(1);
      const done = await rowOf(ctx, id);
      expect(done.deliveryStatus).toBe('SUCCEEDED');
      expect(done.providerMessageId).toBe('msg-b');
      expect(done.deliveryCiphertext).toBeNull();
    });

    it('never leaks the claim token into outbox payloads or audit rows', async () => {
      const user = await createUser(ctx.prisma);
      const forgot = await request(ctx.http)
        .post(`${BASE}/forgot-password`)
        .send({ email: user.email })
        .expect(200);
      const id = ctx.email.last().passwordResetTokenId;
      const now = ctx.clock.now();
      const claim = await ctx.resets.claimForDelivery(
        id,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
      );
      const claimToken = claim!.deliveryClaimToken;

      // Not echoed in the generic API response.
      expect(JSON.stringify(forgot.body)).not.toContain(claimToken);

      // Not written to any outbox payload or audit row.
      const scans = [
        `SELECT count(*)::int AS n FROM outbox_events o WHERE strpos(o.payload::text, $1) > 0`,
        `SELECT count(*)::int AS n FROM audit_logs a WHERE strpos(a::text, $1) > 0`,
      ];
      let total = 0;
      for (const sql of scans) {
        const rows = await ctx.prisma.$queryRawUnsafe<Array<{ n: number }>>(sql, claimToken);
        total += rows[0]?.n ?? 0;
      }
      expect(total).toBe(0);
    });
  });

  // --- idempotent provider: crash AFTER send, BEFORE the DB update ----------
  describe('idempotent provider crash-after-send', () => {
    const provider = new CountingIdempotentProvider();
    let ctx: TestApp;
    beforeAll(async () => {
      ctx = await createTestApp({ emailProvider: provider });
    });
    afterAll(async () => {
      await closeTestApp(ctx);
    });
    beforeEach(async () => {
      await resetState(ctx);
      provider.reset();
    });

    it('reuses the same idempotency key on retry and records ONE real delivery', async () => {
      const id = await requestReset(ctx);
      const now = ctx.clock.now();

      // Worker A: claim, decrypt, send (provider records the email)… then CRASH
      // before the DB success update — the row stays IN_PROGRESS, secret intact.
      const claim = await ctx.resets.claimForDelivery(
        id,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
      );
      const token = ctx.deliveryCipher.decrypt(claim!.sealed);
      await provider.send({
        email: claim!.email,
        token,
        idempotencyKey: claim!.providerIdempotencyKey,
      });
      expect(provider.sendCalls).toBe(1);
      expect(provider.realDeliveries).toBe(1);
      // Crash: secret must still be present for a retry.
      expect((await rowOf(ctx, id)).deliveryCiphertext).not.toBeNull();

      // Lease lapses → retry re-claims and sends again with the SAME key.
      ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      const retry = await ctx.delivery.deliver(id);
      expect(retry.delivered).toBe(true);

      // Two send attempts, but the idempotency key collapsed them to ONE email.
      expect(provider.sendCalls).toBe(2);
      expect(provider.realDeliveries).toBe(1);

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('SUCCEEDED');
      expect(row.deliveryCiphertext).toBeNull();
      expect(row.providerMessageId).toBe('msg-1');
    });
  });

  // --- idempotent provider failure: retryable, secret preserved ------------
  describe('idempotent provider failure', () => {
    let ctx: TestApp;
    beforeAll(async () => {
      ctx = await createTestApp({ emailProvider: new FailingIdempotentProvider() });
    });
    afterAll(async () => {
      await closeTestApp(ctx);
    });
    beforeEach(async () => {
      await resetState(ctx);
    });

    it('marks FAILED and preserves the secret for a later retry', async () => {
      const id = await requestReset(ctx);
      const result = await ctx.delivery.deliver(id);
      expect(result.delivered).toBe(false);
      expect(result).toMatchObject({ reason: 'failed' });

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('FAILED');
      expect(row.deliveryLeaseUntil).toBeNull();
      expect(row.deliveryLastError).toBeTruthy();
      // Secret preserved — the email is not lost.
      expect(row.deliveryCiphertext).not.toBeNull();

      // FAILED is retryable: a later claim can re-acquire the row.
      const now = ctx.clock.now();
      const reclaim = await ctx.resets.claimForDelivery(
        id,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
      );
      expect(reclaim).not.toBeNull();
    });
  });

  // --- non-idempotent provider: ambiguous → UNKNOWN, manual review ----------
  describe('non-idempotent provider ambiguity', () => {
    let ctx: TestApp;
    beforeAll(async () => {
      ctx = await createTestApp({ emailProvider: new FailingNonIdempotentProvider() });
    });
    afterAll(async () => {
      await closeTestApp(ctx);
    });
    beforeEach(async () => {
      await resetState(ctx);
    });

    it('quarantines as UNKNOWN, preserves the secret, and does not auto-retry', async () => {
      const id = await requestReset(ctx);
      const result = await ctx.delivery.deliver(id);
      expect(result.delivered).toBe(false);
      expect(result).toMatchObject({ reason: 'unknown' });

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('UNKNOWN');
      expect(row.deliveryLeaseUntil).toBeNull();
      // Secret preserved (not auto-erased) for manual review.
      expect(row.deliveryCiphertext).not.toBeNull();

      // UNKNOWN is NOT auto-reclaimable — it requires a human, so a second
      // delivery attempt does nothing (no uncontrolled retry → no duplicate).
      ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      const again = await ctx.delivery.deliver(id);
      expect(again.delivered).toBe(false);
      expect(again).toMatchObject({ reason: 'not_claimable' });
      expect((await rowOf(ctx, id)).deliveryStatus).toBe('UNKNOWN');
    });
  });

  // --- non-idempotent provider: crash AFTER the send started, BEFORE finalize -
  describe('non-idempotent provider crash-after-send-started', () => {
    const provider = new CountingNonIdempotentProvider();
    let ctx: TestApp;
    beforeAll(async () => {
      ctx = await createTestApp({ emailProvider: provider });
    });
    afterAll(async () => {
      await closeTestApp(ctx);
    });
    beforeEach(async () => {
      await resetState(ctx);
      provider.reset();
    });

    it('leaves delivery_send_started_at NULL right after a claim', async () => {
      const id = await requestReset(ctx);
      const now = ctx.clock.now();
      const claim = await ctx.resets.claimForDelivery(
        id,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
      );
      expect(claim).not.toBeNull();

      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('IN_PROGRESS');
      // The provider has not been called yet, so no send-started mark exists.
      expect(row.deliverySendStartedAt).toBeNull();
      expect(provider.sendCalls).toBe(0);
    });

    it('stamps delivery_send_started_at BEFORE the provider send runs', async () => {
      const id = await requestReset(ctx);
      let stampedDuringSend: Date | null | undefined;
      // Capture the persisted mark at the exact moment the provider is invoked.
      provider.onSend = async () => {
        stampedDuringSend = (await rowOf(ctx, id)).deliverySendStartedAt;
      };

      const result = await ctx.delivery.deliver(id);
      expect(result.delivered).toBe(true);
      // The mark was already committed by the time the provider ran.
      expect(stampedDuringSend).toBeInstanceOf(Date);
      expect((await rowOf(ctx, id)).deliverySendStartedAt).not.toBeNull();
    });

    it('re-claims after a crash BEFORE the send started (send_started_at still NULL)', async () => {
      const id = await requestReset(ctx);
      const now = ctx.clock.now();
      // Worker A claims and decrypts, then "crashes" before markSendStarted — the
      // provider was never called.
      const claim = await ctx.resets.claimForDelivery(
        id,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
      );
      ctx.deliveryCipher.decrypt(claim!.sealed);
      expect((await rowOf(ctx, id)).deliverySendStartedAt).toBeNull();
      expect(provider.sendCalls).toBe(0);

      // Lease lapses → recovery re-claims (send never started) and sends ONCE.
      ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      const retry = await ctx.delivery.deliver(id);
      expect(retry.delivered).toBe(true);
      expect(provider.sendCalls).toBe(1);
      expect(provider.realDeliveries).toBe(1);
      expect((await rowOf(ctx, id)).deliveryStatus).toBe('SUCCEEDED');
    });

    it('does NOT resend after a crash AFTER the send started → UNKNOWN, secret kept', async () => {
      const id = await requestReset(ctx);
      const now = ctx.clock.now();

      // Worker A: claim, mark the send started, hand the message to SMTP (recorded
      // as a real delivery)… then CRASH before markDelivered.
      const claim = await ctx.resets.claimForDelivery(
        id,
        now,
        new Date(now.getTime() + DELIVERY_LEASE_MS),
      );
      const token = ctx.deliveryCipher.decrypt(claim!.sealed);
      expect(await ctx.resets.markSendStarted(id, claim!.deliveryClaimToken, ctx.clock.now())).toBe(
        1,
      );
      await provider.send({
        email: claim!.email,
        token,
        idempotencyKey: claim!.providerIdempotencyKey,
      });
      expect(provider.sendCalls).toBe(1);
      expect(provider.realDeliveries).toBe(1);

      // Crash state: IN_PROGRESS, send-started stamped, secret intact.
      const crashed = await rowOf(ctx, id);
      expect(crashed.deliveryStatus).toBe('IN_PROGRESS');
      expect(crashed.deliverySendStartedAt).not.toBeNull();
      expect(crashed.deliveryCiphertext).not.toBeNull();

      // Lease lapses → recovery must NOT auto-resend; it quarantines as UNKNOWN.
      ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      const recovery = await ctx.delivery.deliver(id);
      expect(recovery.delivered).toBe(false);
      expect(recovery).toMatchObject({ reason: 'unknown' });
      // No SECOND SMTP call was made during recovery.
      expect(provider.sendCalls).toBe(1);
      expect(provider.realDeliveries).toBe(1);

      const row = await rowOf(ctx, id);
      // Quarantined for manual review; lease dropped; an error is recorded.
      expect(row.deliveryStatus).toBe('UNKNOWN');
      expect(row.deliveryLeaseUntil).toBeNull();
      expect(row.deliveryLastError).toBeTruthy();
      // Secret preserved (not erased) for the manual reviewer.
      expect(row.deliveryCiphertext).not.toBeNull();
      expect(row.deliveryNonce).not.toBeNull();
      expect(row.deliveryAuthTag).not.toBeNull();

      // It stays quarantined: a further attempt does nothing (no uncontrolled retry).
      ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      const again = await ctx.delivery.deliver(id);
      expect(again).toMatchObject({ delivered: false, reason: 'not_claimable' });
      expect(provider.sendCalls).toBe(1);
      expect((await rowOf(ctx, id)).deliveryStatus).toBe('UNKNOWN');
    });

    it('fences a stale worker out of markSendStarted after a re-claim', async () => {
      const id = await requestReset(ctx);
      const t0 = ctx.clock.now();
      const a = await ctx.resets.claimForDelivery(
        id,
        t0,
        new Date(t0.getTime() + DELIVERY_LEASE_MS),
      );
      // A's lease lapses; B re-claims (A never started a send, so send_started is NULL).
      ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
      const tB = ctx.clock.now();
      const b = await ctx.resets.claimForDelivery(
        id,
        tB,
        new Date(tB.getTime() + DELIVERY_LEASE_MS),
      );
      expect(b!.deliveryClaimToken).not.toBe(a!.deliveryClaimToken);

      // Stale A cannot stamp send-started on B's claim.
      expect(await ctx.resets.markSendStarted(id, a!.deliveryClaimToken, ctx.clock.now())).toBe(0);
      expect((await rowOf(ctx, id)).deliverySendStartedAt).toBeNull();
      // B (the live owner) can.
      expect(await ctx.resets.markSendStarted(id, b!.deliveryClaimToken, ctx.clock.now())).toBe(1);
      expect((await rowOf(ctx, id)).deliverySendStartedAt).not.toBeNull();
    });
  });

  // --- service returns claim_lost when superseded mid-send ------------------
  describe('service claim_lost on supersede', () => {
    const provider = new HookedDuringSendProvider();
    let ctx: TestApp;
    beforeAll(async () => {
      ctx = await createTestApp({ emailProvider: provider });
    });
    afterAll(async () => {
      await closeTestApp(ctx);
    });
    beforeEach(async () => {
      await resetState(ctx);
      provider.hook = async () => {};
    });

    it('deliver() returns claim_lost and leaves the newer claim intact', async () => {
      const id = await requestReset(ctx);

      // While worker A is inside provider.send(), worker B steals the lapsed lease
      // and re-claims, rotating the fencing token out from under A. A already
      // stamped delivery_send_started_at before sending, so B (an idempotent
      // provider, which can safely re-send) must opt into reclaiming a started send.
      provider.hook = async () => {
        ctx.clock.advanceMs(DELIVERY_LEASE_MS + 1_000);
        const now = ctx.clock.now();
        const b = await ctx.resets.claimForDelivery(
          id,
          now,
          new Date(now.getTime() + DELIVERY_LEASE_MS),
          true,
        );
        expect(b).not.toBeNull();
      };

      const result = await ctx.delivery.deliver(id);
      expect(result.delivered).toBe(false);
      expect(result).toMatchObject({ reason: 'claim_lost' });

      // A's fenced markDelivered updated nothing: B's claim is still live and the
      // secret was NOT erased.
      const row = await rowOf(ctx, id);
      expect(row.deliveryStatus).toBe('IN_PROGRESS');
      expect(row.deliveredAt).toBeNull();
      expect(row.deliveryCiphertext).not.toBeNull();
    });
  });
});
