# Database Foundation Review

Date: 2026-06-14  
Branch: `ai/claude-database-foundation`  
Reviewed range: `ai/claude-foundation-1a..HEAD`  
Reviewer role: Principal Database Reviewer, Security Reviewer, independent Database Foundation Gate Reviewer  
Code changes made by this review: none

## Gate Result

`REJECTED_DATABASE_FOUNDATION`

The implementation has substantial static foundation work, but the gate cannot pass. Real PostgreSQL runtime validation was not available in this environment, the database integration command exits successfully while skipping all database tests when no safe database is configured, and several schema gaps conflict with the approved database design for immutability, duplicate import policy, and documented constraints.

## Evidence Reviewed

Required documents were reviewed, including `PROJECT_SPEC.md`, `CLAUDE.md`, `AGENTS.md`, database/security/module-boundary architecture documents, the permission matrix, test strategy, ADR-002, ADR-005, ADR-006, ADR-007, ADR-008, implementation plan, and `docs/reviews/FOUNDATION_1A_REVIEW.md`.

Repository history, current branch, commit range, full TASK-004 diff, Prisma schema, migration SQL, seed code, database client code, package boundaries, CI configuration, static check scripts, and test suites were inspected.

## Commands Run

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS | Lockfile install completed. |
| `pnpm format:check` | PASS | No formatting drift reported. |
| `pnpm lint` | PASS | Lint completed. |
| `pnpm check:no-skip` | PASS | Required escalation because git safe-directory access was blocked in sandbox. Does not catch `describe.skipIf`. |
| `pnpm check:secrets` | PASS | Required escalation because git safe-directory access was blocked in sandbox. |
| `pnpm check:boundaries` | PASS | Package-boundary script completed. |
| `pnpm typecheck` | PASS | TypeScript typecheck completed. |
| `pnpm test:unit` | PASS | Unit tests completed. |
| `pnpm test:integration` | PARTIAL / NOT ACCEPTED | API integration tests passed, but all database integration suites were skipped because no safe DB URL was configured. |
| `pnpm test` | PASS | Root test command passed, but it does not validate the PostgreSQL database suite. |
| `pnpm build` | PASS | Build completed. |
| `pnpm test:e2e` | PASS | Playwright contract smoke tests completed. |
| `pnpm --filter @b2b/database db:format` | PASS | No schema diff after format. |
| `pnpm --filter @b2b/database db:validate` | PASS | Used dummy `DATABASE_URL` for offline validation. |
| `pnpm --filter @b2b/database db:generate` | PASS | Required escalation after sandbox `spawn EPERM`. |
| `pnpm check:docs` | PASS | Documentation link/check script completed. |
| `pnpm check:openapi` | PASS | Required escalation after sandbox write restriction; no tracked OpenAPI drift remained. |
| `docker --version` / `docker compose version` | FAIL | Docker was not installed/available. |
| `psql --version` / `pg_isready --version` | FAIL | PostgreSQL client tools were not installed/available. |
| `pnpm --filter @b2b/database db:migrate:deploy` | FAIL | With local test URL, Prisma returned `P1001: Can't reach database server at localhost:5432`. |
| `pnpm --filter @b2b/database db:seed` | FAIL | Same local PostgreSQL connectivity failure. |
| `pnpm --filter @b2b/database db:drift` | FAIL | Same local PostgreSQL connectivity failure. |

Second migrate deploy, first seed, second seed, drift validation, live constraint checks, and live concurrency checks could not be accepted because no real PostgreSQL server was reachable.

## Positive Findings

- Prisma usage is isolated to `@b2b/database`; frontend and contracts do not import Prisma.
- `packages/shared` was removed/renamed to `packages/contracts`, and static boundary checks exist.
- The domain package is framework-independent and does not import Nest, Prisma, or database code.
- The database client fails fast on invalid or missing `DATABASE_URL`.
- Development hot reload connection multiplication is mitigated with a process-global Prisma client cache.
- The transaction helper uses typed `Prisma.TransactionClient`.
- Generated Prisma client artifacts are not committed.
- Money fields in the schema use `BigInt` minor units, currencies are explicit, and tax/discount rates are integer basis points.
- Stock balance non-negative and `reserved <= on_hand` checks are present statically in the migration.
- Stock ledger idempotency key is `NOT NULL` and unique statically.
- PostgreSQL sequences are not used for legal gapless invoice numbering; an `invoice_series` counter model exists.
- Audit logs, stock ledger, status-history tables, price overrides, payments, and import job errors have static append-only triggers.
- Outbox deduplication and effect receipt uniqueness are modeled.
- Logger tests cover generic/nested token redaction and avoid false redaction of `tokenCount`.
- DTO whitelist integration tests use a real Nest `ValidationPipe` through a test-only controller; no production test endpoint was found.
- CI includes quality, database, and compose jobs, including docs, package boundary, Prisma, migration, seed, drift, and integration-test steps.

## Findings

### DBF-001 - BLOCKER - Real PostgreSQL Runtime Validation Was Not Completed

Problem: The required live PostgreSQL validation could not be performed in this environment.

Evidence:
- Docker was unavailable: `docker --version` and `docker compose version` failed.
- PostgreSQL client/server tools were unavailable: `psql`, `pg_isready`, `postgres`, and `initdb` were not found.
- No `DATABASE_URL` or `SHADOW_DATABASE_URL` was configured.
- `pnpm --filter @b2b/database db:migrate:deploy`, `db:seed`, and `db:drift` against `localhost:5432` failed with Prisma `P1001`.
- No local PostgreSQL process or service was detected.

Impact: Empty-database migration, seed idempotency, drift, triggers, constraints, and concurrency behavior were not verified on real PostgreSQL. The gate requires real PostgreSQL and explicitly rejects treating SQLite, mock, or skipped tests as constraint validation.

Recommended fix: Provide a reachable isolated PostgreSQL 16+ test database in CI and local review workflows, with separate `DATABASE_URL` and `SHADOW_DATABASE_URL`, and require migration/seed/drift/constraint checks to run against it.

Required test: Re-run migrate deploy on a clean PostgreSQL database, deploy again for idempotency where applicable, run seed twice, run drift check, and execute the full database integration suite plus explicit mutation/concurrency probes.

Authentication milestone impact: Blocks promotion. Auth/RBAC depends on trustworthy role, permission, session, scope, audit, and migration guarantees.

### DBF-002 - CRITICAL - Database Integration Tests Can Fake-Pass by Skipping Every DB Test

Problem: `pnpm test:integration` exits successfully even when every database integration test is skipped.

Evidence:
- `packages/database/test/integration/helpers.ts` derives `dbConfigured` from `assertSafeTestDatabase()`.
- Database suites use `describe.skipIf(!dbConfigured)`, including inventory, billing, platform, seed, and schema integration tests.
- The local `pnpm test:integration` run reported all database files and all 44 database tests skipped while exiting 0.
- `scripts/check-no-skipped-tests.mjs` catches `.skip`, `.only`, `xit`, `it.todo`, and similar direct markers, but not `describe.skipIf`.

Impact: A required database gate can appear green without running PostgreSQL tests. That satisfies one of the explicit rejection conditions: tests are being successfully bypassed for the database layer.

Recommended fix: Make the database integration script fail hard when no safe PostgreSQL `DATABASE_URL` is configured. Either remove conditional `skipIf` from required DB suites or add a separate explicit optional mode. Extend no-skip checks to catch `skipIf`, `runIf`, and equivalent conditional skipping in required test paths.

Required test: Run `pnpm test:integration` with no database and verify it fails. Run it with a safe test PostgreSQL URL and verify all database tests execute.

Authentication milestone impact: Blocks promotion. Auth persistence and RBAC scope validation cannot rely on test commands that silently skip database assertions.

### DBF-003 - HIGH - Immutable Transaction Parents Can Be Deleted and Cascade Historical Data

Problem: The database design marks transaction/history tables as immutable or non-deletable, but the schema does not prevent deleting several parent records, and some child FKs cascade historical data.

Evidence:
- `docs/architecture/DATABASE_DESIGN.md` states that orders, order items, status history, stock ledger, stock reservations, invoices, invoice items, payments, returns, return items, audit logs, and job logs are not soft-deleted and should not be hard-deleted in normal operation.
- The migration adds `prevent_mutation()` triggers only to `stock_ledger`, status-history tables, `order_price_overrides`, `audit_logs`, `payments`, and `import_job_errors`.
- `orders`, `order_items`, `invoices`, `invoice_items`, `returns`, `return_items`, `stock_transfers`, `stock_transfer_items`, `stock_reservations`, and `job_logs` do not have equivalent delete-prevention triggers.
- Several historical children use `ON DELETE CASCADE`, including `order_status_history -> orders`, `order_price_overrides -> orders/order_items`, `invoice_items -> invoices`, `invoice_status_history -> invoices`, `return_items -> returns`, and `return_status_history -> returns`.

Impact: A numbered or issued invoice can be deleted if other FK references do not block it, and deleting a parent can erase status history, line snapshots, and override history. This violates auditability and invoice-numbering requirements.

Recommended fix: Add explicit database-level delete-prevention triggers or restrictive FK behavior for immutable transactional parents and children. Replace historical `CASCADE` paths with `RESTRICT`/`NO ACTION` unless there is a documented pre-issuance cleanup state that is separately enforced.

Required test: On PostgreSQL, attempt `UPDATE` and `DELETE` against each immutable table and verify rejection. Specifically test deleting a numbered invoice and an order with status history and price overrides.

Authentication milestone impact: Blocks or severely delays promotion. Auth auditability and operational accountability depend on immutable business history.

### DBF-004 - HIGH - Customer Default Address Uniqueness Is Missing

Problem: The documented one-default-address-per-customer/type invariant is not enforced.

Evidence:
- `docs/architecture/DATABASE_DESIGN.md` specifies a partial unique constraint for `customer_addresses`: max one `(customer, type)` with `is_default = true` and `deleted_at IS NULL`.
- `CustomerAddress` in `packages/database/prisma/schema.prisma` has `isDefault` and an index on `[customerId, type]`, but no unique constraint.
- The migration partial unique section creates active uniques for users, categories, products, warehouses, and customers, but not customer default addresses.

Impact: Multiple active default billing or shipping addresses can exist for the same customer, which makes order/invoice address snapshot selection ambiguous.

Recommended fix: Add a partial unique index like `(customer_id, type) WHERE is_default = true AND deleted_at IS NULL`.

Required test: Insert two active default addresses of the same type for one customer and verify PostgreSQL rejects the second insert; verify a soft-deleted default does not block a new active default.

Authentication milestone impact: Non-auth directly, but it weakens the database foundation that later scoped customer workflows rely on.

### DBF-005 - HIGH - Import Duplicate Upload Policy Is Not Enforced

Problem: Import job duplicate detection is indexed but not unique.

Evidence:
- `docs/architecture/DATABASE_DESIGN.md` requires duplicate upload policy based on checksum, type, and scope.
- `ImportJob` stores `fileChecksumSha256`, `type`, `status`, and import lifecycle fields, but only has a non-unique index on `[type, fileChecksumSha256]`.
- The migration creates `import_jobs_type_file_checksum_sha256_idx`, not a unique or partial unique index.

Impact: Duplicate import jobs for the same file/type can be inserted concurrently. Idempotent imports and crash recovery become service-dependent rather than database-enforced.

Recommended fix: Add the documented unique or partial unique constraint for active/processing duplicate policy. Include company/tenant scope if imports are tenant-scoped.

Required test: Concurrently insert duplicate import jobs with the same checksum/type/scope and verify exactly one succeeds.

Authentication milestone impact: Non-auth directly, but import jobs can create or mutate scoped business data; weak duplicate control increases operational risk before auth workflows expand.

### DBF-006 - MEDIUM - Effect Receipt Output File Is Not a Foreign Key

Problem: `effect_receipts.output_file_id` is present as a scalar column but is not related to `files`.

Evidence:
- `docs/architecture/DATABASE_DESIGN.md` documents `output_file_id FK -> files NULL`.
- `EffectReceipt` has `outputFileId BigInt? @map("output_file_id")` but no Prisma relation to `File`.
- The migration does not add an FK from `effect_receipts.output_file_id` to `files.id`.

Impact: Effect receipts can reference non-existent output files, weakening auditability for external side effects and manual review.

Recommended fix: Add the missing optional FK relation to `files`.

Required test: Insert an effect receipt with a non-existent `output_file_id` and verify PostgreSQL rejects it.

Authentication milestone impact: Low direct auth impact, but side-effect audit trails are part of the foundation for account and notification workflows.

### DBF-007 - MEDIUM - Trigger Functions Are Not Search-Path Hardened

Problem: Migration trigger functions are not schema-qualified and do not set a controlled `search_path`.

Evidence:
- The migration creates `set_updated_at()` and `prevent_mutation()` without schema qualification.
- Triggers execute unqualified function names.
- The functions do not specify `SET search_path`.

Impact: The risk is lower for simple PL/pgSQL functions that do not perform dynamic SQL, but the migration does not meet the requested hardening standard. Future changes to these functions could become search-path sensitive.

Recommended fix: Create functions in an explicit schema, call them with schema-qualified names, and set a controlled `search_path` inside the function definition.

Required test: Re-run migration on a clean database and verify trigger execution still works with a restricted or altered session `search_path`.

Authentication milestone impact: Non-blocking by itself, but should be fixed before adding security-critical database functions.

### DBF-008 - MEDIUM - RBAC Protected Permission Policy Is Inconsistent Across Docs and Seed Catalog

Problem: The protected permission model is not consistently specified.

Evidence:
- `packages/domain/src/rbac.ts` treats only `role:manage:protected`, `warehouse:scope:all`, `audit:read:all`, and `system:read` as protected.
- `ADMIN` receives `role:manage` and `user:assign-role`, while protected permissions are reserved for `SYSTEM_ADMIN`.
- `docs/architecture/SECURITY_MODEL.md` and `docs/architecture/DATABASE_DESIGN.md` list `user:assign-role` as a protected permission example.
- `docs/PERMISSION_MATRIX.md` also marks `role:manage` and `user:assign-role` as sensitive/protected-looking entries, while another note says ADMIN may have them only with grant-ceiling restrictions.

Impact: The seed may be correct under the permission-matrix note, but the security model and database design can also be read as forbidding these permissions for normal ADMIN. The actor grant ceiling cannot be solved by persistence alone; service-layer enforcement is mandatory and must not be implied by DB seed data.

Recommended fix: Reconcile the approved documents and seed catalog into one canonical permission policy. Explicitly document that database persistence cannot enforce actor grant ceiling alone, and ensure the auth milestone implements service-layer grant ceiling checks before exposing role assignment.

Required test: Seed roles, then verify normal ADMIN cannot assign protected roles/permissions or escalate another user beyond ADMIN's own effective permission ceiling. Verify `SYSTEM_ADMIN` remains protected.

Authentication milestone impact: High. This must be resolved before Auth Foundation because role assignment is an escalation boundary.

### DBF-009 - MEDIUM - Invoice Status/Number Invariants Are Not Fully Enforced by the Schema

Problem: The schema has invoice-series primitives, but status and numbering invariants are not fully database-enforced.

Evidence:
- `invoice_series.next_number` has a positive check, and invoices have a composite unique invoice number.
- The implementation does not use PostgreSQL sequences for legal invoice numbering.
- No database constraint was found that requires `issued_at` or invoice number fields when status is `ISSUED` or `VOID`.
- No delete-prevention trigger protects numbered invoices, as noted in DBF-003.
- The available tests are database primitive tests, not a business issue service, and were skipped locally without PostgreSQL.

Impact: Direct SQL or buggy service code can create inconsistent invoice status rows. The foundation does not yet prove gapless business issuance semantics.

Recommended fix: Either add database checks for status/number consistency or explicitly defer them to the future invoice issue service with transaction-level tests. Add delete prevention for numbered/issued invoices.

Required test: Attempt to create `ISSUED`/`VOID` invoices without required number/timestamp fields and verify the intended layer rejects them. Run rollback and concurrent issue tests on real PostgreSQL.

Authentication milestone impact: Non-auth directly, but the database foundation gate includes invoice-series safety and cannot treat unrun primitive tests as proof.

### DBF-010 - LOW - Primary Key Generation Differs From the Database Design Convention

Problem: The migration uses `BIGSERIAL` for primary keys rather than the documented `BIGINT GENERATED ALWAYS AS IDENTITY` convention.

Evidence:
- `docs/architecture/DATABASE_DESIGN.md` defines the ID convention as `BIGINT GENERATED ALWAYS AS IDENTITY`.
- Prisma `@default(autoincrement())` generated `BIGSERIAL` columns in the migration.

Impact: This is not the same as using PostgreSQL sequences for legal invoice numbers, and it does not by itself break domain correctness. It is still a convention drift that should be accepted explicitly or corrected.

Recommended fix: Decide whether `BIGSERIAL` is acceptable for Prisma-managed surrogate keys and update the design document or migration strategy accordingly.

Required test: Migration review should assert the chosen PK generation strategy is intentional and stable.

Authentication milestone impact: Low.

### DBF-011 - LOW - Prisma Client Lifecycle Comment Does Not Match Behavior

Problem: The database client comment says production does not use the global cache, but the code caches the Prisma client on `globalThis` regardless of environment.

Evidence:
- `packages/database/src/client.ts` stores the client in `globalThis.__b2bPrisma`.
- The nearby comment describes production behavior differently.

Impact: The actual behavior is a safe process-wide singleton for most server deployments, but misleading comments can cause future lifecycle changes to be made on a false assumption.

Recommended fix: Update the comment in a future code cleanup, or make the implementation match the intended environment-specific behavior.

Required test: Unit test or integration smoke that repeated `getPrismaClient()` calls return the same process-local client.

Authentication milestone impact: Low.

## Requested Foundation Checks

### Foundation Notes

- Generic and nested token redaction is covered by logger tests.
- `tokenCount` is not redacted by the current redaction tests.
- CI jobs enforce real command exit codes through shell commands and package scripts.
- Skip/only control exists, but it misses conditional `describe.skipIf`; see DBF-002.
- Documentation, package boundary, Prisma, migration, seed, drift, OpenAPI/client drift, and compose checks are wired into CI.
- `packages/shared` has been removed or narrowed into `packages/contracts`.
- Domain/contracts/database dependency direction is correct in static checks.
- DTO whitelist runtime integration uses a real `ValidationPipe` in test code.
- No production test endpoint was found.

### Prisma And Package Boundaries

- Prisma source imports are limited to `@b2b/database`.
- Frontend and contracts do not import Prisma.
- Prisma models are not exported from frontend/contracts. The database package does export Prisma types/client for server-side consumers.
- The domain package is framework-independent.
- Client lifecycle is fail-fast and hot-reload aware.
- Transaction helper is typed.
- `DATABASE_URL` validation fails fast.
- Generated Prisma client artifacts were not committed.

### Schema Completeness

The schema implements a broad persistence surface beyond the TASK-004 acceptance slice, including identity, RBAC, warehouse scope, catalog, customers, stock, orders, returns, billing, imports, outbox/effects, audit, notifications, and jobs. The following schema gaps are material:

| Area | Gap |
| --- | --- |
| Immutable transactions | Several parent transaction tables can still be deleted, and child history can cascade-delete. |
| Customer addresses | Missing partial unique for one active default address per customer/type. |
| Imports | Duplicate file checksum/type/scope policy is not unique. |
| Effects | `output_file_id` is not an FK to `files`. |
| Invoice status | Status/number/timestamp invariants are not fully database-enforced. |
| PK convention | Uses `BIGSERIAL` rather than documented identity columns. |

### Money And Snapshot Safety

- Money is stored as `BigInt` minor units.
- Currency is stored explicitly with fixed-length three-character fields and checks.
- Tax and discount rates are integer basis points.
- No floating-point Prisma money field was found.
- Order, invoice, quote, return, and payment snapshot fields are broadly present.
- Negative price and quantity checks are present statically in the migration.
- No production JavaScript `number` conversion of money was identified; test-only conversions were not treated as production evidence.

### Stock Integrity

- Static schema/migration checks exist for `on_hand >= 0`, `reserved >= 0`, and `reserved <= on_hand`.
- `(product_id, warehouse_id)` is unique for stock balances.
- Stock movement idempotency key is `NOT NULL` and unique.
- Stock ledger update/delete triggers exist statically.
- FK and index coverage is broadly present.
- Reservation model is broadly consistent with the design.
- Same product/warehouse concurrent insert behavior was not verified on PostgreSQL because no DB was reachable.

### RBAC And Warehouse Scope

- `roles.is_system`, `roles.is_protected`, `permissions.is_protected`, and `permissions.permission_group` are present.
- `user_warehouse_scopes` is an explicit table with duplicate-scope prevention.
- No implicit ADMIN global warehouse scope was found in the static seed/catalog.
- `SYSTEM_ADMIN` is protected.
- Canonical global warehouse permission appears to be `warehouse:scope:all`; no `warehouse.scope.all` alias was found.
- Normal ADMIN does not receive the protected `warehouse:scope:all`, `audit:read:all`, `system:read`, or `role:manage:protected` permissions.
- The `role:manage` / `user:assign-role` policy conflict must be reconciled before auth work; see DBF-008.
- Persistence cannot solve actor grant ceiling alone and must not be represented as doing so.

### Invoice Series

- No PostgreSQL sequence is used for legal gapless invoice numbering.
- `invoice_series` counter model exists.
- `next_number` has a positive static check.
- Composite invoice number uniqueness exists.
- Rollback and concurrency tests exist at DB primitive level, not business issue-service level, and were skipped locally without PostgreSQL.
- Numbered/issued invoice delete prevention is incomplete; see DBF-003.

### Audit, Outbox, And Effect Receipt

- Audit log append-only trigger exists statically.
- Audit update/delete PostgreSQL rejection was not runtime-verified.
- Outbox deduplication key is unique.
- Effect key uniqueness is modeled.
- Effect states include `UNKNOWN`.
- Outbox and business audit are separate tables.
- Outbox is not used as a replacement for business audit in the schema.
- `effect_receipts.output_file_id` lacks the documented FK; see DBF-006.

### Import And Soft Delete

- File checksum and import job state fields exist.
- Import staging rows exist.
- Row idempotency is modeled through import row keys.
- Duplicate upload policy is not database-enforced; see DBF-005.
- Crash recovery fields are broadly present.
- Soft delete exists for master/reference-style tables.
- Active unique indexes exist for users, categories, products, warehouses, and customers.
- Immutable transaction tables mostly do not use `deleted_at`, but hard-delete protection is incomplete.

### Migration Quality

- The migration is deterministic and creates tables before foreign keys.
- Extensions are declared at the top.
- Initial lock risk is acceptable for an empty baseline migration, but non-concurrent indexes would need review for existing production data.
- Trigger functions are not schema-qualified or search-path hardened; see DBF-007.
- Partial indexes are present where implemented, but customer default address and import duplicate policies are missing.
- Enum creation is acceptable for an initial migration; future enum-change strategy is not documented.
- Rollback/downgrade strategy is not provided beyond Prisma migrate defaults.
- Migration is not created at application runtime.

### Seed Safety

- Static seed implementation is idempotent by design and uses transactions for role/permission/bootstrap operations.
- Protected flag downgrade prevention is implemented in seed code paths.
- Production admin bootstrap is environment-gated and not hard-coded in the inspected seed code.
- Seed does not create implicit warehouse scopes.
- Canonical permission catalog is sourced from the domain package.
- First and second seed runs could not be verified on real PostgreSQL due unavailable database.

### Test And CI Integrity

- Unit, lint, typecheck, build, docs, boundary, OpenAPI, Prisma format/validate/generate, and e2e smoke checks completed.
- Required PostgreSQL migration/seed/drift/constraint/concurrency checks did not complete locally.
- Conditional skipped database tests are the main test integrity issue.
- No production database connection was used; test database safety checks rejected missing/unsafe URLs.

## Final Gate Decision

`REJECTED_DATABASE_FOUNDATION`

This rejection is based on mandatory gate criteria: real PostgreSQL validation could not be completed, database tests can pass while skipped, and static schema review found material violations around immutable transactional deletes and documented constraints. The Auth Foundation milestone should not proceed until these issues are fixed and revalidated on a clean PostgreSQL database.
