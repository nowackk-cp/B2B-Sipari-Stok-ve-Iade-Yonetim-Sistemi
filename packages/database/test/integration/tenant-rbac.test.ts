import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ROLE_DEFINITIONS, ROLES } from '@b2b/domain';
import { resetDatabase } from '../../src/testing';
import { seed, seedCompanyRbac } from '../../src/seed';
import { createPrisma, makeCompany } from './helpers';

/**
 * DB-level tenant isolation for RBAC (TASK-010b / PERMISSION_GUARD_REVIEW PG-002).
 *
 * These assertions hold at the PostgreSQL layer regardless of application code:
 * the composite foreign keys on `user_roles` make a cross-company role
 * assignment physically impossible to insert.
 */
describe('RBAC tenant isolation (real PostgreSQL)', () => {
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

  async function makeUserIn(companyId: bigint, email: string) {
    return prisma.user.create({
      data: { companyId, email, passwordHash: 'x', fullName: email, status: 'ACTIVE' },
    });
  }

  async function makeRoleIn(companyId: bigint, name: string) {
    return prisma.role.create({ data: { companyId, name } });
  }

  it('the same role name exists as a separate row per company', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const roleA = await makeRoleIn(a.id, 'ADMIN');
    const roleB = await makeRoleIn(b.id, 'ADMIN');
    expect(roleA.id).not.toBe(roleB.id);
    expect(roleA.companyId).toBe(a.id);
    expect(roleB.companyId).toBe(b.id);
    // A second ADMIN in the SAME company is rejected (per-company unique).
    await expect(makeRoleIn(a.id, 'ADMIN')).rejects.toThrow();
  });

  it('rejects assigning a Company B role to a Company A user (companyId = A)', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const userA = await makeUserIn(a.id, 'a1@test.local');
    const roleB = await makeRoleIn(b.id, 'ADMIN');
    // user_roles.(role_id, company_id) = (roleB, A) has no matching roles(id, company_id).
    await expect(
      prisma.userRole.create({
        data: { userId: userA.id, roleId: roleB.id, companyId: a.id },
      }),
    ).rejects.toThrow();
  });

  it('rejects assigning a Company B role to a Company A user (companyId = B)', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const userA = await makeUserIn(a.id, 'a2@test.local');
    const roleB = await makeRoleIn(b.id, 'ADMIN');
    // user_roles.(user_id, company_id) = (userA, B) has no matching users(id, company_id).
    await expect(
      prisma.userRole.create({
        data: { userId: userA.id, roleId: roleB.id, companyId: b.id },
      }),
    ).rejects.toThrow();
  });

  it('rejects a user_roles row whose companyId disagrees with the user/role company', async () => {
    const a = await makeCompany(prisma);
    const other = await makeCompany(prisma);
    const userA = await makeUserIn(a.id, 'a3@test.local');
    const roleA = await makeRoleIn(a.id, 'ADMIN');
    // Both endpoints are in A, but the assignment claims a third company.
    await expect(
      prisma.userRole.create({
        data: { userId: userA.id, roleId: roleA.id, companyId: other.id },
      }),
    ).rejects.toThrow();
  });

  it('accepts a same-company assignment', async () => {
    const a = await makeCompany(prisma);
    const userA = await makeUserIn(a.id, 'a4@test.local');
    const roleA = await makeRoleIn(a.id, 'ADMIN');
    const assignment = await prisma.userRole.create({
      data: { userId: userA.id, roleId: roleA.id, companyId: a.id },
    });
    expect(assignment.companyId).toBe(a.id);
  });

  it('refuses to delete a company while it still owns RBAC rows (RESTRICT, no cascade)', async () => {
    const a = await makeCompany(prisma);
    await makeUserIn(a.id, 'a5@test.local');
    await expect(prisma.company.delete({ where: { id: a.id } })).rejects.toThrow();
  });

  it('seeds separate role rows per company and is idempotent on re-run', async () => {
    // Default company + permission catalog + its roles.
    await seed(prisma, {});
    const companyB = await makeCompany(prisma);
    await prisma.$transaction((tx) => seedCompanyRbac(tx, companyB.id));

    const totalRoles = await prisma.role.count();
    expect(totalRoles).toBe(ROLE_DEFINITIONS.length * 2);
    const adminRows = await prisma.role.findMany({ where: { name: ROLES.ADMIN } });
    expect(adminRows).toHaveLength(2);
    expect(new Set(adminRows.map((r) => r.companyId)).size).toBe(2);

    // Re-running creates no duplicate roles for company B.
    await prisma.$transaction((tx) => seedCompanyRbac(tx, companyB.id));
    expect(await prisma.role.count()).toBe(ROLE_DEFINITIONS.length * 2);
  });

  it('a permission added to Company A ADMIN does not appear on Company B ADMIN', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    // Seed the global permission catalog once, then roles per company.
    await seed(prisma, {});
    await prisma.$transaction((tx) => seedCompanyRbac(tx, a.id));
    await prisma.$transaction((tx) => seedCompanyRbac(tx, b.id));

    const adminA = await prisma.role.findFirstOrThrow({
      where: { companyId: a.id, name: ROLES.ADMIN },
    });
    const perm = await prisma.permission.findFirstOrThrow({ where: { code: 'system:read' } });
    await prisma.rolePermission.create({ data: { roleId: adminA.id, permissionId: perm.id } });

    const adminB = await prisma.role.findFirstOrThrow({
      where: { companyId: b.id, name: ROLES.ADMIN },
    });
    const onB = await prisma.rolePermission.findFirst({
      where: { roleId: adminB.id, permission: { code: 'system:read' } },
    });
    expect(onB).toBeNull();
  });
});
