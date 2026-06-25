# Dashboard / Reports Backend Foundation Review

Reviewed commit: `32339fa`

Result: `REJECTED`

## Findings

### BLOCKER: Inventory report and dashboard low-stock reads do not tenant-filter the warehouse side

`ReportsRepository.countLowStock` and `ReportsRepository.inventoryReport` join
`stock_balances -> products -> warehouses`, but filter tenant only through
`p."company_id" = ${companyId}`. They do not require `w."company_id" = ${companyId}`.

Evidence:
- `apps/api/src/modules/reports/reports.repository.ts:162-170`
- `apps/api/src/modules/reports/reports.repository.ts:256-262`
- `packages/database/prisma/schema.prisma:699-713`

`StockBalance` has independent FKs to `products(id)` and `warehouses(id)` and no
composite tenant pin. Existing stock reads correctly filter both relations:
`apps/api/src/modules/inventory/stock.repository.ts:659-663`.

Impact: a `warehouse:scope:all` actor uses `{ global: true }`, so `scopeSql` emits
no warehouse-id restriction. If a stock balance row pairs an actor-company product
with another company's warehouse, `GET /api/v1/reports/inventory` can expose that
other company's warehouse public id and stock quantities, and
`GET /api/v1/dashboard/summary` can count it in `lowStockProducts`. This violates
the explicit reject criteria for cross-company inventory leakage and
`warehouse:scope:all` being company-local.

Required fix: filter both joined ends in the reports SQL, at minimum
`AND w."company_id" = ${companyId}` for stock-balance reads, and add a regression
test with company A product + company B warehouse in `stock_balances` proving
inventory rows and dashboard low-stock counts do not leak. A DB-level composite
tenant pin on `stock_balances` would be stronger defense in depth.

### BLOCKER: Required real PostgreSQL gates did not execute in this environment

This machine has no reachable PostgreSQL on `localhost:5432`, and Docker is not
installed, so the required real-DB integration/gate commands could not produce a
valid pass. Per the review instructions, red full API/DB gates or real PostgreSQL
tests that skip/not-execute require `REJECTED`.

Evidence:
- Dashboard/report integration + OpenAPI target run: `2 failed files`, `28 skipped`, `P1001`.
- Requested broader API integration target run: `25 failed files`, `420 skipped`, `P1001`.
- Full API gate: `API TESTS NOT EXECUTED: cannot reach PostgreSQL at localhost:5432`.
- Full DB gate: `DB TESTS NOT EXECUTED: cannot reach PostgreSQL at localhost:5432`.
- `migrate deploy` first and second run: `P1001`.
- `seed` first and second run: `P1001`.
- `db:drift` and `db:verify-catalog`: `P1001`.

## Verification Notes

- `dashboard:read` / `report:read`: controller metadata is correct by code
  (`DashboardController` requires `dashboard:read`; all report endpoints require
  `report:read`). Runtime integration could not execute because PostgreSQL was
  unreachable.
- `report:read` RBAC seed: catalog and role matrix include `report:read` for the
  same roles as `dashboard:read`; seed uses permission upsert and the matrix
  idempotently.
- Warehouse scope: `ReportsService` resolves scope through `WarehouseScopeService`
  from PostgreSQL, not JWT claims. Optional `warehouseId` filters are narrowed via
  active actor-company warehouse lookup. The global stock-balance SQL issue above
  remains a blocker.
- Scope-none dashboard master counts: product/customer counts are company-wide
  master data by contract and test intent; warehouse-bound figures return zero.
  I do not treat company-local master counts as a warehouse-scope leak.
- Sales: SQL filters `invoices.company_id`, `ISSUED` status, UTC period buckets,
  and currency groups. Gross-sales behavior is documented; credit notes are not
  deducted.
- Returns: counts and credit-note totals are joined through returns and scoped by
  return warehouse. No cross-company returns leak was found in static review.
- Raw SQL: no `$queryRawUnsafe` was found in the reports module; user inputs are
  passed through `Prisma.sql` parameters / `Prisma.join`.
- Bigint serialization: aggregate sums and quantities are returned as text/string;
  internal bigint cursor id is encoded before response.
- Read-only behavior: no create/update/delete/upsert/audit/transaction call was
  found in `apps/api/src/modules/reports`.
- OpenAPI schemas: response DTO classes are non-empty, and `check:openapi` passed
  with no tracked-file drift.
- Prior `seedRbac Transaction already closed` flake: I found no dashboard/report
  production transaction or write path that would cause it. The reports code is
  read-only and opens no transaction. Because local real-DB gates could not run, I
  cannot reproduce it here; based on code shape, it is not attributable to the
  dashboard/report implementation.

## Commands Run

| Command | Result |
| --- | --- |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/dashboard-reports.test.ts test/integration/reports-openapi.test.ts` | FAIL, PostgreSQL unreachable; 28 skipped |
| requested API integration target set | FAIL, PostgreSQL unreachable; 420 skipped |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/permission-guard.test.ts` | PASS, 22/22 |
| `pnpm.cmd --filter @b2b/api test:integration` | FAIL, API tests not executed; PostgreSQL unreachable |
| `pnpm.cmd --filter @b2b/database test:database-gate` | FAIL, DB tests not executed; PostgreSQL unreachable |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` | FAIL twice, `P1001` |
| `pnpm.cmd --filter @b2b/database db:seed` | FAIL twice, `P1001` |
| `pnpm.cmd --filter @b2b/database db:drift` | FAIL, `P1001` |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | FAIL, `P1001` |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS on retry; first parallel attempt hit Windows `EPERM` file lock |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd build` | PASS |
| `pnpm.cmd check:openapi` | PASS |
