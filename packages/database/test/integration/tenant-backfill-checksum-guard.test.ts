import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabase } from '../../src/testing';
import { createPrisma } from './helpers';

/**
 * Fail-closed checksum guard for the in-place tenant-backfill correction
 * (BACKFILL-001).
 *
 * `20260616000000_rbac_company_tenant_scope` was fixed IN PLACE: an earlier
 * UNSAFE version silently guessed a tenant for legacy RBAC rows. Prisma keys
 * applied migrations by NAME, so a database that already ran the unsafe SQL
 * records it as applied, never re-runs the corrected file, and `migrate deploy`
 * reports "No pending migrations" — the unsafe state survives undetected.
 *
 * `20260616010000_rbac_tenant_backfill_checksum_guard` is a NEW (therefore
 * always-pending) migration that reads Prisma's own `_prisma_migrations`
 * bookkeeping and aborts the deploy unless the recorded checksum of the
 * tenant-scope migration is the FIXED/safe one. It performs NO tenant
 * remediation (the correct mapping is unrecoverable) and makes NO schema change.
 *
 * These tests run the EXACT committed guard `DO $$ … $$` block (extracted from
 * the migration file, not re-typed) against a SYNTHETIC `_prisma_migrations`
 * table in a throwaway schema on the real PostgreSQL test database. The block
 * references `_prisma_migrations` UNQUALIFIED, so a probe-only `search_path`
 * resolves it to the synthetic table — never the real one in `public`.
 */

const GUARD_MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260616010000_rbac_tenant_backfill_checksum_guard',
    'migration.sql',
  ),
  'utf8',
);

const TENANT_SCOPE_MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260616000000_rbac_company_tenant_scope',
    'migration.sql',
  ),
  'utf8',
);

/** The single guard DO block, lifted verbatim from the committed migration. */
const GUARD_DO_BLOCK = (() => {
  const match = GUARD_MIGRATION_SQL.match(/DO \$\$[\s\S]*?\nEND \$\$;/);
  if (!match) throw new Error('could not locate the guard DO block in migration.sql');
  return match[0];
})();

/** The guard block with `--` comments stripped, for source-pattern guards. */
const GUARD_CODE = GUARD_DO_BLOCK.replace(/--[^\n]*/g, '');

/** SHA-256 hex of a migration file's bytes == Prisma's stored checksum. */
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const FIXED_CHECKSUM = sha256(TENANT_SCOPE_MIGRATION_SQL);
const PRIOR_MIGRATION_NAME = '20260616000000_rbac_company_tenant_scope';

/** A checksum unequal to either the fixed or any plausible real one. */
const UNKNOWN_CHECKSUM = 'deadbeef'.repeat(8); // 64 hex chars

interface PriorRow {
  checksum?: string | null;
  finishedAt?: Date | null;
  rolledBackAt?: Date | null;
}

describe('RBAC tenant-backfill checksum guard — fail-closed (real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let schemaCounter = 0;

  beforeAll(() => {
    assertSafeTestDatabase();
    prisma = createPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  afterEach(async () => {
    const leftover = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT nspname FROM pg_namespace WHERE nspname LIKE 'guard_probe_%'
    `;
    for (const { nspname } of leftover) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
    }
  });

  /**
   * Stand up a synthetic `_prisma_migrations` in a throwaway schema, optionally
   * insert a tenant-scope row, then run the real guard block with `search_path`
   * pinned to the probe schema. `createTable=false` omits `_prisma_migrations`
   * entirely (the shadow/diff-replay context). On a RAISE the transaction aborts
   * and the promise rejects with the PostgreSQL message.
   */
  async function runGuard(opts: { prior?: PriorRow | null; createTable?: boolean }): Promise<void> {
    const createTable = opts.createTable ?? true;
    schemaCounter += 1;
    const schema = `guard_probe_${process.pid}_${schemaCounter}`;
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        // Resolve unqualified names to the probe schema ONLY (pg_catalog is
        // always implicitly searched). The real public._prisma_migrations is NOT
        // on this search_path, so the guard can never read it here.
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);

        // Sentinel tenant tables: if the guard ever wrote to RBAC data, these
        // would change. The guard must leave them untouched.
        await tx.$executeRawUnsafe('CREATE TABLE users (id BIGINT, company_id BIGINT)');
        await tx.$executeRawUnsafe('INSERT INTO users (id, company_id) VALUES (1, 42)');

        if (createTable) {
          await tx.$executeRawUnsafe(
            `CREATE TABLE "_prisma_migrations" (
               migration_name TEXT,
               checksum       TEXT,
               finished_at    TIMESTAMPTZ,
               rolled_back_at TIMESTAMPTZ
             )`,
          );
          if (opts.prior !== null && opts.prior !== undefined) {
            await tx.$executeRawUnsafe(
              `INSERT INTO "_prisma_migrations"
                 (migration_name, checksum, finished_at, rolled_back_at)
               VALUES ($1, $2, $3, $4)`,
              PRIOR_MIGRATION_NAME,
              opts.prior.checksum ?? null,
              opts.prior.finishedAt === undefined ? new Date() : opts.prior.finishedAt,
              opts.prior.rolledBackAt ?? null,
            );
          }
        }

        // Run the committed guard verbatim.
        await tx.$executeRawUnsafe(GUARD_DO_BLOCK);

        // Reaching here means the guard PASSED. Assert it mutated no tenant data.
        const users = await tx.$queryRawUnsafe<Array<{ id: bigint; company_id: bigint }>>(
          'SELECT id, company_id FROM users ORDER BY id',
        );
        expect(users).toEqual([{ id: 1n, company_id: 42n }]);

        await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      },
      { timeout: 30_000 },
    );
  }

  it('the guard checksum constant matches the actual tenant-scope migration file', () => {
    // If the tenant-scope migration is ever edited again, FIXED_CHECKSUM moves
    // and the hard-coded constant in the guard must move with it — this catches
    // a stale constant before it silently fails-open or fails-closed wrongly.
    expect(GUARD_CODE).toContain(FIXED_CHECKSUM);
  });

  it('1. fixed/safe checksum recorded → guard PASSES and changes no tenant data', async () => {
    await expect(runGuard({ prior: { checksum: FIXED_CHECKSUM } })).resolves.toBeUndefined();
  });

  it('2. fresh-deployed DB records the fixed checksum for the tenant-scope migration', async () => {
    // The real public._prisma_migrations on this gate database (already deployed)
    // must carry the same fixed checksum the guard expects.
    const rows = await prisma.$queryRaw<Array<{ checksum: string }>>`
      SELECT checksum FROM _prisma_migrations WHERE migration_name = ${PRIOR_MIGRATION_NAME}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.checksum).toBe(FIXED_CHECKSUM);
  });

  it('3. simulated OLD unsafe checksum → fails TENANT_BACKFILL_UNSAFE_PRIOR_MIGRATION_APPLIED', async () => {
    const unsafe = '322646d9ac57662d6721e74feb44e17a4f2bc557b522107fadb5131f5b2a8aee';
    await expect(runGuard({ prior: { checksum: unsafe } })).rejects.toThrow(
      /TENANT_BACKFILL_UNSAFE_PRIOR_MIGRATION_APPLIED/,
    );
  });

  it('4. the guard hard-codes the known old unsafe checksum it must reject', () => {
    // Defensive: the unsafe checksum the guard tests against is exactly the
    // SHA-256 of the old unsafe migration recorded in the review.
    expect(GUARD_CODE).toContain(
      '322646d9ac57662d6721e74feb44e17a4f2bc557b522107fadb5131f5b2a8aee',
    );
  });

  it('5. unknown checksum → fails TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM', async () => {
    await expect(runGuard({ prior: { checksum: UNKNOWN_CHECKSUM } })).rejects.toThrow(
      /TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM/,
    );
  });

  it('6. missing prior migration row → fails TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM', async () => {
    await expect(runGuard({ prior: null })).rejects.toThrow(
      /TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM/,
    );
  });

  it('7. prior row not finished (in-progress) → fails UNVERIFIED', async () => {
    await expect(
      runGuard({ prior: { checksum: FIXED_CHECKSUM, finishedAt: null } }),
    ).rejects.toThrow(/TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM/);
  });

  it('8. prior row rolled back → fails UNVERIFIED', async () => {
    await expect(
      runGuard({ prior: { checksum: FIXED_CHECKSUM, rolledBackAt: new Date() } }),
    ).rejects.toThrow(/TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM/);
  });

  it('9. no _prisma_migrations table (shadow/diff replay) → guard skips silently', async () => {
    // The drift gate replays migrations via `migrate diff --from-migrations`
    // without the bookkeeping table; the guard must not error there.
    await expect(runGuard({ createTable: false })).resolves.toBeUndefined();
  });

  it('10. the guard performs no tenant/data mutation (source-level)', () => {
    // Executable SQL (comments stripped) must contain no write verb at all: it
    // only SELECTs from _prisma_migrations and RAISEs.
    expect(GUARD_CODE).not.toMatch(/\bupdate\b/i);
    expect(GUARD_CODE).not.toMatch(/\bdelete\b/i);
    expect(GUARD_CODE).not.toMatch(/\binsert\b/i);
    expect(GUARD_CODE).not.toMatch(/\btruncate\b/i);
    expect(GUARD_CODE).not.toMatch(/\balter\b/i);
    expect(GUARD_CODE).not.toMatch(/\bdrop\b/i);
    expect(GUARD_CODE).not.toMatch(/\bcreate\b/i);
  });
});
