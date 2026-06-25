# Dashboard / Reports Tenant Leak Follow-up Review

Reviewed commit: `c0c612545a7e143ac968ec965319d8a2114942e7`

Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Findings

No blocking findings.

Non-blocking note: `stock_balances` still has independent FKs to
`products(id)` and `warehouses(id)` rather than a composite tenant FK. For this
dashboard/report read surface, the query-level fix is sufficient because both
stock-balance reads now pin both joined ends to `actor.companyId`. A future DB
constraint that carries `company_id` onto `stock_balances` would still be useful
defense in depth, but is not required to approve this leak fix.

## Review Notes

- `countLowStock` now requires both `p."company_id" = ${companyId}` and
  `w."company_id" = ${companyId}`. Product and warehouse soft-delete filters are
  preserved.
- `inventoryReport` now requires both `p."company_id" = ${companyId}` and
  `w."company_id" = ${companyId}`. Product and warehouse soft-delete filters are
  preserved.
- `warehouse:scope:all` still emits `scopeSql = Prisma.empty`, but the
  `w."company_id"` predicate remains unconditional in both affected raw SQL
  reads, so scope-all is company-local.
- Explicit `warehouseId` filters are still narrowed through
  `findActiveWarehouse(actor.companyId, publicId)`, which requires
  `companyId`, `isActive: true`, and `deletedAt: null`.
- No-warehouse-scope actors still short-circuit to zero/empty warehouse-bound
  results before repository reads.
- The added regression fixtures create the meaningful bad shape: company A
  product plus company B warehouse in one `stock_balances` row. Without the new
  warehouse tenant predicate, the low-stock count and inventory report would
  leak.
- The dashboard forged-JWT test remains in place and passed; reports resolve
  company and warehouse scope from PostgreSQL rather than trusting forged token
  claims.
- Sales and returns report behavior is unchanged. Those reads are pinned through
  their own company-scoped tables and do not join `stock_balances`.
- The reports module remains read-only: no create/update/delete/upsert,
  transaction opening, or audit write was found in the dashboard/reports service
  or repository.
- Raw SQL remains parameterized with `Prisma.sql` / `Prisma.join`; no
  `$queryRawUnsafe` / `$executeRawUnsafe` was found in the reports module.
- Bigint serialization remains safe: aggregate money/quantity values are cast to
  text or serialized through existing string/cursor helpers before response.

## Verification

Test database:
`postgresql://b2b:***@127.0.0.1:55432/b2b_dashboard_reports_tenant_leak_followup_review_test_20260622_1620?schema=public`

Shadow database:
`postgresql://b2b:***@127.0.0.1:55432/b2b_dashboard_reports_tenant_leak_followup_review_shadow_test_20260622_1620?schema=public`

| Command | Result |
| --- | --- |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` on clean DB | PASS, 21 migrations applied |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` second run | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, no drift |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| Dashboard/reports integration + reports OpenAPI | PASS, 30/30, 0 skipped |
| Product import/export + order draft/approval/shipment target batch | PASS, 133/133, 0 skipped |
| Invoice + credit-note + returns target batch | PASS, 108/108, 0 skipped |
| Stock adjustment/transfer + customer/warehouse target batch | PASS, 118/118, 0 skipped |
| PermissionGuard unit test | PASS, 22/22 |
| API authz tenant isolation/grant ceiling/cache-version/PermissionGuard batch | PASS, 49/49, 0 skipped |
| DB authz-cache-version integration test | PASS, 6/6 |
| Full API gate `pnpm.cmd test:integration:api` | PASS, 576/576 real PostgreSQL tests, 0 skipped |
| Full DB gate `pnpm.cmd test:database-gate` | PASS, 133/133 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd build` | PASS |
| `pnpm.cmd check:openapi` | PASS, no tracked-file drift |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |

