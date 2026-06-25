# Permission Tenant Backfill Follow-up Review

Date: 2026-06-16

Reviewed commits:

- `4e047560f6ab80267392db8771a0a39e7e99a296` - DB gate billing concurrency flaky failure fix
- `1ddc459af6ba1f8364c5f692a4c935ca99ec4726` - additive tenant backfill checksum guard

Production code changed by this review: no. This review only inspected code, ran tests, and added this document.

Result: **FIX_APPROVED**

## Scope Read

- `docs/reviews/PERMISSION_TENANT_BACKFILL_REVIEW.md`
- `packages/database/test/integration/billing.test.ts`
- `packages/database/prisma/migrations/20260616010000_rbac_tenant_backfill_checksum_guard/migration.sql`
- `packages/database/test/integration/tenant-backfill-checksum-guard.test.ts`
- `packages/database/prisma/migrations/20260616000000_rbac_company_tenant_scope/migration.sql`
- `packages/database/scripts/db-test-gate.mjs`
- `apps/api/scripts/api-test-gate.mjs`
- Commit metadata for `4e047560f6ab80267392db8771a0a39e7e99a296` and `1ddc459af6ba1f8364c5f692a4c935ca99ec4726`

## Blocker Review

The previous DB gate blocker is closed. The full database gate ran against real PostgreSQL 16.9 at `localhost:55432`, executed 101/101 tests, reported 0 skipped tests, and exited 0.

The billing concurrency fix keeps the row-lock behavior intact. The test still contends on the same `invoice_series` row with `SELECT ... FOR UPDATE`, still runs three concurrent allocations, and still asserts all allocated numbers are distinct, `nextNumber` advances exactly from `1` to `4`, and exactly three invoices are created. The commit only widens Prisma interactive transaction `maxWait` / `timeout` so full-gate load does not fail before a queued transaction can take the row lock.

The prior unsafe tenant-backfill checksum blocker is closed by an additive migration. With the guard migration pending, `prisma migrate deploy` now:

- passes when `_prisma_migrations` records the fixed checksum `fc3b7c2ca43fc8612dd75231b73fb33d064b74e4f2fa0703ad716113fc3b399c`;
- fails closed when it records the old unsafe checksum `322646d9ac57662d6721e74feb44e17a4f2bc557b522107fadb5131f5b2a8aee`;
- fails closed when it records an unknown checksum.

The guard performs no automatic tenant remediation. Its executable SQL selects from `_prisma_migrations` and raises exceptions/notices only; the committed guard tests also assert no tenant data mutation via a sentinel row and source-level write-verb checks.

## Required Validations

| # | Validation | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Previous DB gate blocker closed | PASS | `pnpm --filter @b2b/database test:database-gate`: 101/101 real PostgreSQL tests, 0 skipped. |
| 2 | `billing.test.ts` fix preserves row-lock concurrency behavior | PASS | `SELECT ... FOR UPDATE` remains; distinct numbers, exact `nextNumber`, and invoice count assertions remain. Isolated billing test passed 4/4 and full gate passed. |
| 3 | Full DB gate green on real PostgreSQL without skips | PASS | Wrapper output: `Database gate: 101/101 real PostgreSQL tests executed, 0 skipped.` |
| 4 | Old unsafe checksum causes additive guard deploy to fail closed | PASS | Pending guard deploy against old checksum exited 1 with `TENANT_BACKFILL_UNSAFE_PRIOR_MIGRATION_APPLIED`. |
| 5 | Current fixed checksum allows guard deploy | PASS | Pending guard deploy against fixed checksum applied `20260616010000_rbac_tenant_backfill_checksum_guard` and exited 0. |
| 6 | Unknown checksum causes guard deploy to fail closed | PASS | Pending guard deploy against `deadbeef...` exited 1 with `TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM`. |
| 7 | Guard does not auto-change tenant data | PASS | Guard test passed sentinel no-mutation assertion; source-level guard test rejects write verbs. Migration SQL has no tenant-table DML. |
| 8 | Guard runs as a real pending migration and closes the prior silent up-to-date path | PASS | Deleting only the guard migration row made it pending; `migrate deploy` attempted the new migration and failed/passed based on recorded prior checksum. |
| 9 | In-place fixed migration plus additive guard strategy acceptable for this branch | PASS | Existing unsafe-applied DBs are now blocked fail-closed; fresh/fixed DBs deploy cleanly. No automatic unsafe remediation is attempted. |
| 10 | Older approved migrations untouched by follow-up commits | PASS | `4e047560` changes only `billing.test.ts`; `1ddc459` adds only the new guard migration and its tests. |
| 11 | Tenant backfill, tenant-rbac, and authz tenant isolation tests pass | PASS | Tenant backfill 10/10, tenant-rbac 8/8, API authz tenant isolation 7/7. |
| 12 | Drift and verify catalog clean | PASS | Drift: 5 allowlisted partial-unique statements, 0 unexpected. Catalog verification passed. |

## Command Results

All database checks used isolated test databases on PostgreSQL 16.9 at `localhost:55432`.

| Check | Result |
| --- | --- |
| Clean DB `pnpm --filter @b2b/database db:migrate:deploy` | PASS, 9 migrations applied. |
| Second `pnpm --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations. |
| `tenant-backfill-checksum-guard.test.ts` | PASS, 11/11. |
| `tenant-backfill.test.ts` | PASS, 10/10. |
| `tenant-rbac.test.ts` | PASS, 8/8. |
| `authz-tenant-isolation.test.ts` | PASS, 7/7. |
| `billing.test.ts` | PASS, 4/4. |
| `pnpm --filter @b2b/database test:database-gate` | PASS, 101/101 real PostgreSQL tests, 0 skipped. |
| Guard deploy with fixed checksum pending | PASS, guard migration applied. |
| Guard deploy with old unsafe checksum pending | PASS, deploy failed closed with `TENANT_BACKFILL_UNSAFE_PRIOR_MIGRATION_APPLIED`. |
| Guard deploy with unknown checksum pending | PASS, deploy failed closed with `TENANT_BACKFILL_UNVERIFIED_PRIOR_MIGRATION_CHECKSUM`. |
| `pnpm --filter @b2b/database db:seed` twice | PASS, both runs idempotent: 61 permissions, 6 roles, 201 rolePermissions, 1 company. |
| `pnpm --filter @b2b/database db:drift` | PASS, 0 unexpected drift. |
| `pnpm --filter @b2b/database db:verify-catalog` | PASS. |
| `pnpm --filter @b2b/database db:validate` | PASS with test `DATABASE_URL`. |
| `pnpm --filter @b2b/database db:generate` | PASS. |
| `pnpm typecheck` | PASS, 18/18 tasks. |
| `pnpm lint` | PASS. |
| `pnpm format:check` | PASS. |
| `pnpm build` | PASS, 10/10 tasks. |
| `pnpm check:no-skip` | PASS. |

## Final Gate

**FIX_APPROVED**
