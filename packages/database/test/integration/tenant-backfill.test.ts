import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabase } from '../../src/testing';
import { createPrisma } from './helpers';

/**
 * Migration backfill fail-closed behaviour for
 * `20260616000000_rbac_company_tenant_scope` (RBAC-TI-001).
 *
 * The migration adds `company_id` to users/roles/user_roles and backfills the
 * tenant for any pre-existing (legacy) RBAC rows. The hard requirement: the
 * backfill must NEVER silently guess a tenant. It may only proceed when the
 * mapping is unambiguous — exactly one company exists. Zero or multiple
 * companies must abort with a clear, testable `TENANT_BACKFILL_AMBIGUOUS`.
 *
 * These tests run the EXACT committed backfill `DO $$ … $$` block (extracted
 * from the migration file, not re-typed) against synthetic legacy tables in a
 * disposable schema, on the real PostgreSQL test database. The synthetic tables
 * mirror the shape the migration's step 1 produces (company_id added, NULLable),
 * so the block operates exactly as it does mid-migration.
 */

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260616000000_rbac_company_tenant_scope',
    'migration.sql',
  ),
  'utf8',
);

/** The single backfill DO block, lifted verbatim from the committed migration. */
const BACKFILL_DO_BLOCK = (() => {
  const match = MIGRATION_SQL.match(/DO \$\$[\s\S]*?\nEND \$\$;/);
  if (!match) throw new Error('could not locate the backfill DO block in migration.sql');
  return match[0];
})();

/** The backfill block with `--` comments stripped, so source-pattern guards
 *  inspect executable SQL rather than explanatory prose. */
const BACKFILL_CODE = BACKFILL_DO_BLOCK.replace(/--[^\n]*/g, '');

interface LegacyFixture {
  companyIds?: bigint[];
  users?: Array<{ id: bigint; companyId?: bigint | null }>;
  roles?: Array<{ id: bigint; companyId?: bigint | null }>;
  userRoles?: Array<{ userId: bigint; roleId: bigint; companyId?: bigint | null }>;
}

interface BackfillResult {
  users: Array<{ id: bigint; company_id: bigint | null }>;
  roles: Array<{ id: bigint; company_id: bigint | null }>;
  userRoles: Array<{ user_id: bigint; role_id: bigint; company_id: bigint | null }>;
}

describe('RBAC tenant backfill — fail-closed (real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let schemaCounter = 0;

  beforeAll(() => {
    assertSafeTestDatabase();
    prisma = createPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  // Defensive: drop any probe schema that a committed (success-path) run created
  // and somehow left behind, so the shared test DB never accumulates residue.
  afterEach(async () => {
    const leftover = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT nspname FROM pg_namespace WHERE nspname LIKE 'backfill_probe_%'
    `;
    for (const { nspname } of leftover) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
    }
  });

  /**
   * Stand up synthetic legacy tables in a throwaway schema, insert the fixture,
   * then run the real backfill block. On success returns the resulting rows; on
   * a RAISEd backfill failure the interactive transaction aborts (rolling back
   * the schema entirely) and the promise rejects with the PostgreSQL message.
   */
  async function runBackfill(fixture: LegacyFixture): Promise<BackfillResult> {
    schemaCounter += 1;
    const schema = `backfill_probe_${process.pid}_${schemaCounter}`;
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        // Resolve unqualified names to the probe schema ONLY (pg_catalog is always
        // implicitly searched). A stray reference to a real table errors loudly
        // instead of ever touching production data.
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);

        await tx.$executeRawUnsafe('CREATE TABLE companies (id BIGINT PRIMARY KEY)');
        await tx.$executeRawUnsafe('CREATE TABLE users (id BIGINT PRIMARY KEY, company_id BIGINT)');
        await tx.$executeRawUnsafe('CREATE TABLE roles (id BIGINT PRIMARY KEY, company_id BIGINT)');
        await tx.$executeRawUnsafe(
          'CREATE TABLE user_roles (user_id BIGINT, role_id BIGINT, company_id BIGINT)',
        );

        for (const id of fixture.companyIds ?? []) {
          await tx.$executeRawUnsafe('INSERT INTO companies (id) VALUES ($1)', id);
        }
        for (const u of fixture.users ?? []) {
          await tx.$executeRawUnsafe(
            'INSERT INTO users (id, company_id) VALUES ($1, $2)',
            u.id,
            u.companyId ?? null,
          );
        }
        for (const r of fixture.roles ?? []) {
          await tx.$executeRawUnsafe(
            'INSERT INTO roles (id, company_id) VALUES ($1, $2)',
            r.id,
            r.companyId ?? null,
          );
        }
        for (const ur of fixture.userRoles ?? []) {
          await tx.$executeRawUnsafe(
            'INSERT INTO user_roles (user_id, role_id, company_id) VALUES ($1, $2, $3)',
            ur.userId,
            ur.roleId,
            ur.companyId ?? null,
          );
        }

        // Run the committed backfill verbatim.
        await tx.$executeRawUnsafe(BACKFILL_DO_BLOCK);

        const users = await tx.$queryRawUnsafe<BackfillResult['users']>(
          'SELECT id, company_id FROM users ORDER BY id',
        );
        const roles = await tx.$queryRawUnsafe<BackfillResult['roles']>(
          'SELECT id, company_id FROM roles ORDER BY id',
        );
        const userRoles = await tx.$queryRawUnsafe<BackfillResult['userRoles']>(
          'SELECT user_id, role_id, company_id FROM user_roles ORDER BY user_id, role_id',
        );

        // Success path commits; drop the schema so nothing persists.
        await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        return { users, roles, userRoles };
      },
      { timeout: 30_000 },
    );
  }

  it('1+2. empty RBAC data with no company succeeds (nothing to backfill)', async () => {
    const result = await runBackfill({});
    expect(result.users).toHaveLength(0);
    expect(result.roles).toHaveLength(0);
    expect(result.userRoles).toHaveLength(0);
  });

  it('3. legacy users/roles/user_roles + exactly one company → all assigned to it', async () => {
    const result = await runBackfill({
      companyIds: [7n],
      users: [{ id: 1n }, { id: 2n }],
      roles: [{ id: 10n }, { id: 11n }],
      userRoles: [
        { userId: 1n, roleId: 10n },
        { userId: 2n, roleId: 11n },
      ],
    });
    expect(result.users.map((u) => u.company_id)).toEqual([7n, 7n]);
    expect(result.roles.map((r) => r.company_id)).toEqual([7n, 7n]);
    expect(result.userRoles.map((ur) => ur.company_id)).toEqual([7n, 7n]);
  });

  it('4. legacy data + zero companies → fails TENANT_BACKFILL_AMBIGUOUS', async () => {
    await expect(runBackfill({ users: [{ id: 1n }], roles: [{ id: 10n }] })).rejects.toThrow(
      /TENANT_BACKFILL_AMBIGUOUS/,
    );
  });

  it('5. legacy data + two companies → fails TENANT_BACKFILL_AMBIGUOUS', async () => {
    await expect(
      runBackfill({
        companyIds: [1n, 2n],
        users: [{ id: 1n }],
        roles: [{ id: 10n }],
        userRoles: [{ userId: 1n, roleId: 10n }],
      }),
    ).rejects.toThrow(/TENANT_BACKFILL_AMBIGUOUS/);
  });

  it('6a. multi-company legacy fails before assigning any tenant (no lowest/default guess)', async () => {
    // Two companies (1 and 2) plus legacy users/roles. A silent "lowest company"
    // backfill would have mapped everyone to company 1; instead it must abort.
    await expect(
      runBackfill({
        companyIds: [1n, 2n],
        users: [{ id: 100n }, { id: 200n }],
        roles: [{ id: 10n }],
        userRoles: [
          { userId: 100n, roleId: 10n },
          { userId: 200n, roleId: 10n },
        ],
      }),
    ).rejects.toThrow(/TENANT_BACKFILL_AMBIGUOUS/);
  });

  it('6b. the migration backfill performs no silent tenant selection', () => {
    // Guard the executable SQL (comments stripped) against the forbidden
    // silent-selection idioms: no "lowest/first" pick, no aggregate guess, and
    // no inventing a default tenant.
    expect(BACKFILL_CODE).not.toMatch(/order\s+by/i);
    expect(BACKFILL_CODE).not.toMatch(/\blimit\b/i);
    expect(BACKFILL_CODE).not.toMatch(/\bmin\s*\(/i);
    expect(BACKFILL_CODE).not.toMatch(/default company/i);
    expect(BACKFILL_CODE).not.toMatch(/insert\s+into\s+companies/i);
  });

  it('7. a role assignable across companies is never split silently → fails', async () => {
    // role 10 is assigned to users that would land in different tenants; with
    // more than one company present the migration refuses rather than guessing.
    await expect(
      runBackfill({
        companyIds: [1n, 2n],
        users: [{ id: 100n }, { id: 200n }],
        roles: [{ id: 10n }],
        userRoles: [
          { userId: 100n, roleId: 10n },
          { userId: 200n, roleId: 10n },
        ],
      }),
    ).rejects.toThrow(/TENANT_BACKFILL_AMBIGUOUS/);
  });

  it('8a. user_roles spanning multiple tenants → fails TENANT_BACKFILL_AMBIGUOUS', async () => {
    await expect(
      runBackfill({
        companyIds: [1n, 2n],
        users: [{ id: 100n }, { id: 200n }],
        roles: [{ id: 10n }, { id: 20n }],
        userRoles: [
          { userId: 100n, roleId: 10n },
          { userId: 200n, roleId: 20n },
        ],
      }),
    ).rejects.toThrow(/TENANT_BACKFILL_AMBIGUOUS/);
  });

  it('8b. defensive: an assignment disagreeing with its role company → TENANT_BACKFILL_MISMATCH', async () => {
    // Single company (1), but a role is already pinned to a different company so
    // the user_role assignment cannot agree with it. This exercises the final
    // defensive assertion guarding the composite FKs.
    await expect(
      runBackfill({
        companyIds: [1n],
        users: [{ id: 100n }],
        roles: [{ id: 10n, companyId: 999n }],
        userRoles: [{ userId: 100n, roleId: 10n }],
      }),
    ).rejects.toThrow(/TENANT_BACKFILL_MISMATCH/);
  });

  it('9. the ambiguous failure names the company count for operators', async () => {
    await expect(runBackfill({ companyIds: [1n, 2n, 3n], users: [{ id: 1n }] })).rejects.toThrow(
      /TENANT_BACKFILL_AMBIGUOUS: 3 companies/,
    );
  });
});
