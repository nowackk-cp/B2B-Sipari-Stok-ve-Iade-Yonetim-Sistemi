import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PERMISSIONS,
  PROTECTED_PERMISSION_CODES,
  ROLE_DEFINITIONS,
  ROLES,
  WAREHOUSE_SCOPE_ALL,
} from '@b2b/domain';
import { resetDatabase } from '../../src/testing';
import { seed } from '../../src/seed';
import { createPrisma } from './helpers';

describe('seed (idempotent system seed)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('seeds the full permission catalog and roles on first run', async () => {
    const report = await seed(prisma, {});
    expect(report.permissions).toBe(PERMISSIONS.length);
    expect(report.roles).toBe(ROLE_DEFINITIONS.length);
    expect(await prisma.permission.count()).toBe(PERMISSIONS.length);
    expect(await prisma.role.count()).toBe(ROLE_DEFINITIONS.length);
  });

  it('is idempotent — a second run creates no duplicates', async () => {
    await seed(prisma, {});
    await seed(prisma, {});
    expect(await prisma.permission.count()).toBe(PERMISSIONS.length);
    expect(await prisma.role.count()).toBe(ROLE_DEFINITIONS.length);
    // role_permissions are stable across runs
    const before = await prisma.rolePermission.count();
    await seed(prisma, {});
    expect(await prisma.rolePermission.count()).toBe(before);
  });

  it('preserves protected/system flags on roles', async () => {
    await seed(prisma, {});
    // Roles are company-scoped: look them up within the seeded default company.
    const systemAdmin = await prisma.role.findFirst({ where: { name: ROLES.SYSTEM_ADMIN } });
    expect(systemAdmin?.isProtected).toBe(true);
    expect(systemAdmin?.isSystem).toBe(true);
    expect(systemAdmin?.privilegeLevel).toBe(100);
    expect(typeof systemAdmin?.companyId).toBe('bigint');
    const admin = await prisma.role.findFirst({ where: { name: ROLES.ADMIN } });
    expect(admin?.isProtected).toBe(false);
    expect(admin?.privilegeLevel).toBe(50);
  });

  it('flags exactly the protected permissions and uses the canonical key', async () => {
    await seed(prisma, {});
    const protectedRows = await prisma.permission.findMany({ where: { isProtected: true } });
    expect(protectedRows.map((p) => p.code).sort()).toEqual([...PROTECTED_PERMISSION_CODES].sort());
    // Canonical colon spelling only — no dot-notation alias.
    expect(
      await prisma.permission.findUnique({ where: { code: WAREHOUSE_SCOPE_ALL } }),
    ).not.toBeNull();
    expect(
      await prisma.permission.findUnique({ where: { code: 'warehouse.scope.all' } }),
    ).toBeNull();
  });

  it('never seeds a protected permission onto ADMIN', async () => {
    await seed(prisma, {});
    const adminProtected = await prisma.rolePermission.findMany({
      where: { role: { name: ROLES.ADMIN }, permission: { isProtected: true } },
    });
    expect(adminProtected).toHaveLength(0);
  });

  it('seeds NO implicit warehouse scope for any role', async () => {
    await seed(prisma, {});
    expect(await prisma.userWarehouseScope.count()).toBe(0);
  });

  it('grants warehouse:scope:all only to SYSTEM_ADMIN', async () => {
    await seed(prisma, {});
    const holders = await prisma.rolePermission.findMany({
      where: { permission: { code: WAREHOUSE_SCOPE_ALL } },
      include: { role: true },
    });
    expect(holders.map((h) => h.role.name)).toEqual([ROLES.SYSTEM_ADMIN]);
  });

  it('does not create a bootstrap user without explicit env, and never leaks secrets in the report', async () => {
    const report = await seed(prisma, {});
    expect(report.bootstrapAdminCreated).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/password|hash|secret/i);
    expect(await prisma.user.count()).toBe(0);
  });

  it('creates the env-gated bootstrap SYSTEM_ADMIN with the supplied hash and never resets it', async () => {
    const env = {
      BOOTSTRAP_ADMIN_EMAIL: 'root@test.local',
      BOOTSTRAP_ADMIN_PASSWORD_HASH: 'argon2id$first',
    } as NodeJS.ProcessEnv;
    const first = await seed(prisma, env);
    expect(first.bootstrapAdminCreated).toBe(true);

    const created = await prisma.user.findUnique({ where: { email: 'root@test.local' } });
    expect(created?.passwordHash).toBe('argon2id$first');

    // Re-run with a DIFFERENT hash: existing password must NOT be reset.
    const second = await seed(prisma, {
      BOOTSTRAP_ADMIN_EMAIL: 'root@test.local',
      BOOTSTRAP_ADMIN_PASSWORD_HASH: 'argon2id$second',
    } as NodeJS.ProcessEnv);
    expect(second.bootstrapAdminCreated).toBe(false);
    const after = await prisma.user.findUnique({ where: { email: 'root@test.local' } });
    expect(after?.passwordHash).toBe('argon2id$first');

    // Bootstrap user carries SYSTEM_ADMIN role but no implicit warehouse scope.
    const roles = await prisma.userRole.findMany({
      where: { userId: created!.id },
      include: { role: true },
    });
    expect(roles.map((r) => r.role.name)).toContain(ROLES.SYSTEM_ADMIN);
    expect(await prisma.userWarehouseScope.count()).toBe(0);
  });
});
