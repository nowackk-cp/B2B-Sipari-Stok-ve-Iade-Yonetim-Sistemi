import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, makeCompany } from './helpers';

/**
 * DB-level guarantees for warehouse scope (TASK-010c / SECURITY_MODEL §3).
 *
 * These hold at the PostgreSQL layer regardless of application code: the two
 * company-pinned composite FKs make a cross-company grant physically un-insertable,
 * RESTRICT refuses a silent cascade when a user/warehouse is hard-deleted, the PK
 * blocks a duplicate grant, and a trigger bumps the owning company's authorization
 * version on every scope change (rolling back with an aborted transaction).
 */
describe('warehouse scope tenancy (real PostgreSQL)', () => {
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
  async function makeWarehouseIn(companyId: bigint, code: string) {
    return prisma.warehouse.create({ data: { companyId, code, name: code, country: 'TR' } });
  }
  async function version(companyId: bigint): Promise<bigint> {
    const row = await prisma.companyAuthzVersion.findUniqueOrThrow({ where: { companyId } });
    return row.version;
  }

  it('accepts a same-company scope grant', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'u@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A');
    const scope = await prisma.userWarehouseScope.create({
      data: { userId: user.id, warehouseId: wh.id, companyId: a.id, grantedById: user.id },
    });
    expect(scope.companyId).toBe(a.id);
  });

  it('rejects a cross-company grant: user in A, warehouse in B (companyId = A)', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const userA = await makeUserIn(a.id, 'a@a.test');
    const whB = await makeWarehouseIn(b.id, 'WH_B');
    // (warehouse_id, company_id) = (whB, A) has no matching warehouses(id, company_id).
    await expect(
      prisma.userWarehouseScope.create({
        data: { userId: userA.id, warehouseId: whB.id, companyId: a.id },
      }),
    ).rejects.toThrow();
  });

  it('rejects a cross-company grant: user in A, warehouse in B (companyId = B)', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const userA = await makeUserIn(a.id, 'a2@a.test');
    const whB = await makeWarehouseIn(b.id, 'WH_B2');
    // (user_id, company_id) = (userA, B) has no matching users(id, company_id).
    await expect(
      prisma.userWarehouseScope.create({
        data: { userId: userA.id, warehouseId: whB.id, companyId: b.id },
      }),
    ).rejects.toThrow();
  });

  it('rejects a scope whose companyId disagrees with user and warehouse', async () => {
    const a = await makeCompany(prisma);
    const other = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'a3@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A3');
    await expect(
      prisma.userWarehouseScope.create({
        data: { userId: user.id, warehouseId: wh.id, companyId: other.id },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate active scope for the same (user, warehouse)', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'a4@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A4');
    await prisma.userWarehouseScope.create({
      data: { userId: user.id, warehouseId: wh.id, companyId: a.id },
    });
    await expect(
      prisma.userWarehouseScope.create({
        data: { userId: user.id, warehouseId: wh.id, companyId: a.id },
      }),
    ).rejects.toThrow();
  });

  it('refuses to hard-delete a warehouse that still owns a scope (RESTRICT, no cascade)', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'a5@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A5');
    await prisma.userWarehouseScope.create({
      data: { userId: user.id, warehouseId: wh.id, companyId: a.id },
    });
    await expect(prisma.warehouse.delete({ where: { id: wh.id } })).rejects.toThrow();
    // The grant survives the refused delete.
    expect(
      await prisma.userWarehouseScope.count({ where: { userId: user.id, warehouseId: wh.id } }),
    ).toBe(1);
  });

  it('refuses to hard-delete a user that still owns a scope (no silent cascade)', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'a6@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A6');
    await prisma.userWarehouseScope.create({
      data: { userId: user.id, warehouseId: wh.id, companyId: a.id },
    });
    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow();
    expect(await prisma.userWarehouseScope.count({ where: { userId: user.id } })).toBe(1);
  });

  it('allows a nullable granted_by (creator is optional)', async () => {
    // created-by is optional: a grant may exist without a recorded granter. (Users
    // can never be hard-deleted — the no_delete_users trigger blocks that — so the
    // FK's SetNull action is a belt-and-braces guard, not a routine path.)
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'a7@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A7');
    const scope = await prisma.userWarehouseScope.create({
      data: { userId: user.id, warehouseId: wh.id, companyId: a.id }, // no grantedById
    });
    expect(scope.grantedById).toBeNull();
  });

  it('bumps the company authorization version on scope insert and delete', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'a8@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A8');
    const before = await version(a.id);

    await prisma.userWarehouseScope.create({
      data: { userId: user.id, warehouseId: wh.id, companyId: a.id },
    });
    expect(await version(a.id)).toBe(before + 1n);

    await prisma.userWarehouseScope.delete({
      where: { userId_warehouseId: { userId: user.id, warehouseId: wh.id } },
    });
    expect(await version(a.id)).toBe(before + 2n);
  });

  it('isolates companies: a scope change in A never moves B', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'a9@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A9');
    const bBefore = await version(b.id);

    await prisma.userWarehouseScope.create({
      data: { userId: user.id, warehouseId: wh.id, companyId: a.id },
    });
    expect(await version(b.id)).toBe(bBefore); // untouched
  });

  it('rolls the authz-version bump back when the scope transaction aborts', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'a10@a.test');
    const wh = await makeWarehouseIn(a.id, 'WH_A10');
    const before = await version(a.id);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.userWarehouseScope.create({
          data: { userId: user.id, warehouseId: wh.id, companyId: a.id },
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect(await version(a.id)).toBe(before); // no leaked bump
    expect(await prisma.userWarehouseScope.count()).toBe(0);
  });

  it('rejects a warehouse with no company_id (tenancy is mandatory)', async () => {
    await expect(
      // @ts-expect-error company_id is required; this asserts the NOT NULL at the DB.
      prisma.warehouse.create({ data: { code: 'NOCO', name: 'NoCo', country: 'TR' } }),
    ).rejects.toThrow();
  });
});
