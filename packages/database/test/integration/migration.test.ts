import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPrisma } from './helpers';

/**
 * Verifies the migration actually applied the hand-written DDL Prisma cannot
 * model (extensions, CHECK constraints, append-only + updated_at triggers,
 * partial unique indexes). Assumes `prisma migrate deploy` has run against the
 * test database before this suite (CI orchestrates that).
 */
describe('migration — applied database objects', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('recorded the init migration as applied', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null }>
    >`
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.finished_at !== null)).toBe(true);
    expect(rows.some((r) => r.migration_name.includes('init'))).toBe(true);
  });

  it('installed the required extensions', async () => {
    const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname IN ('citext','pg_trgm','pgcrypto')
    `;
    const names = rows.map((r) => r.extname);
    for (const ext of ['citext', 'pg_trgm', 'pgcrypto']) expect(names).toContain(ext);
  });

  it('created the inventory CHECK constraints', async () => {
    const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'stock_balances'::regclass
    `;
    const names = rows.map((r) => r.conname);
    expect(names).toContain('stock_balances_reserved_le_on_hand');
    expect(names).toContain('stock_balances_on_hand_nonneg');
    expect(names).toContain('stock_balances_reserved_nonneg');
  });

  it('created append-only triggers on immutable tables', async () => {
    const rows = await prisma.$queryRaw<Array<{ tgname: string; relname: string }>>`
      SELECT t.tgname, c.relname
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'no_mutation_%'
    `;
    const tables = rows.map((r) => r.relname);
    for (const table of ['stock_ledger', 'audit_logs', 'payments', 'order_status_history']) {
      expect(tables, table).toContain(table);
    }
  });

  it('created partial unique indexes scoped to live rows', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname IN ('products_sku_key','users_email_key','warehouses_code_key','customers_code_key','categories_slug_key')
    `;
    expect(rows.length).toBe(5);
    for (const r of rows) expect(r.indexdef.toLowerCase()).toContain('where (deleted_at is null)');
  });
});
