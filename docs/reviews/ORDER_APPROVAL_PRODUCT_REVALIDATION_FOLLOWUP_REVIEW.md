# Order Approval Product Revalidation Follow-up Review

Date: 2026-06-18

Commit reviewed: `0c08d4ef40fef55daacd47f311e1392d27f718ba`

Scope: review only. Production code was not changed. I inspected the requested
prior review and order approval files, the commit diff, product lifecycle
locking, rollback behavior, regression surface, and the full requested test/gate
set against real PostgreSQL.

Result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Findings

No blocking findings.

1. Non-blocking: the committed concurrent product-deactivate-vs-approve test is
   real PostgreSQL, but its branch logic can false-green against the old bug
   because it infers "approve won" only from `approveRes.status === 200`. The
   deterministic inactive/soft-delete tests do catch the original blocker, and I
   separately verified the lock behavior with a raw PostgreSQL probe:
   `FOR SHARE` blocked both `is_active` update and `deleted_at` update, while
   remaining compatible with `FOR KEY SHARE`.

2. Non-blocking: comments in `orders.service.ts` still say the product rows are
   locked `FOR UPDATE`, while the repository correctly uses `FOR SHARE`. The
   implementation is the important part and is correct; this is only comment
   drift.

## Validation Matrix

| # | Check | Result |
| --- | --- | --- |
| 1 | Approve transaction revalidates order item products | PASS: `assertOrderProductsStillActive` is called inside the approve transaction before reservation. |
| 2 | Product `companyId` equals order/actor company | PASS: service rechecks `product.companyId !== actor.companyId`; DB composite FKs also pin order item product tenant. |
| 3 | Product `isActive = true` checked | PASS. |
| 4 | Product `deletedAt IS NULL` checked | PASS. |
| 5 | Revalidation happens before balance lock/reservation write | PASS: revalidation is before `findReservationLines` and `stock.reserve`. |
| 6 | Inactive product approve returns 422 RFC7807 | PASS: targeted test asserts 422 and `BUSINESS_RULE`; global filter maps 422 to problem+json. |
| 7 | Soft-deleted product approve returns 422 RFC7807 | PASS. |
| 8 | Failed approve leaves order DRAFT | PASS. |
| 9 | Failed approve leaves reserved stock unchanged | PASS. |
| 10 | Failed approve writes no `stock_reservations` | PASS. |
| 11 | Failed approve writes no `ORDER_APPROVED` audit | PASS. |
| 12 | Failed approve writes no APPROVED status history | PASS. |
| 13 | Multi-item order with one inactive product reserves no item | PASS. |
| 14 | Concurrent product inactive/delete vs approve race is safe | PASS by lock analysis and raw lock probe; test is real PostgreSQL but noted above as weak. |
| 15 | No successful reservation is created for product already inactive/deleted at approve | PASS. |
| 16 | `FOR SHARE` serializes deactivate/soft-delete update | PASS: PostgreSQL probe showed update timeout while `FOR SHARE` was held. |
| 17 | `FOR SHARE` avoids FK-parent deadlock with stock adjust/transfer | PASS: `FOR KEY SHARE` is compatible; stock transfer deadlock regressions remain green. |
| 18 | Existing approve + stock decrease/transfer concurrency tests unchanged | PASS. |
| 19 | Successful approve behavior unchanged | PASS. |
| 20 | Draft create/update/cancel, pricing, stock adjust/transfer, RBAC, warehouse scope, migration behavior untouched | PASS by diff inspection and regression gates. |

## Code Evidence

- `apps/api/src/modules/orders/orders.service.ts:295` updates DRAFT to APPROVED
  inside the transaction, then `:306` calls product revalidation before
  `:310-311` reservation line read and `stock.reserve`.
- `apps/api/src/modules/orders/orders.service.ts:527` checks each locked product
  for company, active state and non-deleted state; `:535` throws 422.
- `apps/api/src/modules/orders/order.repository.ts:397` locks the backing
  products with `FOR SHARE`; `:416` reads reservation lines only after that.
- `apps/api/test/integration/order-approval.test.ts:615`, `:647`, and `:676`
  cover inactive, soft-deleted, and multi-item all-or-nothing failures.

## Lock Review

- Product inactive and soft-delete operations are `UPDATE products SET
  is_active = false` / `deleted_at = now()`, i.e. non-key updates. PostgreSQL
  takes `FOR NO KEY UPDATE`, which conflicts with `FOR SHARE`.
- The approve transaction holds the `FOR SHARE` product locks until commit, so a
  product cannot change lifecycle state between revalidation and reservation
  write.
- `FOR SHARE` is compatible with `FOR KEY SHARE`, the lock mode FK checks use on
  parent rows. This avoids the cycle that `FOR UPDATE` could create with stock
  operations that already hold a stock balance row.
- Raw probe result on the review PostgreSQL DB:
  `{"updateBlocked":true,"softDeleteBlocked":true,"keyShareCompatible":true}`.

## Test Evidence

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_order_approval_product_revalidation_review_test_20260617?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_order_approval_product_revalidation_review_shadow_20260617?schema=public`

| Command | Result |
| --- | --- |
| Clean DB `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 17 migrations applied |
| Second `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, stable counts: 65 permissions, 6 roles, 210 role permissions |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| Order approval integration | PASS, 29/29 |
| Order draft + order OpenAPI integration | PASS, 40/40 |
| Stock adjustment/transfer + OpenAPI integration | PASS, 64/64 |
| Product/customer/warehouse + OpenAPI integration | PASS, 83/83 |
| Warehouse scope domain test | PASS, 9/9 |
| Warehouse scope DB integration | PASS, 12/12 |
| Warehouse scope API integration | PASS, 12/12 |
| Full API gate `pnpm.cmd test:integration:api` | PASS, 374/374 real PostgreSQL tests, 0 skipped |
| Full DB gate `pnpm.cmd test:database-gate` | PASS, 133/133 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd typecheck` | PASS, 18/18 Turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd build` | PASS, 10/10 Turbo tasks |
| Raw PostgreSQL lock probe | PASS, update/soft-delete blocked; key-share compatible |

## Final Gate

**APPROVED_WITH_NON_BLOCKING_NOTES**
