#!/usr/bin/env node
// PostgreSQL catalog verification gate.
//
// The structural drift gate (check-drift.mjs) is blind to triggers, CHECK
// constraints, index predicates and FK delete actions. This script closes that
// gap: it connects to DATABASE_URL and asserts — against the live pg_catalog —
// that every security/integrity-critical object the design requires actually
// exists with the expected shape, and that NO transaction parent→child foreign
// key still cascades. Any missing object or forbidden CASCADE exits 1.
//
// It is the executable form of DATABASE_DESIGN §16/§17 and the database gate's
// "schema catalog verification" step.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const failures = [];
const fail = (m) => failures.push(m);

async function main() {
  const triggers = await prisma.$queryRawUnsafe(`
    SELECT t.tgname, c.relname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  `);
  const triggerNames = new Set(triggers.map((t) => t.tgname));

  // 1. Append-only (UPDATE+DELETE blocked) triggers — DATABASE_DESIGN §17.
  for (const name of [
    'no_mutation_stock_ledger',
    'no_mutation_order_status_history',
    'no_mutation_transfer_status_history',
    'no_mutation_return_status_history',
    'no_mutation_invoice_status_history',
    'no_mutation_order_price_overrides',
    'no_mutation_audit_logs',
    'no_mutation_payments',
    'no_mutation_import_job_errors',
    // Stock Transfer Foundation: a committed atomic transfer record is write-once
    // (UPDATE/DELETE blocked at the DB level — task rule 15).
    'no_mutation_stock_transfer_records',
  ]) {
    if (!triggerNames.has(name)) fail(`missing append-only trigger: ${name}`);
  }

  // 1b. Authorization cache version triggers (PG-004) — every permission-affecting
  //     change must bump the owning company's authorization_version, and every new
  //     company must get a baseline counter row. Without these the multi-instance
  //     stale-cache guarantee silently breaks, so the gate asserts them explicitly.
  for (const name of [
    'authz_init_company',
    'authz_bump_user_roles',
    'authz_bump_role_permissions',
    'authz_bump_roles',
    'authz_bump_users',
    // TASK-010c: a granted/revoked warehouse scope is an authz input and must bump
    // the owning company's version in-transaction, like a role/permission change.
    'authz_bump_user_warehouse_scopes',
  ]) {
    if (!triggerNames.has(name)) fail(`missing authorization-version trigger: ${name}`);
  }

  // 2. Delete-prevention triggers on transaction parents + master users.
  for (const name of [
    'no_delete_orders',
    'no_delete_stock_transfers',
    'no_delete_returns',
    'no_delete_invoices',
    'no_delete_quotes',
    'no_delete_import_jobs',
    'no_delete_export_jobs',
    'no_delete_outbox_events',
    'no_delete_effect_receipts',
    'no_delete_stock_reservations',
    'no_delete_job_logs',
    'no_delete_users',
  ]) {
    if (!triggerNames.has(name)) fail(`missing delete-prevention trigger: ${name}`);
  }

  // 3. Partial unique indexes (predicate-bearing) — invisible to Prisma diff.
  const indexes = await prisma.$queryRawUnsafe(`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
  `);
  const idxByName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
  const requirePartial = (name, predicates) => {
    const def = idxByName.get(name);
    if (!def) return fail(`missing partial unique index: ${name}`);
    if (!/UNIQUE/i.test(def)) fail(`index ${name} is not UNIQUE`);
    if (!/WHERE/i.test(def)) fail(`index ${name} is missing its WHERE predicate`);
    for (const p of predicates) {
      if (!def.toLowerCase().includes(p.toLowerCase()))
        fail(`index ${name} predicate missing "${p}": ${def}`);
    }
  };
  requirePartial('customer_addresses_default_per_type_key', ['is_default', 'deleted_at']);
  requirePartial('import_jobs_active_checksum_key', ['status', 'UPLOADED', 'IMPORTING']);
  for (const name of ['users_email_key', 'categories_slug_key']) {
    requirePartial(name, ['deleted_at']);
  }
  // TASK-011: the product SKU unique is COMPANY-SCOPED + soft-delete partial, so a
  // SKU is unique only among a company's active products and reusable after delete.
  requirePartial('products_sku_key', ['deleted_at', 'company_id']);
  // TASK-012: the warehouse code unique is likewise COMPANY-SCOPED + soft-delete
  // partial, so a code is unique only among a company's active warehouses and
  // reusable after soft delete.
  requirePartial('warehouses_code_key', ['deleted_at', 'company_id']);
  // Customer Management Foundation: the customer code unique is likewise
  // COMPANY-SCOPED + soft-delete partial, so a code is unique only among a
  // company's active customers and reusable after soft delete.
  requirePartial('customers_code_key', ['deleted_at', 'company_id']);

  // 4. CHECK constraints.
  const checks = await prisma.$queryRawUnsafe(`
    SELECT conname FROM pg_constraint
    WHERE contype = 'c' AND connamespace = 'public'::regnamespace
  `);
  const checkNames = new Set(checks.map((c) => c.conname));
  for (const name of [
    'effect_receipts_succeeded_completed',
    'effect_receipts_planned_not_completed',
    'stock_balances_reserved_le_on_hand',
    'stock_balances_on_hand_nonneg',
    'invoice_series_next_number_pos',
    // Stock Transfer Foundation: distinct source/destination + positive quantity.
    'stock_transfer_records_src_ne_dest',
    'stock_transfer_records_qty_pos',
  ]) {
    if (!checkNames.has(name)) fail(`missing CHECK constraint: ${name}`);
  }

  // 5. Foreign keys: no transaction parent→child edge may CASCADE on delete.
  //    confdeltype: a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT.
  const fks = await prisma.$queryRawUnsafe(`
    SELECT conname, conrelid::regclass::text AS child, confrelid::regclass::text AS parent, confdeltype
    FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace
  `);
  const fkByName = new Map(fks.map((f) => [f.conname, f]));
  const requireNoCascade = (name) => {
    const fk = fkByName.get(name);
    if (!fk) return fail(`missing foreign key: ${name}`);
    if (!['a', 'r'].includes(fk.confdeltype))
      fail(`foreign key ${name} must be RESTRICT/NO ACTION, found confdeltype='${fk.confdeltype}'`);
  };
  for (const name of [
    'order_status_history_order_id_fkey',
    'order_price_overrides_order_id_fkey',
    'order_price_overrides_order_item_id_fkey',
    'invoice_items_invoice_id_fkey',
    'invoice_status_history_invoice_id_fkey',
    'return_items_return_id_fkey',
    'return_status_history_return_id_fkey',
    'stock_transfer_items_transfer_id_fkey',
    'transfer_status_history_transfer_id_fkey',
    'quote_items_quote_id_fkey',
    'import_rows_import_job_id_fkey',
    'import_job_errors_import_job_id_fkey',
    'payments_invoice_id_fkey',
    'effect_receipts_outbox_event_id_fkey',
    'invoices_company_id_fkey',
    'import_jobs_company_id_fkey',
    // RBAC-TI-002: the user_roles composite FKs must NOT cascade — a hard delete
    // of a user/role that still owns assignments is refused, never silently
    // erased (migration 20260616020000_rbac_user_roles_delete_restrict).
    'user_roles_user_id_company_id_fkey',
    'user_roles_role_id_company_id_fkey',
    // TASK-010c: warehouse-scope tenancy. The warehouse→company FK and the two
    // company-pinned composite FKs on user_warehouse_scopes must RESTRICT, so a
    // hard delete of a user/warehouse that still owns a scope is refused rather
    // than silently dropping the authorization grant (SECURITY_MODEL §3, rule 5).
    'warehouses_company_id_fkey',
    'user_warehouse_scopes_user_id_company_id_fkey',
    'user_warehouse_scopes_warehouse_id_company_id_fkey',
    // TASK-011: products are tenant-scoped; the company FK must RESTRICT so a
    // company that still owns products cannot be hard-deleted out from under them.
    'products_company_id_fkey',
    // Customer Management Foundation: customers are tenant-scoped; the company FK
    // must RESTRICT so a company that still owns customers cannot be hard-deleted
    // out from under them.
    'customers_company_id_fkey',
  ]) {
    requireNoCascade(name);
  }

  // 6. Required columns / nullability.
  const cols = await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns WHERE table_schema = 'public'
  `);
  const colKey = new Map(cols.map((c) => [`${c.table_name}.${c.column_name}`, c.is_nullable]));
  const requireCol = (key, { notNull } = {}) => {
    if (!colKey.has(key)) return fail(`missing column: ${key}`);
    if (notNull && colKey.get(key) !== 'NO') fail(`column ${key} must be NOT NULL`);
  };
  requireCol('effect_receipts.outbox_event_id', { notNull: true });
  requireCol('effect_receipts.completed_at');
  // Authorization cache version counter (PG-004).
  requireCol('company_authz_versions.company_id', { notNull: true });
  requireCol('company_authz_versions.version', { notNull: true });
  // Warehouse scope tenancy (TASK-010c): both sides carry a NOT NULL company_id so
  // the composite FKs can pin user.company = warehouse.company = scope.company.
  requireCol('warehouses.company_id', { notNull: true });
  requireCol('user_warehouse_scopes.company_id', { notNull: true });
  // Catalog tenancy (TASK-011): products carry a NOT NULL company_id.
  requireCol('products.company_id', { notNull: true });
  // Customer tenancy (Customer Management Foundation): customers carry a NOT NULL
  // company_id so every customer belongs to exactly one tenant.
  requireCol('customers.company_id', { notNull: true });
  requireCol('import_jobs.company_id', { notNull: true });
  requireCol('import_jobs.replay_of_import_id');
  requireCol('import_jobs.attempt_number', { notNull: true });
  requireCol('import_jobs.resumed_from_row');
  requireCol('import_jobs.lease_expires_at');
  requireCol('import_jobs.heartbeat_at');

  if (failures.length > 0) {
    console.error(`✖ Catalog verification failed (${failures.length} problem(s)):`);
    for (const f of failures) console.error(`  • ${f}`);
    process.exitCode = 1;
  } else {
    console.log('✓ Catalog verification passed: all required triggers, partial unique indexes,');
    console.log('  CHECK constraints, non-cascading FKs and columns are present.');
  }
}

main()
  .catch((err) => {
    console.error('✖ Catalog verification could not run:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
