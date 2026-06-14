import { PrismaClient } from '@prisma/client';

/**
 * Database integration-test utilities.
 *
 * Real PostgreSQL only — never SQLite or a Prisma mock. These helpers guard
 * hard against running destructive operations on a production or development
 * database and provide deterministic per-test cleanup.
 */

export class UnsafeTestDatabaseError extends Error {}

/**
 * Refuse to operate unless the target really is an isolated test database.
 *
 * Rejects when:
 *  - `NODE_ENV=production`, or
 *  - `DATABASE_URL` is missing/invalid, or
 *  - the database name does not contain "test" (prevents clobbering the dev DB),
 *    unless `ALLOW_NONTEST_DB=true` is explicitly set.
 */
export function assertSafeTestDatabase(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV === 'production') {
    throw new UnsafeTestDatabaseError('Refusing to run DB tests with NODE_ENV=production.');
  }
  const url = env.DATABASE_URL;
  if (!url) {
    throw new UnsafeTestDatabaseError('DATABASE_URL is not set for the integration test database.');
  }
  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new UnsafeTestDatabaseError('DATABASE_URL is not a valid connection URL.');
  }
  if (!/test/i.test(dbName) && env.ALLOW_NONTEST_DB !== 'true') {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive DB tests against "${dbName}" (name must contain "test").`,
    );
  }
  return url;
}

/** Construct a PrismaClient bound to the guarded test database. */
export function createTestClient(env: NodeJS.ProcessEnv = process.env): PrismaClient {
  assertSafeTestDatabase(env);
  return new PrismaClient();
}

/**
 * TRUNCATE every application table (RESTART IDENTITY, CASCADE) so each test
 * starts from a clean slate. TRUNCATE bypasses the append-only row triggers, so
 * immutable tables can still be cleared between tests. `_prisma_migrations` is
 * preserved so the schema stays applied.
 */
export async function resetDatabase(client: PrismaClient): Promise<void> {
  assertSafeTestDatabase();
  const rows = await client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}
