import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabase } from '../../src/testing';

/**
 * DBF-007: the integrity gate must actually CATCH drift. We build a disposable
 * scratch database from the committed migrations, then drop one object of each
 * kind (trigger, partial unique index, CHECK, FK, column) and assert that
 * verify-catalog.mjs reports every one. (The structural Prisma diff side —
 * missing column / FK / unexpected index — is unit-tested in drift-eval.test.ts.)
 */
describe('catalog verification catches missing objects', () => {
  assertSafeTestDatabase();
  const base = new URL(process.env.DATABASE_URL as string);
  const scratchName = `drift_probe_${Date.now()}_test`;
  const scratchUrl = (() => {
    const u = new URL(base.toString());
    u.pathname = `/${scratchName}`;
    return u.toString();
  })();
  const adminUrl = (() => {
    const u = new URL(base.toString());
    u.pathname = '/postgres';
    return u.toString();
  })();

  let admin: PrismaClient;
  let scratch: PrismaClient;

  function runVerify(): { status: number; out: string } {
    const res = spawnSync('node', ['scripts/verify-catalog.mjs'], {
      env: { ...process.env, DATABASE_URL: scratchUrl },
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    return { status: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  }

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const deploy = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: scratchUrl },
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (deploy.status !== 0) {
      throw new Error(`scratch migrate deploy failed: ${deploy.stdout}${deploy.stderr}`);
    }
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
  }, 120_000);

  afterAll(async () => {
    await scratch?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      await admin.$disconnect();
    }
  });

  it('passes on a freshly migrated scratch database', () => {
    const { status, out } = runVerify();
    expect(status, out).toBe(0);
    expect(out).toMatch(/Catalog verification passed/);
  });

  it('fails after a trigger, partial index, CHECK, FK and column are dropped', async () => {
    await scratch.$executeRawUnsafe('DROP TRIGGER no_delete_orders ON "orders"');
    await scratch.$executeRawUnsafe('DROP INDEX "customer_addresses_default_per_type_key"');
    await scratch.$executeRawUnsafe(
      'ALTER TABLE "effect_receipts" DROP CONSTRAINT "effect_receipts_succeeded_completed"',
    );
    await scratch.$executeRawUnsafe(
      'ALTER TABLE "import_rows" DROP CONSTRAINT "import_rows_import_job_id_fkey"',
    );
    await scratch.$executeRawUnsafe('ALTER TABLE "import_jobs" DROP COLUMN "heartbeat_at"');

    const { status, out } = runVerify();
    expect(status, out).toBe(1);
    expect(out).toMatch(/no_delete_orders/);
    expect(out).toMatch(/customer_addresses_default_per_type_key/);
    expect(out).toMatch(/effect_receipts_succeeded_completed/);
    expect(out).toMatch(/import_rows_import_job_id_fkey/);
    expect(out).toMatch(/import_jobs\.heartbeat_at/);
  }, 60_000);
});
