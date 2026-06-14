# Database Gate Remediation Report

Date: 2026-06-14
Branch: `ai/claude-database-gate-fix` (from `ai/claude-database-foundation`)
Validation: real **PostgreSQL 16.9** (locally provisioned — Path C; no Docker/GitHub CLI in this environment)
Source review: [DATABASE_FOUNDATION_REVIEW.md](DATABASE_FOUNDATION_REVIEW.md) — gate `REJECTED_DATABASE_FOUNDATION`

This report records how each Codex finding was closed, the schema/migration changes, the tests added, and the real-PostgreSQL evidence. Review documents were not modified.

## Real PostgreSQL environment

No Docker, no `gh`/GitHub CLI, no system PostgreSQL, and no remote push credentials were available. Per the task's Path C, an isolated **PostgreSQL 16.9** cluster was provisioned from the official EDB binaries:

- Cluster: `127.0.0.1:55432`, dedicated data dir, trust auth, localhost-only. Never a production/unknown database.
- Databases: `b2b_test` (primary) + `b2b_shadow` (drift replay).
- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_test`, `SHADOW_DATABASE_URL=…/b2b_shadow`.

All migrate/seed/drift/constraint/concurrency checks below ran against this real server.

## Migration

- Name: `20260614120000_database_gate_integrity_fixes`
- File: `packages/database/prisma/migrations/20260614120000_database_gate_integrity_fixes/migration.sql`
- SHA-256: `d53f5c52143efc14bd90c00860c3b84b2cd092892f03b5c3d60fbe6b13ef23c3`
- The committed history was **not** rewritten; this is a forward-only migration appended after `20260614000000_init`.

## Findings → fixes

### DBF-001 — BLOCKER — Real PostgreSQL validation not completed
**Closed.** Provisioned real PostgreSQL 16.9 and executed the full sequence on it:

| Step | Result |
| --- | --- |
| Empty-DB `migrate deploy` (init + integrity) | applied 2 migrations |
| `migrate deploy` again | `No pending migrations to apply.` |
| Drift gate (`db:drift`) | `✓ No schema/migration drift (5 allowlisted, 0 unexpected)` |
| Seed (1st) | `Seed completed (idempotent).` |
| Seed (2nd) | `Seed completed (idempotent).` (no duplicates) |
| Catalog verification (`db:verify-catalog`) | `✓ all required triggers, partial unique indexes, CHECK constraints, non-cascading FKs and columns present` |
| DB integration suite (`test:integration:db` / `test:database-gate`) | **72/72 passed, 0 skipped** |
| Clean-second-DB replay (scratch DB in `catalog-gate.test.ts`) | migrations replay + catalog probe pass |

### DBF-002 — CRITICAL — DB tests could fake-pass by skipping
**Closed.** Replaced conditional self-skip with a fail-closed gate runner.

- `scripts/db-test-gate.mjs` refuses to "pass" unless real tests ran: no/unreachable `DATABASE_URL` → exit 1; 0 tests collected → exit 1; any skipped/pending test → exit 1 (vitest treats all-skipped as success; the wrapper does not, via `scripts/gate-eval.mjs`).
- In CI, skip-bypass vars (`ALLOW_DB_TEST_SKIP`, `CI_SKIP_DB_TESTS`, …) are rejected (exit 1).
- `--allow-local-skip` permits a **local-only** skip solely when `ALLOW_DB_TEST_SKIP=true`, not in CI, and the DB is unreachable — and it still prints `DB TESTS NOT EXECUTED` so a skip can never read as a gate pass.
- Removed every `describe.skipIf(!dbConfigured)` and the `dbConfigured` helper; suites no longer self-skip.
- `scripts/check-no-skipped-tests.mjs` now also bans `skipIf`/`runIf`.
- New commands: `test:unit`, `test:integration:api`, `test:integration:db`, `test:database-gate`.

Demonstrated live: no `DATABASE_URL` → exit 1; unreachable URL → exit 1; CI+bypass → exit 1; empty/all-skipped report → exit 1; local skip → exit 0 with loud warning. Covered by `test/unit/db-gate.test.ts` (10 tests).

### DBF-003 — HIGH — Immutable parents deletable / cascading history
**Closed.**
- New `prevent_delete()` trigger (DELETE-only; status UPDATE still allowed) on `orders`, `stock_transfers`, `returns`, `invoices`, `quotes`, `import_jobs`, `export_jobs`, `outbox_events`, `effect_receipts`, `stock_reservations`, `job_logs`, and master `users`.
- Append-only `prevent_mutation()` (UPDATE+DELETE) retained for `payments`, `audit_logs`, `stock_ledger`, all `*_status_history`, `order_price_overrides`, `import_job_errors`.
- Every transaction parent→child FK changed from `ON DELETE CASCADE` to `ON DELETE RESTRICT` (order/transfer/return/invoice/quote status-history, items, price overrides, import rows/errors) — in both `schema.prisma` and the migration.
- A numbered/issued invoice with payment + items + status history cannot be deleted by any FK path; user/company hard delete is blocked/restricted and does not cascade.
- Tests: `test/integration/integrity.test.ts` (8 tests) — order/invoice/transfer/return delete rejected, payment delete rejected, user delete rejected (no cascade), company delete restricted, children preserved, valid status UPDATE still works.

### DBF-004 — HIGH — Customer default address uniqueness missing
**Closed.** Partial unique index `customer_addresses_default_per_type_key` on `(customer_id, type) WHERE is_default = TRUE AND deleted_at IS NULL`. Tests: `test/integration/customer-default-address.test.ts` (5 tests) including a concurrent-insert race (exactly one wins) and soft-delete replacement. `DATABASE_DESIGN.md §8` already matched; no conflict.

### DBF-005 — HIGH — Import duplicate policy not enforced
**Closed.** Added `import_jobs.company_id` (FK→companies RESTRICT) plus `replay_of_import_id` (self-FK RESTRICT), `attempt_number`, `resumed_from_row`, `lease_expires_at`, `heartbeat_at`. Partial unique index `import_jobs_active_checksum_key` on `(company_id, file_checksum_sha256) WHERE status IN ('UPLOADED','VALIDATING','VALIDATED','IMPORTING')`. Reconciled `DATABASE_DESIGN.md §13` to this canonical `(company_id, checksum)` active-only policy. Tests: `test/integration/import-duplicate.test.ts` (6 tests) — two active duplicates rejected, terminal→replay allowed and linked, row idempotency key not reusable, concurrent upload race.

### DBF-006 — MEDIUM — Effect receipt FK / state model
**Closed.**
- `effect_receipts.outbox_event_id` `BIGINT NOT NULL` FK→`outbox_events` `ON DELETE RESTRICT` (one outbox event → many effects).
- `output_file_id` now a real FK→`files` `ON DELETE SET NULL` (the original DBF-006 gap).
- New `UNIQUE (effect_type, provider_idempotency_key)` (provider-call dedup) alongside existing `UNIQUE (effect_type, effect_key)`.
- New `completed_at` column + CHECK constraints: `status='SUCCEEDED' ⇒ completed_at NOT NULL`, `status='PLANNED' ⇒ completed_at NULL`. Invalid `status` already rejected by the enum.
- `DATABASE_DESIGN.md §14` and `ADR-008` updated to match. Tests: `test/integration/effect-receipt.test.ts` (8 tests) — non-existent outbox FK rejected, outbox delete does not cascade receipts, duplicate effect key / provider key rejected, both CHECK violations rejected, valid PLANNED→SUCCEEDED transition accepted, invalid enum rejected.

### DBF-007 — MEDIUM — Trigger functions not search_path hardened, drift fragility
**Closed.** `set_updated_at()`, `prevent_mutation()`, `prevent_delete()` recreated with `SET search_path = pg_catalog, public`. Drift gate reworked to the "right source" approach:
- `check-drift.mjs` (logic in `scripts/drift-eval.mjs`) uses `prisma migrate diff --script` and an **exact** allowlist of the 5 soft-delete partial-unique fingerprints; **any** other statement (missing column, missing/renamed FK, changed onDelete, unexpected index) fails with exit 1. (The init migration's name-preserving partial-unique trick did not actually fool `migrate diff` — the committed baseline drift gate was in fact failing; the allowlist makes it correct and strict.)
- `scripts/verify-catalog.mjs` asserts, against live `pg_catalog`, the presence of every required trigger, partial unique index (with predicate), CHECK constraint, non-cascading FK and column.
- Drift detection is itself tested: `test/unit/drift-eval.test.ts` proves missing column / FK / unexpected index / changed allowlisted index are flagged; `test/integration/catalog-gate.test.ts` builds a scratch DB and proves a dropped trigger / partial index / CHECK / FK / column are all caught.

### DBF-008 — MEDIUM — RBAC protected permission policy (doc consistency)
**Not changed in this gate (out of scope: no auth/RBAC service work).** This is a service-layer grant-ceiling concern; the DB seed/catalog already match the PERMISSION_MATRIX note and persistence cannot enforce the actor ceiling alone. Flagged as the first item for the Auth Foundation milestone (see Recommendation).

### DBF-009 — MEDIUM — Invoice status/number invariants
**Partially addressed.** Numbered/issued invoices are now delete-proof (DBF-003). Full status/number-consistency CHECKs are deferred to the invoice-issue service with transaction-level tests (explicitly a business-service responsibility); not introduced here to avoid blocking legitimate DRAFT lifecycles. Documented as residual risk.

### DBF-010 — LOW — PK convention (`BIGSERIAL` vs identity)
**Closed by explicit decision.** `DATABASE_DESIGN.md §17` now records that `BIGSERIAL` is accepted for Prisma-managed surrogate keys (distinct from legal invoice numbering, which uses the `invoice_series` counter, not a sequence).

### DBF-011 — LOW — Prisma client lifecycle comment
**Not changed (out of scope: no client refactor required for the DB gate).** Cosmetic comment; noted as residual.

## Schema models changed

- `EffectReceipt`: + `outboxEventId` (FK), `completedAt`, real `outputFile` FK, `@@unique([effectType, providerIdempotencyKey])`, `@@index([outboxEventId])`.
- `OutboxEvent`: + `effects EffectReceipt[]` back-relation.
- `ImportJob`: + `companyId` (FK), `replayOfImportId` (self-FK), `attemptNumber`, `resumedFromRow`, `leaseExpiresAt`, `heartbeatAt`, indexes.
- `Company`: + `importJobs` back-relation. `File`: + `effectReceipts` back-relation.
- Cascade→Restrict on: `OrderStatusHistory`, `OrderPriceOverride` (order + item), `StockTransferItem`, `TransferStatusHistory`, `ReturnItem`, `ReturnStatusHistory`, `InvoiceItem`, `InvoiceStatusHistory`, `QuoteItem`, `ImportRow`, `ImportJobError`.

## Commands run (real)

`pnpm install --frozen-lockfile`, `format:check`, `lint`, `typecheck`, `test:unit`, `test:integration:api`, `build`, `check:no-skip`, `check:secrets`, `check:boundaries`, `check:docs` — all pass.
`prisma format`/`validate`/`generate`, `migrate deploy` ×2, `db:seed` ×2, `db:drift`, `db:verify-catalog`, `test:integration:db`, `test:database-gate` — all pass on real PostgreSQL 16.9. Docker not available (compose config not run).

## Evidence

- `test:database-gate` → `✓ Database gate: 72/72 real PostgreSQL tests executed, 0 skipped.`
- The slower fsync-on run (612 s) and the fast fsync-off run (29.5 s) both reported 72/72, 0 skipped.
- No GitHub Actions run: there is no usable remote push path / `gh` in this environment, so Path A/B were not possible. CI workflow (`.github/workflows/ci.yml`) is updated to enforce the gate on the next push.

## Residual risk / open items

1. **DBF-008 (RBAC grant ceiling)** — must be implemented in the Auth Foundation service layer before role-assignment endpoints ship. DB persistence cannot enforce it.
2. **DBF-009 (invoice status/number CHECKs)** — deferred to the invoice-issue service with transaction tests.
3. **DBF-011** — stale lifecycle comment in `client.ts`; cosmetic.
4. **CI not yet executed remotely** — the database job is defined and green locally; it must run on the next push to a GitHub remote.

## Closure

Real-PostgreSQL database gate is green locally (72/72, fail-closed). Items 1–7 and 10 of the remediation are complete and validated on real PostgreSQL 16.9. Auth Foundation should not start until DBF-008 is resolved in the service layer and the CI database job has run green on a remote.
