# Permission Tenant Backfill Review

Date: 2026-06-16

Reviewed commit: `6e6ac0899796f40a38a8d9d5d108696c2f0d3b88`

Production code changed: no. This review only inspected code, ran tests, and added this document.

Result: **FIX_REJECTED**

## Scope Read

- `docs/reviews/PERMISSION_TENANT_ISOLATION_REVIEW.md`
- `packages/database/prisma/migrations/20260616000000_rbac_company_tenant_scope/migration.sql`
- `packages/database/test/integration/tenant-backfill.test.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/test/integration/tenant-rbac.test.ts`
- `apps/api/test/integration/authz-tenant-isolation.test.ts`
- Commit diff for `6e6ac0899796f40a38a8d9d5d108696c2f0d3b88`

## Verdict Rationale

The new backfill SQL is fail-closed for fresh application: it does not silently pick the lowest/default company, it does not create a default company, and it aborts ambiguous legacy data with explicit `TENANT_BACKFILL_AMBIGUOUS` / `TENANT_BACKFILL_MISMATCH` errors. The new tenant-backfill test runs the committed migration `DO $$ ... END $$;` block extracted from the real migration file.

The fix is still rejected for two blocking reasons:

1. The requested full DB gate did not pass on real PostgreSQL. It executed, did not skip, and failed one pre-existing billing concurrency test: `test/integration/billing.test.ts > serialises concurrent number allocation via row lock` with `Transaction API error: Unable to start a transaction in the given time`.
2. If the old unsafe `20260616000000_rbac_company_tenant_scope` migration was already applied to any real/shared DB, this in-place SQL change will not repair that DB and Prisma `migrate deploy` / `migrate status` did not surface the checksum mismatch in my simulation. The corrected SQL only protects databases that have not yet applied this migration.

## Required Validations

| # | Validation | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Migration no longer silently defaults to a lowest/default company for multi-company legacy data | PASS | Backfill checks `company_count <> 1` before any `UPDATE`; multi-company tests reject with `TENANT_BACKFILL_AMBIGUOUS`. |
| 2 | No executable `ORDER BY id LIMIT 1`, `MIN(company_id)`, auto `Default Company`, or similar silent guess remains | PASS | Migration executable block has no such selection. Text matches are comments only; test strips comments into `BACKFILL_CODE` and asserts these patterns are absent. |
| 3 | No legacy data succeeds | PASS | `tenant-backfill.test.ts` empty fixture passed; clean PostgreSQL `migrate deploy` also passed. |
| 4 | Legacy data plus exactly one company backfills correctly | PASS | `tenant-backfill.test.ts` assigns users, roles, and user_roles to company `7n`; test passed. |
| 5 | Legacy data plus zero companies fails with `TENANT_BACKFILL_AMBIGUOUS` | PASS | `tenant-backfill.test.ts` case passed. |
| 6 | Legacy data plus 2+ companies fails with `TENANT_BACKFILL_AMBIGUOUS` | PASS | `tenant-backfill.test.ts` cases passed, including count message for 3 companies. |
| 7 | Multi-company failure happens before assigning users/roles/user_roles | PASS | SQL raises on `company_count <> 1` before the three backfill `UPDATE`s; the real block is run inside a transaction. |
| 8 | UserRole company mismatch has explicit error | PASS | Defensive mismatch case rejects with `TENANT_BACKFILL_MISMATCH`; test passed. |
| 9 | Tests run the real migration SQL block, not copied SQL | PASS | Test reads `prisma/migrations/20260616000000_rbac_company_tenant_scope/migration.sql`, extracts `DO $$ ... END $$;`, and executes `BACKFILL_DO_BLOCK`. |
| 10 | Migration applies to clean PostgreSQL | PASS | Clean `b2b_tenant_backfill_review_test` deploy applied all 8 migrations successfully. |
| 11 | Second migrate deploy is safe | PASS | Second deploy reported `No pending migrations to apply`. |
| 12 | Seed is idempotent twice | PASS | Two `db:seed` runs reported identical counts: 61 permissions, 6 roles, 201 rolePermissions, 1 company. |
| 13 | Drift and catalog verification are clean | PASS | Drift: 5 allowlisted partial-unique statements, 0 unexpected. Catalog verification passed. |
| 14 | Tenant RBAC and authz tenant isolation tests pass | PASS | DB tenant RBAC: 8/8. API authz tenant isolation: 7/7. |

## Command Results

All database checks below used real PostgreSQL 16.9 at `localhost:55432`, with isolated test databases:

- `b2b_tenant_backfill_review_test`
- `b2b_tenant_backfill_review_shadow_test`

| Check | Result |
| --- | --- |
| `pnpm --filter @b2b/database db:validate` | PASS |
| `pnpm --filter @b2b/database db:generate` | PASS |
| Clean DB `pnpm --filter @b2b/database db:migrate:deploy` | PASS, 8 migrations applied |
| Second `pnpm --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm --filter @b2b/database db:seed` twice | PASS |
| `tenant-backfill.test.ts` | PASS, 10/10 |
| `tenant-rbac.test.ts` | PASS, 8/8 |
| `authz-tenant-isolation.test.ts` | PASS, 7/7 |
| `pnpm --filter @b2b/database db:drift` | PASS |
| `pnpm --filter @b2b/database db:verify-catalog` | PASS |
| `pnpm --filter @b2b/database test:database-gate` | FAIL, 89/90 passed, 1 failed, 0 skipped |
| Isolated rerun of `billing.test.ts` | FAIL, same transaction timeout |
| `pnpm typecheck` | PASS, 18/18 tasks |
| `pnpm lint` | PASS |
| `pnpm format:check` | PASS |
| `pnpm build` | PASS, 10/10 tasks |

## Findings

### BACKFILL-001: Old-applied migration is not repaired by the in-place checksum change

Severity: **CRITICAL**

If the previous unsafe version of `20260616000000_rbac_company_tenant_scope` has already been applied to a real/shared database, this commit does not apply any corrective SQL to that database. I simulated this by applying the parent commit's migration set to `b2b_checksum_review_test`, then running the current branch's deploy against the same DB.

Observed result:

- DB recorded old checksum: `322646d9ac57662d6721e74feb44e17a4f2bc557b522107fadb5131f5b2a8aee`
- Current file SHA-256: `fc3b7c2ca43fc8612dd75231b73fb33d064b74e4f2fa0703ad716113fc3b399c`
- Current `prisma migrate deploy`: exited 0 with `No pending migrations to apply`
- Current `prisma migrate status`: exited 0 with `Database schema is up to date!`

Impact: an environment that already ran the old migration keeps the old data effects. If it had multi-company legacy RBAC data, the unsafe silent tenant assignment may already be committed, and this branch will not fail closed or repair it. In-place correction is acceptable only if there is a hard operational guarantee that no real/shared database has applied this migration. Without that guarantee, ship an additive remediation/audit migration or an explicit verified manual repair path.

### BACKFILL-002: Requested full DB gate is red

Severity: **HIGH**

The database gate executed against real PostgreSQL and did not skip, but it failed:

- `test/integration/billing.test.ts > serialises concurrent number allocation via row lock (no duplicates, no loss)`
- Error: `Transaction API error: Unable to start a transaction in the given time.`

The same test failed when rerun in isolation. This appears unrelated to tenant backfill behavior, because the targeted backfill/RBAC/authz tests passed. It still blocks approval because the requested DB gate is not green.

## Notes

- Commit `6e6ac0899796f40a38a8d9d5d108696c2f0d3b88` changes only `packages/database/prisma/migrations/20260616000000_rbac_company_tenant_scope/migration.sql` and adds `packages/database/test/integration/tenant-backfill.test.ts`.
- Older migration directories before `20260616000000_rbac_company_tenant_scope` were not changed by this commit.
- The current migration SQL is source-review clean for the original fail-closed requirement: it checks company count before backfill updates and uses explicit operator-facing errors.

## Final Gate

**FIX_REJECTED**
