import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, dbConfigured, makeUser, makeWarehouse } from './helpers';

describe.skipIf(!dbConfigured)('RBAC persistence', () => {
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

  it('rejects a duplicate user→role assignment', async () => {
    const user = await makeUser(prisma);
    const role = await prisma.role.create({ data: { name: `R_${Date.now()}` } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    await expect(
      prisma.userRole.create({ data: { userId: user.id, roleId: role.id } }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate role→permission grant', async () => {
    const role = await prisma.role.create({ data: { name: `R_${Date.now()}` } });
    const perm = await prisma.permission.create({
      data: { code: `perm:${Date.now()}`, module: 'm', permissionGroup: 'RBAC' },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    await expect(
      prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate warehouse scope row', async () => {
    const granter = await makeUser(prisma);
    const user = await makeUser(prisma);
    const warehouse = await makeWarehouse(prisma);
    await prisma.userWarehouseScope.create({
      data: { userId: user.id, warehouseId: warehouse.id, grantedById: granter.id },
    });
    await expect(
      prisma.userWarehouseScope.create({
        data: { userId: user.id, warehouseId: warehouse.id, grantedById: granter.id },
      }),
    ).rejects.toThrow();
  });

  it('persists protected role/permission flags exactly as written', async () => {
    const role = await prisma.role.create({
      data: { name: `SYS_${Date.now()}`, isSystem: true, isProtected: true, privilegeLevel: 100 },
    });
    const perm = await prisma.permission.create({
      data: { code: `prot:${Date.now()}`, module: 'm', permissionGroup: 'RBAC', isProtected: true },
    });
    expect(role.isProtected).toBe(true);
    expect(role.isSystem).toBe(true);
    expect(perm.isProtected).toBe(true);
  });

  it('does not create any implicit warehouse scope row when a user has none', async () => {
    const user = await makeUser(prisma);
    // A user with roles but no explicit scope must have zero scope rows — there
    // is no persistence path that materialises implicit/global scope.
    const role = await prisma.role.create({
      data: { name: `ADM_${Date.now()}`, privilegeLevel: 50 },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    expect(await prisma.userWarehouseScope.count({ where: { userId: user.id } })).toBe(0);
  });
});
