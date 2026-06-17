import { randomBytes } from 'node:crypto';
import type { INestApplication, ModuleMetadata, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { argon2id } from 'hash-wasm';
import { PrismaClient, type Prisma, seed } from '@b2b/database';
import { ROLES, type RoleName } from '@b2b/domain';
import { AppModule } from '../../src/app.module';
import { PERMISSION_CACHE } from '../../src/modules/authorization/authorization.constants';
import type { PermissionCache } from '../../src/modules/authorization/ports/permission-cache.port';
import { AppConfigService } from '../../src/common/config/app-config.service';
import { configureApp } from '../../src/bootstrap';
import { CLOCK, type Clock } from '../../src/common/time/clock';
import { EMAIL_OUTBOX, RATE_LIMITER } from '../../src/modules/auth/auth.constants';
import { InMemoryRateLimiter } from '../../src/modules/auth/adapters/in-memory-rate-limiter';
import type {
  EmailOutbox,
  PasswordResetRequestedEvent,
} from '../../src/modules/auth/ports/email-outbox.port';
import { PasswordResetDeliveryService } from '../../src/modules/security/password-reset-delivery.service';
import { PasswordResetRepository } from '../../src/modules/security/password-reset.repository';
import { PasswordResetDeliveryCipher } from '../../src/modules/security/password-reset-delivery.cipher';
import {
  RESET_EMAIL_PROVIDER,
  type ResetEmailProvider,
} from '../../src/modules/security/ports/reset-email-provider.port';
import { FakeResetEmailProvider } from '../support/fake-reset-email-provider';

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

/** Email outbox spy that ALSO writes the real (secret-free) outbox row, so tests
 * can assert both the captured event and the transactional DB write. Mirrors the
 * production adapter: the raw token is NEVER part of the payload (AUTH-BLOCK-001). */
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
          type: 'password-reset',
          template: 'password-reset',
          to: event.email,
          userId: event.userPublicId,
          passwordResetTokenId: event.passwordResetTokenId.toString(),
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
  /** The approved mail-delivery boundary: claims/decrypts the sealed reset token. */
  delivery: PasswordResetDeliveryService;
  /** Repository, for tests that drive the lease/claim flow directly. */
  resets: PasswordResetRepository;
  /** The delivery cipher, for tests that decrypt a claimed secret in memory. */
  deliveryCipher: PasswordResetDeliveryCipher;
  /** The reset email provider actually bound in the app (the test fake by default). */
  emailProvider: ResetEmailProvider;
  /** The effective-permission cache bound in the app (in-memory by default). */
  permissionCache: PermissionCache;
}

export interface CreateTestAppOptions {
  /** Override the password-reset email provider (e.g. a counting/failing fake). */
  emailProvider?: ResetEmailProvider;
  /**
   * Keep the real production provider (SMTP) bound instead of the test fake. Used
   * only to assert production wiring; do NOT drive deliveries with it (no relay).
   */
  keepRealEmailProvider?: boolean;
  /** Extra test-only controllers to register (e.g. the authz test controller). */
  controllers?: Type[];
  /** Extra modules to import so the controllers' guards resolve their providers. */
  imports?: ModuleMetadata['imports'];
}

/**
 * Boot the full Nest app against the real test database with deterministic
 * adapters: a controllable clock, an in-memory rate limiter (no Redis needed in
 * tests) and a capturing email outbox. The DB is truncated first. An optional
 * reset email provider override lets crash/idempotency tests inject a fake.
 */
export async function createTestApp(opts: CreateTestAppOptions = {}): Promise<TestApp> {
  const clock = new MutableClock();
  const email = new CapturingEmailOutbox();

  let builder = Test.createTestingModule({
    imports: [AppModule, ...(opts.imports ?? [])],
    controllers: opts.controllers ?? [],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(RATE_LIMITER)
    .useClass(InMemoryRateLimiter)
    .overrideProvider(EMAIL_OUTBOX)
    .useValue(email);
  // Default to a test-only fake so deliveries never hit a real SMTP relay. The
  // real SmtpResetEmailProvider stays bound only when a test explicitly asks
  // (keepRealEmailProvider) to assert production wiring.
  if (!opts.keepRealEmailProvider) {
    const provider = opts.emailProvider ?? new FakeResetEmailProvider();
    builder = builder.overrideProvider(RESET_EMAIL_PROVIDER).useValue(provider);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  configureApp(app, app.get(AppConfigService));
  await app.init();

  const prisma = new PrismaClient();
  await resetDatabase(prisma);

  const rateLimiter = app.get(RATE_LIMITER) as InMemoryRateLimiter;
  const delivery = app.get(PasswordResetDeliveryService);
  const resets = app.get(PasswordResetRepository);
  const deliveryCipher = app.get(PasswordResetDeliveryCipher);
  const emailProvider = app.get<ResetEmailProvider>(RESET_EMAIL_PROVIDER);
  const permissionCache = app.get<PermissionCache>(PERMISSION_CACHE);
  return {
    app,
    http: app.getHttpServer(),
    prisma,
    clock,
    rateLimiter,
    email,
    delivery,
    resets,
    deliveryCipher,
    emailProvider,
    permissionCache,
  };
}

/**
 * Drive a captured reset event through the approved delivery boundary and return
 * the raw link token (the only place the plaintext token exists — in memory).
 * This replaces reading the token from the outbox payload, which no longer
 * carries it (AUTH-BLOCK-001).
 */
export async function deliverResetToken(
  ctx: TestApp,
  event: PasswordResetRequestedEvent = ctx.email.last(),
): Promise<string> {
  const result = await ctx.delivery.deliver(event.passwordResetTokenId);
  if (!result.delivered) {
    throw new Error(`reset delivery failed: ${result.reason}`);
  }
  return result.token;
}

export async function closeTestApp(ctx: TestApp): Promise<void> {
  await ctx.prisma.$disconnect();
  await ctx.app.close();
}

/** Per-test isolation: truncate the DB, clear rate-limit + captured emails +
 * the permission cache. */
export async function resetState(ctx: TestApp): Promise<void> {
  await resetDatabase(ctx.prisma);
  ctx.rateLimiter.clearAll();
  ctx.email.events.length = 0;
  await ctx.permissionCache.clear();
}

/**
 * Seed the canonical RBAC catalog (permissions, system roles and the
 * role→permission matrix from `@b2b/domain`) into the freshly-truncated test DB.
 * Idempotent; uses the same production seed so role permission sets (e.g. VIEWER
 * = read-only) are authoritative rather than hand-mirrored in the test.
 */
export async function seedRbac(prisma: PrismaClient): Promise<void> {
  await seed(prisma, {
    ...process.env,
    BOOTSTRAP_ADMIN_EMAIL: '',
    BOOTSTRAP_ADMIN_PASSWORD_HASH: '',
  });
}

/** Canonical default test tenant (mirrors the seed's "Default Company"). */
export const DEFAULT_COMPANY_NAME = 'Default Company';

/** Find-or-create the default tenant so users and seeded roles share a company. */
export async function ensureDefaultCompany(prisma: PrismaClient): Promise<bigint> {
  const existing = await prisma.company.findFirst({ where: { name: DEFAULT_COMPANY_NAME } });
  if (existing) return existing.id;
  const created = await prisma.company.create({ data: { name: DEFAULT_COMPANY_NAME } });
  return created.id;
}

let companySeq = 0;

/** Create a standalone tenant (for cross-company isolation tests). */
export async function createCompany(prisma: PrismaClient, name?: string): Promise<bigint> {
  companySeq += 1;
  const company = await prisma.company.create({
    data: { name: name ?? `Company ${Date.now().toString(36)}_${companySeq}` },
  });
  return company.id;
}

/** The user's owning tenant (company-scoped RBAC needs it for role lookups). */
async function companyOf(prisma: PrismaClient, userId: bigint): Promise<bigint> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { companyId: true },
  });
  return u.companyId;
}

/** Assign a seeded system role (by name, WITHIN the user's company) to a user. */
export async function assignRole(
  prisma: PrismaClient,
  userId: bigint,
  roleName: RoleName,
): Promise<void> {
  const companyId = await companyOf(prisma, userId);
  const role = await prisma.role.findUniqueOrThrow({
    where: { companyId_name: { companyId, name: roleName } },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    update: {},
    create: { userId, roleId: role.id, companyId },
  });
}

let customRoleSeq = 0;

/**
 * Create a uniquely-named non-system role (in the user's company) granting
 * exactly `permissionCodes` (which must already be seeded) and assign it to
 * `userId`. Gives tests precise control over effective permissions.
 */
export async function grantPermissionsViaRole(
  prisma: PrismaClient,
  userId: bigint,
  permissionCodes: string[],
  roleName?: string,
): Promise<void> {
  const companyId = await companyOf(prisma, userId);
  customRoleSeq += 1;
  const name = roleName ?? `TEST_ROLE_${Date.now().toString(36)}_${customRoleSeq}`;
  const role = await prisma.role.create({ data: { companyId, name, privilegeLevel: 5 } });
  const perms = await prisma.permission.findMany({
    where: { code: { in: permissionCodes } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
    skipDuplicates: true,
  });
  await prisma.userRole.create({ data: { userId, roleId: role.id, companyId } });
}

let warehouseSeq = 0;

/** Create a warehouse in `companyId` (warehouses are company-scoped). */
export async function createWarehouse(
  prisma: PrismaClient,
  companyId: bigint,
  over: Partial<{ code: string; isActive: boolean; deletedAt: Date | null }> = {},
): Promise<{ id: bigint; companyId: bigint }> {
  warehouseSeq += 1;
  const code = over.code ?? `WH_${Date.now().toString(36)}_${warehouseSeq}`;
  const wh = await prisma.warehouse.create({
    data: {
      companyId,
      code,
      name: code,
      country: 'TR',
      isActive: over.isActive ?? true,
      deletedAt: over.deletedAt ?? null,
    },
    select: { id: true, companyId: true },
  });
  return wh;
}

let productSeq = 0;

/** Create a product directly in `companyId` (catalog is company-scoped). Used to
 * stand up another tenant's product without going through the API. */
export async function createProduct(
  prisma: PrismaClient,
  companyId: bigint,
  over: Partial<{ sku: string; name: string; isActive: boolean; deletedAt: Date | null }> = {},
): Promise<{ id: bigint; publicId: string; sku: string; companyId: bigint }> {
  productSeq += 1;
  const sku = over.sku ?? `SKU_${Date.now().toString(36)}_${productSeq}`;
  const product = await prisma.product.create({
    data: {
      companyId,
      sku,
      name: over.name ?? `Product ${productSeq}`,
      isActive: over.isActive ?? true,
      deletedAt: over.deletedAt ?? null,
    },
    select: { id: true, publicId: true, sku: true, companyId: true },
  });
  return product;
}

let customerSeq = 0;

/** Create a customer directly in `companyId` (customers are company-scoped). Used
 * to stand up another tenant's customer without going through the API. */
export async function createCustomer(
  prisma: PrismaClient,
  companyId: bigint,
  over: Partial<{
    code: string;
    name: string;
    type: string;
    taxNumber: string | null;
    email: string | null;
    phone: string | null;
    deletedAt: Date | null;
  }> = {},
): Promise<{ id: bigint; publicId: string; code: string; companyId: bigint }> {
  customerSeq += 1;
  const code = over.code ?? `CUST_${Date.now().toString(36)}_${customerSeq}`;
  const customer = await prisma.customer.create({
    data: {
      companyId,
      code,
      name: over.name ?? `Customer ${customerSeq}`,
      type: over.type ?? 'COMPANY',
      taxNumber: over.taxNumber ?? null,
      email: over.email ?? null,
      phone: over.phone ?? null,
      deletedAt: over.deletedAt ?? null,
    },
    select: { id: true, publicId: true, code: true, companyId: true },
  });
  return customer;
}

/** Grant `userId` an explicit warehouse scope (same tenant — composite FKs enforce it). */
export async function assignWarehouseScope(
  prisma: PrismaClient,
  userId: bigint,
  warehouseId: bigint,
  companyId: bigint,
): Promise<void> {
  await prisma.userWarehouseScope.upsert({
    where: { userId_warehouseId: { userId, warehouseId } },
    update: {},
    create: { userId, warehouseId, companyId, grantedById: userId },
  });
}

/** Add a single permission to an existing role (no role-membership change) —
 * used to prove the permission cache must be invalidated to see the change. */
export async function addPermissionToRole(
  prisma: PrismaClient,
  roleName: string,
  permissionCode: string,
): Promise<void> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const perm = await prisma.permission.findUniqueOrThrow({ where: { code: permissionCode } });
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
    update: {},
    create: { roleId: role.id, permissionId: perm.id },
  });
}

export { ROLES };

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
  companyId: bigint;
  email: string;
  password: string;
}

/**
 * Create an active (or overridden) user with a known password. Users are
 * company-scoped; unless a `companyId` is pinned the user joins the default test
 * tenant (the same company the seed creates its roles in), so `assignRole` finds
 * a same-company role.
 */
export async function createUser(
  prisma: PrismaClient,
  over: Partial<{
    email: string;
    password: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
    companyId: bigint;
  }> = {},
): Promise<CreatedUser> {
  userSeq += 1;
  const email = over.email ?? `user_${Date.now().toString(36)}_${userSeq}@test.local`;
  const password = over.password ?? 'correct horse battery staple';
  const companyId = over.companyId ?? (await ensureDefaultCompany(prisma));
  const user = await prisma.user.create({
    data: {
      companyId,
      email,
      passwordHash: await hashPassword(password),
      fullName: `Test User ${userSeq}`,
      status: over.status ?? 'ACTIVE',
      passwordChangedAt: new Date(),
    },
    select: { id: true, publicId: true, companyId: true, email: true },
  });
  return { ...user, password };
}
