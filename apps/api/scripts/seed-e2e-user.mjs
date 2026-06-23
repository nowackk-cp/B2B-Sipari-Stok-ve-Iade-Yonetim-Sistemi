#!/usr/bin/env node
// Seed a deterministic user for the web E2E suite.
//
// Lives in the API package (which legitimately depends on the database + the
// password hasher); the web E2E global-setup invokes it as a child process so
// the frontend package never imports the database (boundary rule).
//
// Self-contained + idempotent. It first runs the canonical system seed (the SAME
// idempotent, production-safe `seed()` used by `db:seed`) so the permission
// catalog, the default company, that company's system roles, the default
// warehouse and the invoice series are guaranteed to exist, then attaches the
// E2E user to that company with a real role + warehouse scope so every screen
// loads. Re-running never duplicates rows and never resets an unrelated user's
// password. A hard guard refuses any database whose name does not contain
// "test", so it can never touch a real/demo database.
//
// All identity comes from the environment (test-only defaults below); no real
// secret is committed. The plaintext password is used only at runtime to derive
// an argon2id hash — the DB only ever stores the hash.
import { randomBytes } from 'node:crypto';
import { PrismaClient, seed } from '@b2b/database';
import { argon2id } from 'hash-wasm';

const EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@test.local';
// Test-only default; NEVER a real secret. Overridable via E2E_USER_PASSWORD.
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'e2e correct horse staple';
const FULL_NAME = process.env.E2E_USER_NAME ?? 'E2E User';
const WAREHOUSE_CODE = process.env.E2E_WAREHOUSE_CODE ?? 'MAIN';

// The system seed creates exactly this tenant + its SYSTEM_ADMIN role.
const DEFAULT_COMPANY_NAME = 'Default Company';
const SYSTEM_ADMIN = 'SYSTEM_ADMIN';

async function main() {
  const dbName = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to seed E2E user into non-test database "${dbName}".`);
  }
  const prisma = new PrismaClient();
  try {
    // 1. Canonical, idempotent system seed: permission catalog + default company
    //    + that company's system roles + default warehouse + invoice series. This
    //    is what makes the script work on a freshly migrated (empty) test DB.
    await seed(prisma);

    // 2. The tenant every E2E fixture lives in (created/ensured by the seed).
    const company = await prisma.company.findFirst({
      where: { name: DEFAULT_COMPANY_NAME },
      select: { id: true },
    });
    if (!company) {
      throw new Error(`Default company "${DEFAULT_COMPANY_NAME}" missing after seed.`);
    }

    const passwordHash = await argon2id({
      password: PASSWORD.normalize('NFKC'),
      salt: randomBytes(16),
      memorySize: 8192,
      iterations: 2,
      parallelism: 1,
      hashLength: 32,
      outputType: 'encoded',
    });

    // 3. The E2E user — pinned to a company (User.companyId is mandatory under
    //    company-scoping; omitting it was the harness bug). find-then-write avoids
    //    ON CONFLICT against the citext unique email index. An existing user keeps
    //    its own id AND company — we never move a user across tenants.
    const existing = await prisma.user.findUnique({
      where: { email: EMAIL },
      select: { id: true, companyId: true },
    });
    let userId;
    let companyId;
    if (existing) {
      userId = existing.id;
      companyId = existing.companyId;
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          status: 'ACTIVE',
          deletedAt: null,
          lockedUntil: null,
          failedLoginCount: 0,
        },
      });
    } else {
      companyId = company.id;
      const created = await prisma.user.create({
        data: {
          companyId,
          email: EMAIL,
          passwordHash,
          fullName: FULL_NAME,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      userId = created.id;
    }

    // 4. Same-tenant SYSTEM_ADMIN assignment (company-scoped). The composite FKs
    //    on user_roles force user.company_id = role.company_id, so the role is
    //    resolved within the user's OWN company. A user can never gain another
    //    company's permissions. (A user-role insert bumps the company authz
    //    version via DB trigger; nothing to maintain here.)
    const adminRole = await prisma.role.findUnique({
      where: { companyId_name: { companyId, name: SYSTEM_ADMIN } },
      select: { id: true },
    });
    if (adminRole) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId: adminRole.id } },
        update: {},
        create: { userId, roleId: adminRole.id, companyId },
      });
    }

    // 5. Explicit warehouse scope on the demo warehouse (same tenant). SYSTEM_ADMIN
    //    already holds the protected `warehouse:scope:all` permission, but an
    //    explicit row makes warehouse-scoped screens deterministic and exercises
    //    the real grant path. Skipped if the warehouse is absent.
    const warehouse = await prisma.warehouse.findFirst({
      where: { code: WAREHOUSE_CODE, companyId, deletedAt: null },
      select: { id: true },
    });
    if (warehouse) {
      await prisma.userWarehouseScope.upsert({
        where: { userId_warehouseId: { userId, warehouseId: warehouse.id } },
        update: {},
        create: { userId, warehouseId: warehouse.id, companyId },
      });
    }

    console.log(`E2E user ready: ${EMAIL} (company ${companyId})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to seed E2E user', err);
  process.exit(1);
});
