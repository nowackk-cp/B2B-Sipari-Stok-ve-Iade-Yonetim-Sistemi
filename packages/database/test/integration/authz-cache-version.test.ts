import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, makeCompany } from './helpers';

/**
 * DB-level guarantees for the authorization cache version counter (PG-004).
 *
 * These hold at the PostgreSQL layer regardless of application code: triggers
 * maintain one monotonic `company_authz_versions.version` per company, bump it
 * in-transaction on every permission-affecting change, keep companies isolated,
 * and roll the bump back with an aborted transaction.
 */
describe('authorization cache version (real PostgreSQL)', () => {
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

  async function version(companyId: bigint): Promise<bigint> {
    const row = await prisma.companyAuthzVersion.findUniqueOrThrow({ where: { companyId } });
    return row.version;
  }

  async function makeUserIn(companyId: bigint, email: string) {
    return prisma.user.create({
      data: { companyId, email, passwordHash: 'x', fullName: email, status: 'ACTIVE' },
    });
  }
  async function makeRoleIn(companyId: bigint, name: string) {
    return prisma.role.create({ data: { companyId, name } });
  }
  async function makePermission(code: string) {
    return prisma.permission.create({ data: { code, module: 'm', permissionGroup: 'g' } });
  }

  it('seeds a baseline version of 1 for every new company', async () => {
    const a = await makeCompany(prisma);
    expect(await version(a.id)).toBe(1n);
  });

  it('bumps on user_roles, role_permissions insert/delete; the first bump yields 2', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'u@a.test');
    const role = await makeRoleIn(a.id, 'R');
    const perm = await makePermission(`p_${a.id}`);
    // Creating a user/role grants nobody anything yet → no bump.
    expect(await version(a.id)).toBe(1n);

    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    expect(await version(a.id)).toBe(2n); // first change → 2

    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, companyId: a.id } });
    expect(await version(a.id)).toBe(3n);

    await prisma.userRole.delete({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
    });
    expect(await version(a.id)).toBe(4n);

    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
    });
    expect(await version(a.id)).toBe(5n);
  });

  it('bumps on a permission-relevant user change but NOT on login bookkeeping', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'u2@a.test');
    const before = await version(a.id);

    // Hot login path: last_login_at / failed_login_count must not churn the cache.
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 3 },
    });
    expect(await version(a.id)).toBe(before);

    // Status (disable) and soft-delete are permission-relevant → bump.
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    expect(await version(a.id)).toBe(before + 1n);
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    expect(await version(a.id)).toBe(before + 2n);
  });

  it('isolates companies: a bump in A never moves B', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const role = await makeRoleIn(a.id, 'R');
    const perm = await makePermission(`p_${a.id}`);
    const bBefore = await version(b.id);

    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });

    expect(await version(a.id)).toBe(2n);
    expect(await version(b.id)).toBe(bBefore); // untouched
  });

  it('rolls the bump back when the transaction aborts', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'u3@a.test');
    const before = await version(a.id);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
        throw new Error('abort'); // force rollback
      }),
    ).rejects.toThrow('abort');

    expect(await version(a.id)).toBe(before); // no leaked bump
  });

  it('bumps once (and never errors) when a role with grants is hard-deleted', async () => {
    const a = await makeCompany(prisma);
    const role = await makeRoleIn(a.id, 'R');
    const perm = await makePermission(`p_${a.id}`);
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const before = await version(a.id);

    // Deleting the role cascade-deletes its role_permissions; the guarded trigger
    // must not error, and the company version advances.
    await prisma.role.delete({ where: { id: role.id } });
    expect(await version(a.id)).toBeGreaterThan(before);
  });
});
