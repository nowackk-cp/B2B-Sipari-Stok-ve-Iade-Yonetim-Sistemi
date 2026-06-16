import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCompanyRbac } from '@b2b/database';
import { WAREHOUSE_SCOPE_ALL } from '@b2b/domain';
import { WarehouseScopeService } from '../../src/modules/authorization/warehouse-scope.service';
import {
  ROLES,
  type TestApp,
  assignRole,
  assignWarehouseScope,
  closeTestApp,
  createCompany,
  createTestApp,
  createUser,
  createWarehouse,
  ensureDefaultCompany,
  grantPermissionsViaRole,
  resetState,
  seedRbac,
} from './helpers';

/**
 * WarehouseScopeService against real PostgreSQL (TASK-010c / SECURITY_MODEL §3).
 *
 * The service resolves the actor's REAL company, effective permissions, explicit
 * warehouse grants and the target warehouse strictly from PostgreSQL, then defers
 * to the pure WarehouseScopePolicy. There is no HTTP surface (no endpoint is added
 * in this task), so — as with the tenant-isolation suite's repository checks — the
 * service is exercised directly. Because its only actor input is a userId resolved
 * against the DB, no JWT/company/warehouse claim can ever influence the decision.
 */
describe('WarehouseScopeService (integration, real PostgreSQL)', () => {
  let ctx: TestApp;
  let service: WarehouseScopeService;

  beforeAll(async () => {
    ctx = await createTestApp();
    service = ctx.app.get(WarehouseScopeService);
  });
  afterAll(async () => {
    await closeTestApp(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
    await seedRbac(ctx.prisma); // Company A = the default seeded company.
  });

  async function companyA(): Promise<bigint> {
    return ensureDefaultCompany(ctx.prisma);
  }

  async function makeCompanyB(): Promise<bigint> {
    const companyB = await createCompany(ctx.prisma, 'Company B');
    await ctx.prisma.$transaction((tx) => seedCompanyRbac(tx, companyB));
    return companyB;
  }

  it('1. base permission but NO warehouse scope → deny', async () => {
    const a = await companyA();
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read']);
    const wh = await createWarehouse(ctx.prisma, a);

    const d = await service.canAccessWarehouseForPermission(user.id, wh.id, 'stock:read');
    expect(d).toEqual({ allowed: false, reason: 'OUT_OF_SCOPE' });
  });

  it('2. base permission + explicit scope for that warehouse → allow', async () => {
    const a = await companyA();
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read']);
    const wh = await createWarehouse(ctx.prisma, a);
    await assignWarehouseScope(ctx.prisma, user.id, wh.id, a);

    const d = await service.canAccessWarehouseForPermission(user.id, wh.id, 'stock:read');
    expect(d).toEqual({ allowed: true });
  });

  it('3. base permission + scope for a DIFFERENT warehouse → deny', async () => {
    const a = await companyA();
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read']);
    const scoped = await createWarehouse(ctx.prisma, a);
    const other = await createWarehouse(ctx.prisma, a);
    await assignWarehouseScope(ctx.prisma, user.id, scoped.id, a);

    const d = await service.canAccessWarehouseForPermission(user.id, other.id, 'stock:read');
    expect(d).toEqual({ allowed: false, reason: 'OUT_OF_SCOPE' });
  });

  it('4. warehouse:scope:all → allow every warehouse in the SAME company', async () => {
    const a = await companyA();
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read', WAREHOUSE_SCOPE_ALL]);
    const wh1 = await createWarehouse(ctx.prisma, a);
    const wh2 = await createWarehouse(ctx.prisma, a); // no explicit scope on either

    expect(await service.canAccessWarehouseForPermission(user.id, wh1.id, 'stock:read')).toEqual({
      allowed: true,
    });
    expect(await service.canAccessWarehouseForPermission(user.id, wh2.id, 'stock:read')).toEqual({
      allowed: true,
    });
  });

  it('5. warehouse:scope:all does NOT reach another company’s warehouse → deny', async () => {
    const a = await companyA();
    const b = await makeCompanyB();
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read', WAREHOUSE_SCOPE_ALL]);
    const whB = await createWarehouse(ctx.prisma, b);

    const d = await service.canAccessWarehouseForPermission(user.id, whB.id, 'stock:read');
    expect(d).toEqual({ allowed: false, reason: 'CROSS_TENANT' });
  });

  it('6. the ADMIN role name alone grants NO warehouse access', async () => {
    const a = await companyA();
    const admin = await createUser(ctx.prisma, { companyId: a });
    await assignRole(ctx.prisma, admin.id, ROLES.ADMIN); // ADMIN holds stock:read but NO scope
    const wh = await createWarehouse(ctx.prisma, a);

    // ADMIN is not protected and is not granted warehouse:scope:all, and has no
    // explicit scope row → deny (no role-based implicit scope).
    const d = await service.canAccessWarehouseForPermission(admin.id, wh.id, 'stock:read');
    expect(d).toEqual({ allowed: false, reason: 'OUT_OF_SCOPE' });
  });

  it('7. a Company A SYSTEM_ADMIN gets NO access to a Company B warehouse', async () => {
    const a = await companyA();
    const b = await makeCompanyB();
    const sysAdminA = await createUser(ctx.prisma, { companyId: a });
    await assignRole(ctx.prisma, sysAdminA.id, ROLES.SYSTEM_ADMIN); // holds scope:all in A
    const whB = await createWarehouse(ctx.prisma, b);

    const d = await service.canAccessWarehouseForPermission(sysAdminA.id, whB.id, 'stock:read');
    expect(d).toEqual({ allowed: false, reason: 'CROSS_TENANT' });
  });

  it('8. seeded SYSTEM_ADMIN reaches every warehouse in its OWN company via scope:all', async () => {
    const a = await companyA();
    const sysAdmin = await createUser(ctx.prisma, { companyId: a });
    await assignRole(ctx.prisma, sysAdmin.id, ROLES.SYSTEM_ADMIN);
    const wh = await createWarehouse(ctx.prisma, a); // no explicit grant

    expect(await service.canAccessWarehouseForPermission(sysAdmin.id, wh.id, 'stock:read')).toEqual(
      { allowed: true },
    );
    expect(await service.hasGlobalWarehouseScope(sysAdmin.id)).toBe(true);
  });

  it('10. an inactive/soft-deleted actor is denied even with a valid scope', async () => {
    const a = await companyA();
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read']);
    const wh = await createWarehouse(ctx.prisma, a);
    await assignWarehouseScope(ctx.prisma, user.id, wh.id, a);

    await ctx.prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    expect(await service.canAccessWarehouseForPermission(user.id, wh.id, 'stock:read')).toEqual({
      allowed: false,
      reason: 'ACTOR_UNRESOLVED',
    });

    await ctx.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', deletedAt: new Date() },
    });
    expect(await service.canAccessWarehouseForPermission(user.id, wh.id, 'stock:read')).toEqual({
      allowed: false,
      reason: 'ACTOR_UNRESOLVED',
    });
  });

  it('11. an inactive/soft-deleted warehouse is denied even with a valid scope', async () => {
    const a = await companyA();
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read']);
    const wh = await createWarehouse(ctx.prisma, a);
    await assignWarehouseScope(ctx.prisma, user.id, wh.id, a);

    await ctx.prisma.warehouse.update({ where: { id: wh.id }, data: { isActive: false } });
    expect(await service.canAccessWarehouseForPermission(user.id, wh.id, 'stock:read')).toEqual({
      allowed: false,
      reason: 'WAREHOUSE_UNRESOLVED',
    });

    await ctx.prisma.warehouse.update({
      where: { id: wh.id },
      data: { isActive: true, deletedAt: new Date() },
    });
    expect(await service.canAccessWarehouseForPermission(user.id, wh.id, 'stock:read')).toEqual({
      allowed: false,
      reason: 'WAREHOUSE_UNRESOLVED',
    });
  });

  it('12. the decision is DB-sourced: the same userId only reaches its own company’s warehouse', async () => {
    // The service accepts only a userId; company/permissions/scope are all resolved
    // from PostgreSQL, so no forged JWT company/warehouse claim could change this.
    const a = await companyA();
    const b = await makeCompanyB();
    const user = await createUser(ctx.prisma, { companyId: a });
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read', WAREHOUSE_SCOPE_ALL]);
    const whA = await createWarehouse(ctx.prisma, a);
    const whB = await createWarehouse(ctx.prisma, b);

    expect(await service.canAccessWarehouseForPermission(user.id, whA.id, 'stock:read')).toEqual({
      allowed: true,
    });
    // Their real company is A; B's warehouse is unreachable regardless of any claim.
    expect(await service.canAccessWarehouseForPermission(user.id, whB.id, 'stock:read')).toEqual({
      allowed: false,
      reason: 'CROSS_TENANT',
    });
  });

  it('13. missing required permission denies before any scope check', async () => {
    const a = await companyA();
    const user = await createUser(ctx.prisma, { companyId: a });
    // Holds scope:all + an explicit grant but NOT stock:adjust.
    await grantPermissionsViaRole(ctx.prisma, user.id, ['stock:read', WAREHOUSE_SCOPE_ALL]);
    const wh = await createWarehouse(ctx.prisma, a);
    await assignWarehouseScope(ctx.prisma, user.id, wh.id, a);

    const d = await service.canAccessWarehouseForPermission(user.id, wh.id, 'stock:adjust');
    expect(d).toEqual({ allowed: false, reason: 'MISSING_PERMISSION' });
  });
});
