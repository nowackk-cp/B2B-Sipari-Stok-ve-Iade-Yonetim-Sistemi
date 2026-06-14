import { PrismaClient } from '@prisma/client';
import { createLogger } from '@b2b/logger';
import {
  PERMISSIONS,
  ROLE_DEFINITIONS,
  ROLE_PERMISSION_MATRIX,
  ROLES,
  type RoleName,
} from '@b2b/domain';

const logger = createLogger({
  service: 'db-seed',
  environment: process.env.NODE_ENV ?? 'development',
});

/** Non-sensitive summary of what the seed created/ensured. */
export interface SeedReport {
  permissions: number;
  roles: number;
  rolePermissions: number;
  companies: number;
  warehouses: number;
  invoiceSeries: number;
  /** Whether the env-gated bootstrap SYSTEM_ADMIN user was created this run. */
  bootstrapAdminCreated: boolean;
}

const DEFAULT_COMPANY_NAME = 'Default Company';
const DEFAULT_WAREHOUSE_CODE = 'MAIN';
const DEFAULT_SERIES_CODE = 'INV';

/**
 * Idempotent, production-safe system seed.
 *
 * Seeds the canonical permission catalog (with protected flags + groups), the
 * system roles, the role→permission matrix, a default company/warehouse and the
 * current fiscal-year invoice series. Re-running produces no duplicates and
 * never resets an existing user's password.
 *
 * NO role is granted implicit warehouse scope; the protected global permission
 * `warehouse:scope:all` is seeded onto SYSTEM_ADMIN only (via the matrix).
 *
 * A bootstrap SYSTEM_ADMIN user is created ONLY when both
 * `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD_HASH` are present. A
 * pre-computed hash is required so the seed never handles or logs a plaintext
 * secret and never embeds a hard-coded password.
 */
export async function seed(
  client: PrismaClient = new PrismaClient(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedReport> {
  const report = await client.$transaction(async (tx) => {
    // 1. Permissions (immutable reference data) — upsert by canonical code.
    for (const perm of PERMISSIONS) {
      await tx.permission.upsert({
        where: { code: perm.code },
        update: {
          module: perm.module,
          permissionGroup: perm.group,
          description: perm.description,
          isProtected: perm.protected,
        },
        create: {
          code: perm.code,
          module: perm.module,
          permissionGroup: perm.group,
          description: perm.description,
          isProtected: perm.protected,
        },
      });
    }

    // 2. Roles — upsert by name; protected/system flags are re-asserted.
    for (const role of ROLE_DEFINITIONS) {
      await tx.role.upsert({
        where: { name: role.name },
        update: {
          description: role.description,
          isSystem: role.isSystem,
          isProtected: role.isProtected,
          privilegeLevel: role.privilegeLevel,
        },
        create: {
          name: role.name,
          description: role.description,
          isSystem: role.isSystem,
          isProtected: role.isProtected,
          privilegeLevel: role.privilegeLevel,
        },
      });
    }

    // 3. Role → permission matrix (additive, idempotent).
    const allPermissions = await tx.permission.findMany({ select: { id: true, code: true } });
    const permIdByCode = new Map(allPermissions.map((p) => [p.code, p.id]));
    const allRoles = await tx.role.findMany({ select: { id: true, name: true } });
    const roleIdByName = new Map(allRoles.map((r) => [r.name, r.id]));

    let rolePermissionCount = 0;
    for (const roleName of Object.keys(ROLE_PERMISSION_MATRIX) as RoleName[]) {
      const roleId = roleIdByName.get(roleName);
      if (roleId === undefined) continue;
      for (const code of ROLE_PERMISSION_MATRIX[roleName]) {
        const permissionId = permIdByCode.get(code);
        if (permissionId === undefined) continue;
        await tx.rolePermission.upsert({
          where: { roleId_permissionId: { roleId, permissionId } },
          update: {},
          create: { roleId, permissionId },
        });
        rolePermissionCount += 1;
      }
    }

    // 4. Default company (tenant) — find-or-create.
    let company = await tx.company.findFirst({ where: { name: DEFAULT_COMPANY_NAME } });
    if (!company) {
      company = await tx.company.create({
        data: { name: DEFAULT_COMPANY_NAME, defaultCurrency: 'TRY' },
      });
    }

    // 5. Default warehouse — find-or-create (partial-unique code → manual).
    let warehouse = await tx.warehouse.findFirst({
      where: { code: DEFAULT_WAREHOUSE_CODE, deletedAt: null },
    });
    if (!warehouse) {
      warehouse = await tx.warehouse.create({
        data: { code: DEFAULT_WAREHOUSE_CODE, name: 'Main Warehouse', country: 'TR' },
      });
    }

    // 6. Current fiscal-year invoice series — idempotent by composite key.
    const fiscalYear = new Date().getUTCFullYear();
    await tx.invoiceSeries.upsert({
      where: {
        companyId_seriesCode_fiscalYear: {
          companyId: company.id,
          seriesCode: DEFAULT_SERIES_CODE,
          fiscalYear,
        },
      },
      update: {},
      create: {
        companyId: company.id,
        seriesCode: DEFAULT_SERIES_CODE,
        fiscalYear,
        prefix: `${DEFAULT_SERIES_CODE}-${fiscalYear}-`,
        nextNumber: 1,
      },
    });

    // 7. Optional bootstrap SYSTEM_ADMIN user (env-gated, no implicit scope).
    let bootstrapAdminCreated = false;
    const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim();
    const passwordHash = env.BOOTSTRAP_ADMIN_PASSWORD_HASH?.trim();
    if (email && passwordHash) {
      const existing = await tx.user.findUnique({ where: { email } });
      const systemAdminRole = roleIdByName.get(ROLES.SYSTEM_ADMIN);
      if (!existing) {
        const created = await tx.user.create({
          data: {
            email,
            // Pre-hashed (argon2id) value supplied out-of-band; never plaintext.
            passwordHash,
            fullName: env.BOOTSTRAP_ADMIN_NAME?.trim() || 'System Administrator',
            status: 'ACTIVE',
          },
        });
        if (systemAdminRole !== undefined) {
          await tx.userRole.upsert({
            where: { userId_roleId: { userId: created.id, roleId: systemAdminRole } },
            update: {},
            create: { userId: created.id, roleId: systemAdminRole },
          });
        }
        bootstrapAdminCreated = true;
      } else if (systemAdminRole !== undefined) {
        // Ensure role assignment but NEVER reset the existing password.
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: existing.id, roleId: systemAdminRole } },
          update: {},
          create: { userId: existing.id, roleId: systemAdminRole },
        });
      }
    }

    return {
      permissions: PERMISSIONS.length,
      roles: ROLE_DEFINITIONS.length,
      rolePermissions: rolePermissionCount,
      companies: 1,
      warehouses: 1,
      invoiceSeries: 1,
      bootstrapAdminCreated,
    } satisfies SeedReport;
  });

  logger.info(
    { ...report, bootstrapAdminConfigured: Boolean(env.BOOTSTRAP_ADMIN_EMAIL) },
    'Seed completed (idempotent).',
  );
  return report;
}

if (require.main === module) {
  const client = new PrismaClient();
  seed(client)
    .then(async () => {
      await client.$disconnect();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      await client.$disconnect();
      logger.error({ err }, 'Seed failed');
      process.exit(1);
    });
}
