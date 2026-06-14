import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { argon2id } from 'hash-wasm';
import { PrismaClient, type Prisma } from '@b2b/database';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/common/config/app-config.service';
import { configureApp } from '../../src/bootstrap';
import { CLOCK, type Clock } from '../../src/common/time/clock';
import { EMAIL_OUTBOX, RATE_LIMITER } from '../../src/modules/auth/auth.constants';
import { InMemoryRateLimiter } from '../../src/modules/auth/adapters/in-memory-rate-limiter';
import type {
  EmailOutbox,
  PasswordResetRequestedEvent,
} from '../../src/modules/auth/ports/email-outbox.port';

/**
 * Truncate every application table so each test starts clean. Guarded against
 * non-test databases (the URL must name a "test" database) — TRUNCATE bypasses
 * the append-only row triggers so immutable tables (audit_logs) clear too.
 */
export async function resetDatabase(client: PrismaClient): Promise<void> {
  const dbName = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to truncate non-test database "${dbName}".`);
  }
  const rows = await client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

/** Controllable clock for token-expiry / lockout-window tests. */
export class MutableClock implements Clock {
  constructor(private current = new Date('2026-06-15T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  set(date: Date): void {
    this.current = date;
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceMinutes(min: number): void {
    this.advanceMs(min * 60_000);
  }
}

/** Email outbox spy that ALSO writes the real outbox row, so tests can assert
 * both the captured payload and the transactional DB write. */
export class CapturingEmailOutbox implements EmailOutbox {
  readonly events: PasswordResetRequestedEvent[] = [];
  async enqueuePasswordReset(
    tx: Prisma.TransactionClient,
    event: PasswordResetRequestedEvent,
  ): Promise<void> {
    this.events.push(event);
    await tx.outboxEvent.create({
      data: {
        eventType: 'auth.password_reset.requested',
        aggregateType: 'USER',
        aggregateId: event.userId,
        deduplicationKey: `password-reset:${event.dedupKey}`,
        payload: {
          template: 'password-reset',
          to: event.email,
          resetToken: event.resetToken,
          expiresAt: event.expiresAt.toISOString(),
        } satisfies Prisma.InputJsonObject,
      },
    });
  }
  last(): PasswordResetRequestedEvent {
    const e = this.events.at(-1);
    if (!e) throw new Error('no password reset event captured');
    return e;
  }
}

export interface TestApp {
  app: INestApplication;
  http: import('http').Server;
  prisma: PrismaClient;
  clock: MutableClock;
  rateLimiter: InMemoryRateLimiter;
  email: CapturingEmailOutbox;
}

/**
 * Boot the full Nest app against the real test database with deterministic
 * adapters: a controllable clock, an in-memory rate limiter (no Redis needed in
 * tests) and a capturing email outbox. The DB is truncated first.
 */
export async function createTestApp(): Promise<TestApp> {
  const clock = new MutableClock();
  const email = new CapturingEmailOutbox();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(RATE_LIMITER)
    .useClass(InMemoryRateLimiter)
    .overrideProvider(EMAIL_OUTBOX)
    .useValue(email)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app, app.get(AppConfigService));
  await app.init();

  const prisma = new PrismaClient();
  await resetDatabase(prisma);

  const rateLimiter = app.get(RATE_LIMITER) as InMemoryRateLimiter;
  return { app, http: app.getHttpServer(), prisma, clock, rateLimiter, email };
}

export async function closeTestApp(ctx: TestApp): Promise<void> {
  await ctx.prisma.$disconnect();
  await ctx.app.close();
}

/** Per-test isolation: truncate the DB, clear rate-limit + captured emails. */
export async function resetState(ctx: TestApp): Promise<void> {
  await resetDatabase(ctx.prisma);
  ctx.rateLimiter.clearAll();
  ctx.email.events.length = 0;
}

let userSeq = 0;

/** argon2id hash using the lowered test cost (matches the test env config so a
 * freshly created user does not trigger a rehash). */
export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password: password.normalize('NFKC'),
    salt: randomBytes(16),
    memorySize: 8192,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
    outputType: 'encoded',
  });
}

/** Extract the `name=value` part of the refresh cookie from a response. */
export function refreshCookieFrom(res: { headers: Record<string, unknown> }): string {
  const set = res.headers['set-cookie'] as string[] | undefined;
  const entry = set?.find((c) => c.startsWith('b2b_refresh_token='));
  if (!entry) throw new Error('no refresh cookie was set');
  return entry.split(';')[0] as string;
}

/** Whether the response cleared the refresh cookie (Max-Age/Expires in the past). */
export function refreshCookieCleared(res: { headers: Record<string, unknown> }): boolean {
  const set = res.headers['set-cookie'] as string[] | undefined;
  const entry = set?.find((c) => c.startsWith('b2b_refresh_token='));
  if (!entry) return false;
  return /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(entry);
}

export interface CreatedUser {
  id: bigint;
  publicId: string;
  email: string;
  password: string;
}

/** Create an active (or overridden) user with a known password. */
export async function createUser(
  prisma: PrismaClient,
  over: Partial<{
    email: string;
    password: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
  }> = {},
): Promise<CreatedUser> {
  userSeq += 1;
  const email = over.email ?? `user_${Date.now().toString(36)}_${userSeq}@test.local`;
  const password = over.password ?? 'correct horse battery staple';
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      fullName: `Test User ${userSeq}`,
      status: over.status ?? 'ACTIVE',
      passwordChangedAt: new Date(),
    },
    select: { id: true, publicId: true, email: true },
  });
  return { ...user, password };
}
