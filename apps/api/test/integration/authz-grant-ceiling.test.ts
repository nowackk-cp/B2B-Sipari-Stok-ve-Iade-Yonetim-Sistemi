import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCompanyRbac } from '@b2b/database';
import type { GrantDecision } from '@b2b/domain';
import { AuthorizationGrantService } from '../../src/modules/authorization/authorization-grant.service';
import { TestAuthzModule } from '../support/test-authz.module';
import {
  ROLES,
  type TestApp,
  closeTestApp,
  createCompany,
  createTestApp,
  createUser,
  resetState,
  seedRbac,
} from './helpers';

/**
 * Grant-ceiling foundation (SECURITY_MODEL §2a/§2b, PERMISSION_MATRIX §4) —
 * integration tests against REAL PostgreSQL. They exercise the DB-backed
 * {@link AuthorizationGrantService}: the actor's company, effective permissions
 * and privilege level are resolved from PostgreSQL (never a JWT claim), so every
 * decision below is the policy operating on live tenant data.
 */

let roleSeq = 0;

/** Create a role in `companyId` with the given grants/privilege/protection. */
async function createRole(
  ctx: TestApp,
  companyId: bigint,
  opts: { perms?: string[]; privilegeLevel?: number; isProtected?: boolean } = {},
): Promise<bigint> {
  roleSeq += 1;
  const role = await ctx.prisma.role.create({
    data: {
      companyId,
      name: `GC_ROLE_${Date.now().toString(36)}_${roleSeq}`,
      privilegeLevel: opts.privilegeLevel ?? 10,
      isProtected: opts.isProtected ?? false,
    },
  });
  if (opts.perms?.length) {
    const perms = await ctx.prisma.permission.findMany({
      where: { code: { in: opts.perms } },
      select: { id: true },
    });
    await ctx.prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }
  return role.id;
}

/** Create an actor user holding exactly `perms` through one role at `privilegeLevel`. */
async function makeActor(
  ctx: TestApp,
  opts: { companyId?: bigint; perms: string[]; privilegeLevel: number },
): Promise<{ userId: bigint; companyId: bigint; roleId: bigint }> {
  const user = await createUser(ctx.prisma, { companyId: opts.companyId });
  const roleId = await createRole(ctx, user.companyId, {
    perms: opts.perms,
    privilegeLevel: opts.privilegeLevel,
  });
  await ctx.prisma.userRole.create({
    data: { userId: user.id, roleId, companyId: user.companyId },
  });
  return { userId: user.id, companyId: user.companyId, roleId };
}

async function permId(ctx: TestApp, code: string): Promise<bigint> {
  const p = await ctx.prisma.permission.findUniqueOrThrow({ where: { code } });
  return p.id;
}

async function seededRoleId(ctx: TestApp, companyId: bigint, name: string): Promise<bigint> {
  const r = await ctx.prisma.role.findUniqueOrThrow({
    where: { companyId_name: { companyId, name } },
  });
  return r.id;
}

async function makeCompanyB(ctx: TestApp): Promise<bigint> {
  const companyB = await createCompany(ctx.prisma, 'Company B');
  await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, companyB));
  return companyB;
}

function denied(decision: GrantDecision, reason: string): void {
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.reason).toBe(reason);
}

describe('RBAC grant ceiling (integration, real PostgreSQL)', () => {
  let ctx: TestApp;
  let svc: AuthorizationGrantService;
  let companyA: bigint;

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [TestAuthzModule] });
    svc = ctx.app.get(AuthorizationGrantService);
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
    await seedRbac(ctx.prisma);
    companyA = (await ctx.prisma.company.findFirstOrThrow({ where: { name: 'Default Company' } }))
      .id;
  });

  it('1. actor can add a permission they hold to a role', async () => {
    const actor = await makeActor(ctx, {
      perms: ['role:manage', 'product:read'],
      privilegeLevel: 50,
    });
    const roleId = await createRole(ctx, companyA, { privilegeLevel: 10 });
    const decision = await svc.canAddPermissionToRole(
      actor.userId,
      roleId,
      await permId(ctx, 'product:read'),
    );
    expect(decision).toEqual({ allowed: true });
  });

  it('2. actor cannot add a permission they do NOT hold to a role (ceiling)', async () => {
    const actor = await makeActor(ctx, {
      perms: ['role:manage', 'product:read'],
      privilegeLevel: 50,
    });
    const roleId = await createRole(ctx, companyA, { privilegeLevel: 10 });
    const decision = await svc.canAddPermissionToRole(
      actor.userId,
      roleId,
      await permId(ctx, 'order:read'),
    );
    denied(decision, 'CEILING_EXCEEDED');
  });

  it('3. actor can assign a role built from permissions they hold', async () => {
    const actor = await makeActor(ctx, {
      perms: ['user:assign-role', 'product:read', 'order:read'],
      privilegeLevel: 50,
    });
    const target = await createUser(ctx.prisma, { companyId: companyA });
    const roleId = await createRole(ctx, companyA, { perms: ['product:read'], privilegeLevel: 10 });
    const decision = await svc.canAssignRoleToUser(actor.userId, target.id, roleId);
    expect(decision).toEqual({ allowed: true });
  });

  it('4. actor cannot assign a role containing a permission they lack (ceiling)', async () => {
    const actor = await makeActor(ctx, {
      perms: ['user:assign-role', 'product:read'],
      privilegeLevel: 50,
    });
    const target = await createUser(ctx.prisma, { companyId: companyA });
    const roleId = await createRole(ctx, companyA, {
      perms: ['product:read', 'order:read'],
      privilegeLevel: 10,
    });
    denied(await svc.canAssignRoleToUser(actor.userId, target.id, roleId), 'CEILING_EXCEEDED');
  });

  it('5. actor cannot assign a role to a user in another company', async () => {
    const companyB = await makeCompanyB(ctx);
    const actor = await makeActor(ctx, {
      perms: ['user:assign-role', 'product:read'],
      privilegeLevel: 50,
    });
    const targetB = await createUser(ctx.prisma, { companyId: companyB });
    const roleId = await createRole(ctx, companyA, { perms: ['product:read'], privilegeLevel: 10 });
    denied(await svc.canAssignRoleToUser(actor.userId, targetB.id, roleId), 'CROSS_TENANT');
  });

  it("6. actor cannot assign another company's role", async () => {
    const companyB = await makeCompanyB(ctx);
    const actor = await makeActor(ctx, {
      perms: ['user:assign-role', 'product:read'],
      privilegeLevel: 50,
    });
    const targetA = await createUser(ctx.prisma, { companyId: companyA });
    const roleB = await createRole(ctx, companyB, { perms: ['product:read'], privilegeLevel: 10 });
    denied(await svc.canAssignRoleToUser(actor.userId, targetA.id, roleB), 'CROSS_TENANT');
  });

  it('7. a SYSTEM_ADMIN cannot grant into another company', async () => {
    const companyB = await makeCompanyB(ctx);
    const sysAdmin = await createUser(ctx.prisma, { companyId: companyA });
    await ctx.prisma.userRole.create({
      data: {
        userId: sysAdmin.id,
        roleId: await seededRoleId(ctx, companyA, ROLES.SYSTEM_ADMIN),
        companyId: companyA,
      },
    });
    const targetB = await createUser(ctx.prisma, { companyId: companyB });
    const roleB = await seededRoleId(ctx, companyB, ROLES.VIEWER);
    denied(await svc.canAssignRoleToUser(sysAdmin.id, targetB.id, roleB), 'CROSS_TENANT');
  });

  it('8. a protected role cannot be assigned without role:manage:protected', async () => {
    // ADMIN holds user:assign-role but NOT the protected-grant permission.
    const admin = await createUser(ctx.prisma, { companyId: companyA });
    await ctx.prisma.userRole.create({
      data: {
        userId: admin.id,
        roleId: await seededRoleId(ctx, companyA, ROLES.ADMIN),
        companyId: companyA,
      },
    });
    const target = await createUser(ctx.prisma, { companyId: companyA });
    const protectedRole = await seededRoleId(ctx, companyA, ROLES.SYSTEM_ADMIN);
    denied(
      await svc.canAssignRoleToUser(admin.id, target.id, protectedRole),
      'PROTECTED_GRANT_REQUIRED',
    );
  });

  it('9. a protected role is denied above the actor ceiling even WITH role:manage:protected', async () => {
    // Actor has the protected-grant permission and matching privilege, but lacks
    // one permission the protected target role confers → ceiling stops them.
    const actor = await makeActor(ctx, {
      perms: ['user:assign-role', 'role:manage:protected'],
      privilegeLevel: 100,
    });
    const target = await createUser(ctx.prisma, { companyId: companyA });
    const protectedRole = await createRole(ctx, companyA, {
      perms: ['role:manage:protected', 'system:read'],
      privilegeLevel: 100,
      isProtected: true,
    });
    denied(
      await svc.canAssignRoleToUser(actor.userId, target.id, protectedRole),
      'CEILING_EXCEEDED',
    );
  });

  it('10. actor cannot give themselves a higher role', async () => {
    const admin = await createUser(ctx.prisma, { companyId: companyA });
    await ctx.prisma.userRole.create({
      data: {
        userId: admin.id,
        roleId: await seededRoleId(ctx, companyA, ROLES.ADMIN),
        companyId: companyA,
      },
    });
    // ADMIN assigning the protected SYSTEM_ADMIN role to itself.
    const protectedRole = await seededRoleId(ctx, companyA, ROLES.SYSTEM_ADMIN);
    denied(
      await svc.canAssignRoleToUser(admin.id, admin.id, protectedRole),
      'PROTECTED_GRANT_REQUIRED',
    );
  });

  it('11. actor cannot add a permission they lack to their OWN role', async () => {
    const actor = await makeActor(ctx, {
      perms: ['role:manage', 'product:read'],
      privilegeLevel: 50,
    });
    // Editing the actor's own role to add a permission they do not hold.
    denied(
      await svc.canAddPermissionToRole(actor.userId, actor.roleId, await permId(ctx, 'order:read')),
      'CEILING_EXCEEDED',
    );
  });

  it('12. removing a permission cannot escalate (ADMIN cannot strip a protected role)', async () => {
    const admin = await createUser(ctx.prisma, { companyId: companyA });
    await ctx.prisma.userRole.create({
      data: {
        userId: admin.id,
        roleId: await seededRoleId(ctx, companyA, ROLES.ADMIN),
        companyId: companyA,
      },
    });
    const protectedRole = await seededRoleId(ctx, companyA, ROLES.SYSTEM_ADMIN);
    denied(
      await svc.canRemovePermissionFromRole(
        admin.id,
        protectedRole,
        await permId(ctx, 'system:read'),
      ),
      'PROTECTED_GRANT_REQUIRED',
    );
  });

  it('13. a deleted role cannot be assigned', async () => {
    const actor = await makeActor(ctx, {
      perms: ['user:assign-role', 'product:read'],
      privilegeLevel: 50,
    });
    const target = await createUser(ctx.prisma, { companyId: companyA });
    const roleId = await createRole(ctx, companyA, { perms: ['product:read'], privilegeLevel: 10 });
    await ctx.prisma.role.delete({ where: { id: roleId } }); // no assignments → deletable
    denied(
      await svc.canAssignRoleToUser(actor.userId, target.id, roleId),
      'TARGET_ROLE_UNRESOLVED',
    );
  });

  it('14. an inactive/deleted user cannot be a target', async () => {
    const actor = await makeActor(ctx, {
      perms: ['user:assign-role', 'product:read'],
      privilegeLevel: 50,
    });
    const suspended = await createUser(ctx.prisma, { companyId: companyA, status: 'SUSPENDED' });
    const roleId = await createRole(ctx, companyA, { perms: ['product:read'], privilegeLevel: 10 });
    denied(
      await svc.canAssignRoleToUser(actor.userId, suspended.id, roleId),
      'TARGET_USER_UNRESOLVED',
    );

    const deleted = await createUser(ctx.prisma, { companyId: companyA });
    await ctx.prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    denied(
      await svc.canAssignRoleToUser(actor.userId, deleted.id, roleId),
      'TARGET_USER_UNRESOLVED',
    );
  });

  it('15. an inactive/deleted actor is denied (deny-by-default)', async () => {
    const actor = await makeActor(ctx, {
      perms: ['user:assign-role', 'product:read'],
      privilegeLevel: 50,
    });
    await ctx.prisma.user.update({ where: { id: actor.userId }, data: { status: 'SUSPENDED' } });
    const target = await createUser(ctx.prisma, { companyId: companyA });
    const roleId = await createRole(ctx, companyA, { perms: ['product:read'], privilegeLevel: 10 });
    denied(await svc.canAssignRoleToUser(actor.userId, target.id, roleId), 'ACTOR_UNRESOLVED');
  });

  it('16. a SYSTEM_ADMIN CAN assign a protected role within their own company', async () => {
    const sysAdmin = await createUser(ctx.prisma, { companyId: companyA });
    await ctx.prisma.userRole.create({
      data: {
        userId: sysAdmin.id,
        roleId: await seededRoleId(ctx, companyA, ROLES.SYSTEM_ADMIN),
        companyId: companyA,
      },
    });
    const target = await createUser(ctx.prisma, { companyId: companyA });
    const protectedRole = await seededRoleId(ctx, companyA, ROLES.SYSTEM_ADMIN);
    expect(await svc.canAssignRoleToUser(sysAdmin.id, target.id, protectedRole)).toEqual({
      allowed: true,
    });
  });
});
