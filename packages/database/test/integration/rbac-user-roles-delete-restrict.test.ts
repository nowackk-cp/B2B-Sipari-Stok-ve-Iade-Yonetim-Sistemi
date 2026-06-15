import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resetDatabase } from '../../src/testing';
import { createPrisma, makeCompany } from './helpers';

/**
 * DB-level delete semantics for RBAC assignments (RBAC-TI-002).
 *
 * `20260616020000_rbac_user_roles_delete_restrict` re-creates the two user_roles
 * composite foreign keys ON DELETE RESTRICT (they were ON DELETE CASCADE). The
 * database must therefore REFUSE to hard-delete a user or role that still owns an
 * assignment, instead of silently cascading the assignment away (an unaudited
 * authorization-state change). These assertions hold at the PostgreSQL layer
 * regardless of application code.
 *
 * Note: `users` additionally carry a `no_delete_users` BEFORE DELETE trigger
 * (soft-delete master data), so a user hard delete is blocked even after its
 * assignments are gone — the RESTRICT FK is defence-in-depth there. `roles` have
 * no such trigger, so the role-side RESTRICT FK is the sole, and decisive, guard.
 */
describe('RBAC user_roles delete RESTRICT (real PostgreSQL)', () => {
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

  async function assign(userId: bigint, roleId: bigint, companyId: bigint) {
    return prisma.userRole.create({ data: { userId, roleId, companyId } });
  }

  it('1. refuses to hard-delete a user while it still owns an assignment', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'u1@test.local');
    const role = await makeRoleIn(a.id, 'ADMIN');
    await assign(user.id, role.id, a.id);

    // Blocked at the DB level. The assignment row must survive (no cascade).
    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow();
    expect(await prisma.userRole.count({ where: { userId: user.id } })).toBe(1);
  });

  it('2. refuses to hard-delete a role while it still owns an assignment (FK RESTRICT)', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'u2@test.local');
    const role = await makeRoleIn(a.id, 'ADMIN');
    await assign(user.id, role.id, a.id);

    // No no_delete trigger on roles: the composite FK RESTRICT is what rejects it.
    await expect(prisma.role.delete({ where: { id: role.id } })).rejects.toThrow();
    expect(await prisma.userRole.count({ where: { roleId: role.id } })).toBe(1);
    // The role row itself is untouched.
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBeNull();
  });

  it('3. once the assignment is removed, the role can be hard-deleted (RESTRICT, not CASCADE)', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'u3@test.local');
    const role = await makeRoleIn(a.id, 'ADMIN');
    await assign(user.id, role.id, a.id);

    // Remove the assignment explicitly first…
    await prisma.userRole.delete({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
    });
    // …now the role is no longer referenced and may be deleted.
    await expect(prisma.role.delete({ where: { id: role.id } })).resolves.toBeDefined();
    expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
  });

  it('4. a user hard delete stays blocked by the no_delete_users trigger even after assignment removal', async () => {
    const a = await makeCompany(prisma);
    const user = await makeUserIn(a.id, 'u4@test.local');
    const role = await makeRoleIn(a.id, 'ADMIN');
    await assign(user.id, role.id, a.id);

    await prisma.userRole.delete({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
    });
    // Users are soft-delete master data: the DB still forbids the hard delete via
    // the no_delete_users trigger (deactivate via deleted_at instead). The FK no
    // longer cascades, so the assignment removal above was a real, explicit act.
    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow(
      /delete_forbidden/,
    );
  });

  it('5. cross-company assignment is still rejected by the composite FK', async () => {
    const a = await makeCompany(prisma);
    const b = await makeCompany(prisma);
    const userA = await makeUserIn(a.id, 'u5@test.local');
    const roleB = await makeRoleIn(b.id, 'ADMIN');
    // (role_id, company_id) = (roleB, A) has no matching roles(id, company_id):
    // changing only the ON DELETE action preserves the tenant guarantee.
    await expect(assign(userA.id, roleB.id, a.id)).rejects.toThrow();
  });

  it('6. a same-company assignment is still accepted', async () => {
    const a = await makeCompany(prisma);
    const userA = await makeUserIn(a.id, 'u6@test.local');
    const roleA = await makeRoleIn(a.id, 'ADMIN');
    const assignment = await assign(userA.id, roleA.id, a.id);
    expect(assignment.companyId).toBe(a.id);
  });
});
