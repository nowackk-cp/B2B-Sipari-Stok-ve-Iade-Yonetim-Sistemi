// Pure parsing + allowlisting for the migration⇄schema drift gate, extracted so
// the "does the gate actually catch drift?" guarantee can be unit-tested without
// spawning Prisma or touching a database.

// Exact, intentional structural-diff residue: the init migration turns each of
// these plain unique indexes into a partial unique (`WHERE deleted_at IS NULL`)
// for soft-delete key reuse, preserving the index NAME. Prisma's datamodel has
// no predicate, so it reports the plain unique as "to be added". These are the
// ONLY statements allowed to appear in the diff.
export const ALLOWED_DRIFT_STATEMENTS = [
  'CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug")',
  'CREATE UNIQUE INDEX "customers_code_key" ON "customers"("company_id", "code")',
  'CREATE UNIQUE INDEX "products_sku_key" ON "products"("company_id", "sku")',
  'CREATE UNIQUE INDEX "users_email_key" ON "users"("email")',
  'CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("company_id", "code")',
  // Invoice/Billing Foundation: the active-invoice-per-order unique is a PARTIAL
  // unique (`WHERE order_id IS NOT NULL AND status <> 'VOID'`); the datamodel has
  // no predicate so the diff reports the plain unique as "to be added".
  'CREATE UNIQUE INDEX "invoices_company_id_order_id_active_key" ON "invoices"("company_id", "order_id")',
];

export function normalize(sql) {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;\s*$/, '');
}

export function parseStatements(script) {
  return script
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => normalize(s))
    .filter(Boolean);
}

/**
 * @returns {{ statements: string[], unexpected: string[] }}
 */
export function findUnexpected(script, allowed = ALLOWED_DRIFT_STATEMENTS) {
  const allow = new Set(allowed.map(normalize));
  const statements = parseStatements(script);
  return { statements, unexpected: statements.filter((s) => !allow.has(s)) };
}
