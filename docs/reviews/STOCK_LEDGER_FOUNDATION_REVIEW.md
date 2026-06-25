# Stock Ledger Foundation Review

Date: 2026-06-17

Commit reviewed: `2ade6d1324dfa8d9979a91245e1a5af7c14ff09f`

Scope: review only of the Stock Ledger Foundation commit. Production code was not
changed. This review inspected the requested architecture/rules/API convention
docs, previous foundation reviews, inventory source, stock DTOs/response DTOs,
contracts, Prisma stock models/migrations, WarehouseScopeService, stock/API/DB
tests, generated OpenAPI, and the requested regression gates against real
PostgreSQL.

Result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Findings

No blocking findings. None of the mandatory reject conditions were hit:
Product does not store stock quantity, real PostgreSQL/API tests were not
skipped, ledger UPDATE/DELETE is rejected by the DB, concurrent stock mutations
did not lose updates or race negative, warehouse scope is enforced, and
idempotency did not create duplicate movements.

## Validation Matrix

| # | Validation | Result |
| --- | --- | --- |
| 1 | Product stores no stock quantity | PASS: Product has only `criticalStockThreshold`; on-hand/reserved are in `stock_balances`. |
| 2 | Every stock adjustment appends `stock_ledger` | PASS: adjustment transaction always calls `insertAdjustmentMovement`; API tests verify movement count/visibility. |
| 3 | `stock_balances` is current balance | PASS: balance row is locked and updated in the adjustment transaction. |
| 4 | Balance update + ledger insert + audit same transaction | PASS: one `prisma.transaction` wraps lock, update, ledger create, and `AuditWriter.write(tx, ...)`. |
| 5 | `SELECT ... FOR UPDATE` row lock | PASS: `lockBalanceOnHand` performs lazy insert then `SELECT "on_hand" ... FOR UPDATE`. |
| 6 | Concurrent INCREASE lost update | PASS: API test runs 6 parallel increases from absent balance; final on-hand and ledger count match. |
| 7 | Concurrent DECREASE negative race | PASS: API test starts at 30 and runs 5 parallel decreases; exactly 3 succeed, 2 return 409, final on-hand is 0. |
| 8 | Final balance cannot be negative | PASS: service rejects negative result and DB CHECK remains in place. |
| 9 | DB CHECK `on_hand >= 0` | PASS: migration/catalog verification and DB inventory tests cover non-negative and reserved constraints. |
| 10 | `stock_ledger` update/delete rejected | PASS: DB trigger exists and API/DB tests reject UPDATE and DELETE. |
| 11 | Product/Warehouse resolved in actor company | PASS: repository resolves active product/warehouse by `actor.companyId`; auth guard builds company from DB. |
| 12 | Product inactive/deleted rejected | PASS: stock API test returns 404 for inactive and soft-deleted products. |
| 13 | Warehouse inactive/deleted rejected | PASS: stock API test returns 404 for inactive and soft-deleted warehouses. |
| 14 | Warehouse scope mandatory | PASS: base stock permission without scope returns empty list and adjustment 403. |
| 15 | `warehouse:scope:all` same company only | PASS: stock, warehouse-scope API, DB, and domain tests cover same-company allow and cross-tenant deny. |
| 16 | JWT company/product/warehouse claims not trusted | PASS: JWT guard resolves user/company from DB; forged-claim stock test cannot cross tenant. |
| 17 | Body `companyId` rejected | PASS: strict DTO whitelist returns 400. |
| 18 | Invalid quantity returns 400 RFC7807 | PASS: `0`, negative, decimal, empty, non-numeric, and over-BIGINT values are covered. |
| 19 | Negative DECREASE result returns 409 | PASS: API test returns 409 RFC7807 and leaves balance/ledger unchanged. |
| 20 | `Idempotency-Key` required | PASS: missing header returns 400 before side effects. |
| 21 | Same idempotency key replay no duplicate | PASS: replay returns the same response; ledger count remains 1. |
| 22 | Same key with different payload returns 409 | PASS: test covers quantity mismatch; code compares warehouse, product, signed quantity, and reason. |
| 23 | Concurrent same-key duplicate movement | PASS by DB design/code path: global ledger unique key raises P2002, rolls back the transaction, re-reads the winner, and replays/mismatches. See non-blocking test note. |
| 24 | Tenant collision on global unique key | PASS: ledger key is `ADJUSTMENT:{companyId}:{clientKey}`. |
| 25 | Replay response shape matches first response | PASS: both create and replay map through `toMovementView`; API replay test asserts equality. |
| 26 | `STOCK_ADJUSTED` audit same transaction | PASS: audit writer receives the same tx; test verifies audit row and requestId. |
| 27 | RFC7807 + requestId | PASS: validation/not-found/negative paths preserve problem+json and requestId. |
| 28 | OpenAPI stock schemas non-empty | PASS: stock OpenAPI tests and generated `openapi.json` verify adjustment/balance/movement schemas. |
| 29 | Product/Warehouse/RBAC/scope regressions | PASS: focused regressions plus full API and DB gates passed with 0 skipped tests. |

## Risk Checks

- Signed canonical ledger quantity maps correctly from API `INCREASE`/`DECREASE`
  plus positive quantity: `INCREASE => +qty`, `DECREASE => -qty`, `change_type =
  ADJUSTMENT`.
- `balanceBefore = balanceAfter - signed` is correct for signed ledger rows,
  including negative movements.
- Lazy balance creation is safe: `INSERT ... ON CONFLICT DO NOTHING` converges on
  one `(product_id, warehouse_id)` row, then `SELECT ... FOR UPDATE` serializes
  all balance reads/writes. The concurrent INCREASE test starts from no balance.
- P2002 replay is safe: a duplicate ledger key aborts the whole transaction,
  rolling back any balance update before the service re-reads the winning
  movement.
- Not using `command_idempotency` is acceptable for this single-row stock
  adjustment command because the immutable ledger row is both the idempotency
  record and the replay source. Future multi-row commands should still use
  `command_idempotency`.
- `GET /stock/balances` without scope returns an empty page, matching the safe
  Warehouse API list behavior.
- The requested `docs/architecture/INVENTORY_RULES.md` and
  `docs/architecture/API_CONVENTIONS.md` paths do not exist in this tree; the
  active files are `docs/business-rules/INVENTORY_RULES.md` and
  `docs/API_CONVENTIONS.md`.

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_stock_ledger_review_test_20260617?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_stock_ledger_review_shadow_20260617?schema=public`

| Command | Result |
| --- | --- |
| Create isolated test/shadow databases | PASS |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` on clean DB | PASS, 14 migrations applied |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` second run | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable: 64 permissions, 6 roles, 207 role permissions |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| Stock API integration + Stock OpenAPI tests | PASS, 33/33 real PostgreSQL/API tests |
| DB inventory/ledger immutability tests | PASS, 7/7 real PostgreSQL tests |
| Product, warehouse, warehouse-scope, tenant isolation, grant ceiling, authz cache, PermissionGuard integration regressions | PASS, 106/106 real PostgreSQL/API tests |
| PermissionGuard unit tests | PASS, 22/22 |
| DB warehouse-scope/RBAC/authz-cache regressions | PASS, 26/26 real PostgreSQL tests |
| Domain warehouse-scope/grant-ceiling/RBAC tests | PASS, 34/34 |
| `pnpm.cmd test:integration:api` | PASS, 249/249 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd test:database-gate` | PASS, 125/125 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd --filter @b2b/api openapi:json` with full dummy production env | PASS, generated stock schemas verified |

## Non-Blocking Notes

1. `openapi:json` failed with exit 1 and no useful diagnostic when run in a
   partial production environment because `apps/api/src/openapi.ts` defaults do
   not include every production-required config value (`SMTP_USER`,
   `SMTP_PASSWORD`, `PASSWORD_RESET_DELIVERY_KEY`). With a complete dummy
   production env, the CLI generated `openapi.json` and stock schemas verified.
   This is a gate ergonomics/config-default issue, not a Stock Ledger runtime or
   schema blocker.
2. The committed stock test suite covers sequential same-key replay, different
   payload conflict, concurrent INCREASE, and concurrent DECREASE. It does not
   contain a dedicated concurrent same-key API test. The DB unique + P2002
   rollback/re-read path was reviewed and is sound, but adding that test would
   make the guarantee executable.

## Final Gate

**APPROVED_WITH_NON_BLOCKING_NOTES**
