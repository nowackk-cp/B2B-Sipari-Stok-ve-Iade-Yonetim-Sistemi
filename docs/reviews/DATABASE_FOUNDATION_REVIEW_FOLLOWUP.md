# Database Foundation Review Follow-up

Date: 2026-06-14  
Branch: `ai/claude-database-gate-fix`  
Previous gate: `REJECTED_DATABASE_FOUNDATION`  
Review scope: Claude Code database gate remediation after `DATABASE_FOUNDATION_REVIEW.md`  
Production code changed by this review: none

## Gate Result

`APPROVED_WITH_NON_BLOCKING_NOTES`

The database gate remediation is accepted for the database foundation surface: real PostgreSQL 16.9 was available, clean-database migrations applied, the second migration deploy was idempotent, seed ran twice, drift passed, catalog verification passed, and both database gate commands executed 72/72 real PostgreSQL tests with 0 skipped tests.

This is not `APPROVED_FOR_AUTH_FOUNDATION` because no remote GitHub Actions run URL/ID was provided or verifiable, and the remaining auth-policy/service-layer items from DBF-008/DBF-009/DBF-011 are still outside this database remediation. None of the mandatory rejection conditions in the follow-up request were observed in the local real-PostgreSQL gate.

## Inputs Reviewed

- `docs/reviews/DATABASE_FOUNDATION_REVIEW.md`
- `docs/reviews/DATABASE_GATE_FIX_REPORT.md`
- `docs/reviews/FOUNDATION_1A_REVIEW.md`
- `docs/architecture/DATABASE_DESIGN.md`
- `docs/decisions/ADR-008-outbox-and-idempotency.md`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20260614000000_init/migration.sql`
- `packages/database/prisma/migrations/20260614120000_database_gate_integrity_fixes/migration.sql`
- Database integration tests under `packages/database/test/integration`
- Database gate/unit tests under `packages/database/test/unit`
- `.github/workflows/ci.yml`
- Git branch, history, tracked files, generated-output scan, and current worktree state

## Runtime Evidence

PostgreSQL:

- Server: PostgreSQL `16.9`
- Host/port: `127.0.0.1:55432`
- Binary path: `C:\Users\Administrator\Desktop\.pgtest\pgsql\bin`
- Primary review DB: `b2b_review_followup_test_20260614_1555`
- Shadow review DB: `b2b_review_followup_test_shadow_20260614_1555`
- `docker` and global `psql` were not installed, but the local EDB PostgreSQL 16.9 cluster was running and reachable.

Command results:

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS | Lockfile already up to date. |
| `pnpm format:check` | PASS | Prettier clean. |
| `pnpm lint` | PASS | ESLint completed. |
| `pnpm typecheck` | PASS | 17/17 tasks successful. |
| `pnpm test:unit` | PASS | 14/14 tasks successful; database unit gate tests included. |
| `pnpm test:integration:api` | PASS | 2 files, 11 tests passed after sandbox `spawn EPERM` rerun outside sandbox. |
| `pnpm build` | PASS | 10/10 build tasks successful. |
| `pnpm --filter @b2b/database db:format` | PASS | Prisma formatted schema; no schema diff remained. |
| `pnpm --filter @b2b/database db:validate` | PASS | Schema valid. |
| `pnpm --filter @b2b/database db:generate` | PASS | Prisma client generated after sandbox `spawn EPERM` rerun outside sandbox. |
| `pnpm --filter @b2b/database db:migrate:deploy` | PASS | Clean test DB applied `20260614000000_init` and `20260614120000_database_gate_integrity_fixes`. |
| second `db:migrate:deploy` | PASS | `No pending migrations to apply.` |
| `pnpm --filter @b2b/database db:seed` | PASS | 61 permissions, 6 roles, 201 role permissions, 1 company, 1 warehouse, 1 invoice series. |
| second `db:seed` | PASS | Same counts; idempotent. |
| `pnpm --filter @b2b/database db:drift` | PASS | `5 allowlisted partial-unique statement(s), 0 unexpected`. |
| `pnpm test:integration:db` | PASS | 13 files, 72 tests passed, 0 skipped. |
| `pnpm test:database-gate` | PASS | 13 files, 72 tests passed, 0 skipped. |
| `pnpm --filter @b2b/database db:verify-catalog` | PASS | Required triggers, partial unique indexes, CHECK constraints, non-cascading FKs and columns present. |
| `pnpm check:no-skip` | PASS | No focused/skipped tests found. |
| `pnpm check:boundaries` | PASS | Package boundaries respected. |
| `pnpm check:secrets` | PASS | No obvious secrets found in tracked files. |
| `pnpm check:docs` | PASS | Relative markdown links resolve. |

Negative gate behavior:

- `pnpm test:integration:db` without `DATABASE_URL` failed with `DB TESTS NOT EXECUTED: DATABASE_URL is not set`.
- A synthetic all-skipped Vitest JSON report evaluated to `{ code: 1 }` with message `a skipped DB test cannot count as a gate pass`.
- A first DB test attempt against a DB name without `test` failed closed: `Refusing to run destructive DB tests against ... (name must contain "test")`.

CI:

- `.github/workflows/ci.yml` defines a real PostgreSQL database job using `postgres:16`.
- The CI job includes migrate deploy, second migrate deploy, drift, seed twice, fail-closed DB integration tests, catalog verification, no-skip, and API integration.
- No GitHub Actions run URL or run ID was provided in `DATABASE_GATE_FIX_REPORT.md`.
- `gh` CLI was not installed locally, and no remote run output could be independently verified from this environment.

## Follow-up Status For Previous Findings

| ID | Status | Review |
| --- | --- | --- |
| DBF-001 | CLOSED | Real PostgreSQL 16.9 was available and used. Clean DB migration, second deploy, seed twice, drift, catalog verification, and DB tests passed locally. |
| DBF-002 | CLOSED | DB suites no longer self-skip. `db-test-gate.mjs` fails on missing/unreachable DB, zero tests, or skipped tests. `check-no-skipped-tests.mjs` now catches `skipIf`/`runIf`. |
| DBF-003 | CLOSED | Transaction parent hard deletes are blocked by DB triggers, dangerous transaction graph CASCADEs were replaced with RESTRICT/NO ACTION, and delete/status-update behavior passed on PostgreSQL. |
| DBF-004 | CLOSED | `customer_addresses_default_per_type_key` partial unique index exists and runtime tests cover duplicate default, type separation, soft-delete replacement, and concurrent insert race. |
| DBF-005 | CLOSED | `import_jobs_active_checksum_key` partial unique index exists on `(company_id, file_checksum_sha256)` for active statuses. Replay, replay FK, row idempotency, and concurrent duplicate upload tests passed. |
| DBF-006 | CLOSED | `effect_receipts.outbox_event_id` is NOT NULL with FK to `outbox_events` using RESTRICT. Output file FK exists. Effect key/provider idempotency uniqueness and status/completed_at checks passed. |
| DBF-007 | CLOSED | Trigger functions now use `SET search_path = pg_catalog, public`. Drift gate has an exact allowlist and catalog verification catches triggers, partial indexes, CHECKs, FKs, and required columns. |
| DBF-008 | PARTIALLY_CLOSED | Database seed/catalog behavior is acceptable for this gate, but actor grant ceiling remains a required Auth service-layer control. Docs still describe dot notation as a prose alias while code uses the canonical colon key. |
| DBF-009 | PARTIALLY_CLOSED | Numbered/issued invoice delete protection is now covered. Full invoice status/number consistency remains deferred to the invoice issue service and transaction-level business tests. |
| DBF-010 | CLOSED | `DATABASE_DESIGN.md` now explicitly accepts Prisma-generated `BIGSERIAL` for surrogate PKs and distinguishes it from legal invoice numbering. |
| DBF-011 | OPEN | The Prisma client lifecycle comment still says production does not use the global cache, while implementation stores the singleton on `globalThis`. This is cosmetic and not database-gate blocking. |

## PostgreSQL Gate Review

Real PostgreSQL 16:

- Verified with `SHOW server_version;` returning `16.9`.
- Clean test database migration applied both migrations successfully.
- Second migration deploy returned no pending migrations.
- Seed ran twice with identical counts.
- Drift returned `0 unexpected`.
- `test:integration:db` and `test:database-gate` both executed 72 tests, with 0 skipped.

Fail-closed behavior:

- `packages/database/scripts/db-test-gate.mjs:61` fails/maybe-local-skips when `DATABASE_URL` is missing.
- `packages/database/scripts/db-test-gate.mjs:92` fails/maybe-local-skips when PostgreSQL is unreachable.
- `packages/database/scripts/gate-eval.mjs:18-40` requires total tests > 0 and skipped tests = 0.
- `packages/database/test/unit/db-gate.test.ts:72-96` covers empty, all-skipped, and real-test result evaluation.
- `scripts/check-no-skipped-tests.mjs:14-15` now bans `skipIf` and `runIf`.

CI:

- `.github/workflows/ci.yml:83` uses `postgres:16`.
- `.github/workflows/ci.yml:132-158` wires migration deploy, second deploy, drift, seed, seed again, fail-closed DB tests, catalog verification, and no-skip.
- Remote GitHub Actions success was not verified because no run URL/ID exists in the remediation report and `gh` is unavailable.

## Immutable Parent And Cascade Review

Static migration evidence:

- `packages/database/prisma/migrations/20260614120000_database_gate_integrity_fixes/migration.sql:56-67` re-adds transaction parent-child FKs as `ON DELETE RESTRICT`.
- `migration.sql:129-154` defines `prevent_delete()` and installs delete-prevention triggers on orders, stock transfers, returns, invoices, quotes, import jobs, export jobs, outbox events, effect receipts, stock reservations, job logs, and users.
- `migration.sql:108-131` recreates trigger functions with `SET search_path = pg_catalog, public`.

Runtime evidence:

- `packages/database/test/integration/integrity.test.ts:79-189` verifies order, numbered/issued invoice, stock transfer, return, payment, user, company graph, child preservation, and valid status update behavior.
- `test:integration:db` and `test:database-gate` both passed these tests on PostgreSQL 16.9.
- Catalog query found remaining `ON DELETE CASCADE` FKs only on session/token, role/scope mapping, notification, and customer-address edges. No order/invoice/transfer/return/payment/outbox/effect transaction graph CASCADE remained.

Conclusion: Closed for database gate. Parent status updates are not over-blocked.

## Customer Default Address Review

Static evidence:

- `migration.sql:82-84` creates `customer_addresses_default_per_type_key`.
- Catalog query confirmed `CREATE UNIQUE INDEX ... ON customer_addresses(customer_id, type) WHERE is_default = true AND deleted_at IS NULL`.

Runtime evidence:

- `packages/database/test/integration/customer-default-address.test.ts:31-64` covers duplicate active default rejection, per-type separation, multiple non-default rows, soft-deleted replacement, and concurrent insert race.
- Both DB gate runs passed.

Conclusion: Closed.

## Import Duplicate Policy Review

Static evidence:

- `packages/database/prisma/schema.prisma:1025-1063` adds `companyId`, `replayOfImportId`, `attemptNumber`, recovery columns, company FK, replay self-FK, and indexes.
- `migration.sql:90-92` creates `import_jobs_active_checksum_key` on `(company_id, file_checksum_sha256)` for `UPLOADED`, `VALIDATING`, `VALIDATED`, and `IMPORTING`.
- Catalog query confirmed the partial unique predicate.

Runtime evidence:

- `packages/database/test/integration/import-duplicate.test.ts:46-65` covers terminal replay and attempt number.
- `packages/database/test/integration/import-duplicate.test.ts:68-81` covers `replay_of_import_id`.
- `packages/database/test/integration/import-duplicate.test.ts:84-98` covers row idempotency.
- `packages/database/test/integration/import-duplicate.test.ts:98` covers concurrent duplicate uploads.
- Both DB gate runs passed.

Conclusion: Closed.

## Effect Receipt Review

Static evidence:

- `packages/database/prisma/schema.prisma:1149-1171` defines `outboxEventId`, required provider idempotency key, `completedAt`, outbox FK, output file FK, effect key uniqueness, provider idempotency uniqueness, and outbox index.
- `migration.sql:72` creates `effect_receipts_outbox_event_id_fkey` as `ON DELETE RESTRICT`.
- `migration.sql:98-101` adds `SUCCEEDED => completed_at IS NOT NULL` and `PLANNED => completed_at IS NULL`.
- Catalog query confirmed `effect_receipts_outbox_event_id_fkey` confdeltype `r`, output file confdeltype `n`, both unique indexes, and both CHECK constraints.

Runtime evidence:

- `packages/database/test/integration/effect-receipt.test.ts:24-47` covers missing outbox FK and no cascade delete from outbox.
- `effect-receipt.test.ts:51-97` covers effect key and provider idempotency key uniqueness.
- `effect-receipt.test.ts:97-142` covers completed_at CHECKs and valid `PLANNED -> SUCCEEDED` transition.
- Both DB gate runs passed.

Conclusion: Closed and aligned with ADR-008 at schema level.

## Drift Review

Static evidence:

- `packages/database/scripts/drift-eval.mjs:10-16` has an exact 5-statement allowlist for Prisma-invisible soft-delete partial unique residue.
- `packages/database/scripts/check-drift.mjs:53-66` fails on any unexpected statement.
- `packages/database/scripts/verify-catalog.mjs:4-17` explicitly covers what Prisma structural diff cannot see.
- `verify-catalog.mjs:69-105` checks partial unique indexes and CHECK constraints.
- `verify-catalog.mjs:105-160` checks non-cascading FKs and required columns.

Runtime/test evidence:

- `db:drift` passed with `5 allowlisted partial-unique statement(s), 0 unexpected`.
- `packages/database/test/unit/drift-eval.test.ts:20-53` proves missing column, missing FK, unexpected index, and changed allowlisted statement are flagged.
- `packages/database/test/integration/catalog-gate.test.ts:69-86` drops a trigger, partial index, CHECK, FK, and column in a scratch DB and verifies catalog gate failure.

Conclusion: Closed for the current custom SQL surface.

## Git And Version Control Review

- Current branch: `ai/claude-database-gate-fix`.
- Remediation commits were appended after `ai/claude-database-foundation`; migration history was not rewritten.
- `packages/database/prisma/migrations/20260614120000_database_gate_integrity_fixes/migration.sql` is tracked.
- `docs/reviews/DATABASE_FOUNDATION_REVIEW.md`, `docs/reviews/FOUNDATION_1A_REVIEW.md`, and `docs/reviews/DATABASE_GATE_FIX_REPORT.md` are tracked.
- Old review files were added to version control in commit `1e13f2d`; they were not modified again after that commit.
- Generated output scan found no tracked `node_modules`, `.prisma`, `dist`, `.next`, `.turbo`, engine binary, zip, or generated Prisma client artifacts.
- `git diff -- packages/database/prisma/schema.prisma` was empty after `prisma format`.

This new follow-up file is intentionally created by this review and must be included in the next commit.

## Residual Notes

1. Remote CI has not been independently verified. The workflow is configured correctly, but no GitHub Actions run URL/ID was present and `gh` is unavailable locally.
2. DBF-008 remains an Auth Foundation implementation requirement: actor grant ceiling must be enforced in service-layer role/permission assignment paths.
3. DBF-009 remains partly deferred to the invoice issue service: status/number/timestamp consistency should be covered by business transaction tests.
4. DBF-011 is a low-risk stale comment in the Prisma client lifecycle code.

## Final Gate Decision

`APPROVED_WITH_NON_BLOCKING_NOTES`

