# Order Approval + Stock Reservation Foundation Review

Date: 2026-06-17

Commit reviewed: `6bb646bd6d630aa3f7dbe0070b2ebf8ce18ce4b6`

Scope: review only. Production code was not changed. I inspected the requested
business rules, database design, previous order/stock reviews, OrdersModule,
Inventory stock service/repository, Prisma order/inventory/catalog/warehouse
models, the order approval integration test, and the commit diff.

Result: **REJECTED**

## Blocking Finding

1. `approve` can reserve stock for a product that was deactivated after the draft
   was created.

   `OrdersService.approve` resolves the order, checks warehouse scope, transitions
   `DRAFT -> APPROVED`, then calls `findReservationLines` and `stock.reserve`
   (`apps/api/src/modules/orders/orders.service.ts:275`). The reservation line
   query selects only `order_item.id`, `product_id`, and `quantity`
   (`apps/api/src/modules/orders/order.repository.ts:378`), and
   `StockService.reserve` only locks the balance and checks
   `available = on_hand - reserved` before inserting `stock_reservations`
   (`apps/api/src/modules/inventory/stock.service.ts:112`). No step re-resolves
   each product with `is_active = true AND deleted_at IS NULL`.

   This violates `ORDER_RULES.md` active-product approve rule and ORD-10:
   a product that is made inactive/soft-deleted while an order is still DRAFT must
   make approve fail with no reservation. The committed tests cover inactive
   product rejection on order create, but not the draft-to-approve lifecycle gap.

   Ad hoc API verification with the normal Vitest integration harness confirmed
   the behavior: after creating a DRAFT order and then setting the product
   `is_active=false`, `POST /api/v1/orders/:id/approve` returned `200` and created
   one `ACTIVE` stock reservation. A warehouse deactivated after draft returned
   `403` and created no reservation, so this blocker is product lifecycle
   revalidation specifically.

## Validation Matrix

| # | Check | Result |
| --- | --- | --- |
| 1 | Approve only works for `DRAFT` | PASS: service pre-checks and row-lock rechecks `status='DRAFT'`. |
| 2 | Approve sets status `APPROVED` | PASS: `approveIfDraft` sets status and approved fields; tests cover response. |
| 3 | Re-approving same order returns 409 | PASS: committed concurrent/sequential tests cover one success then 409. |
| 4 | Cancelled order cannot approve | PASS: committed test returns 409. |
| 5 | Cross-company approve hidden as 404 | PASS: company-scoped order lookup and tests cover this. |
| 6 | No warehouse scope object policy safe | PASS: existing order is hidden as 404 before mutation. |
| 7 | Explicit warehouse scope sufficient | PASS. |
| 8 | `warehouse:scope:all` same-company only | PASS. |
| 9 | Available stock is `on_hand - reserved` under lock | PASS: `lockBalanceForReserve` uses `FOR UPDATE`; reserve computes under lock. |
| 10 | Insufficient stock rolls back all changes | PASS: tests show order remains DRAFT, balance/reservation/history unchanged. |
| 11 | Approve does not decrease `on_hand` | PASS. |
| 12 | Approve writes no physical `stock_ledger` movement | PASS. |
| 13 | Reservation writes canonical `stock_reservations` | PASS. |
| 14 | Duplicate active reservation per order item prevented | PASS: `(order_id, order_item_id)` and idempotency key unique constraints. |
| 15 | Multi-item order reserves all-or-nothing | PASS. |
| 16 | One short item reserves no items | PASS. |
| 17 | Concurrent same-order approve avoids double reserve | PASS. |
| 18 | Concurrent approve + stock decrease cannot exceed available | PASS in committed test. |
| 19 | Concurrent approve + transfer cannot exceed available | PASS in committed test. |
| 20 | Order row expected-status guard + row lock | PASS. |
| 21 | Balance lock order covers lost-update/deadlock risk for this single-warehouse order flow | PASS. |
| 22 | `ORDER_APPROVED` audit same transaction | PASS: audit write is inside approve transaction. |
| 23 | APPROVED history append same transaction | PASS. |
| 24 | Failed approve writes no audit/history | PASS for insufficient-stock failures. |
| 25 | APPROVED order cannot PATCH | PASS. |
| 26 | DRAFT cancel behavior unchanged | PASS. |
| 27 | OpenAPI approve response schema non-empty | PASS. |
| 28 | Product/Customer/Warehouse/Stock/Transfer/RBAC regressions | PASS in targeted and full gates. |

## Risk Notes

- `INVENTORY_RULES.md` says missing/insufficient reserve should be
  `422 INSUFFICIENT_STOCK`, while this task and committed tests use `409`.
  I do not treat that as this commit's blocker because the user story explicitly
  asked for 409 and the API consistently returns 409 for stock conflicts. It is a
  non-blocking documentation/API-convention alignment item after the lifecycle
  blocker is fixed.
- Product price/tax changes after draft do not affect approve because order items
  store server-side snapshots at create/update time. That matches the snapshot
  pricing model.
- Warehouse inactive/deleted after draft does not reserve in the tested inactive
  case: `assertWarehouseScope` re-resolves an active warehouse and denies before
  the transaction.
- Reservation status `ACTIVE/RELEASED/CONSUMED` matches the documented future
  cancel/ship lifecycle.
- Not writing `stock_ledger` on approve is correct because reservation changes
  only `reserved`, not physical `on_hand`.
- Reservation idempotency key `ORDER_RESERVATION:{orderId}:{orderItemId}` is
  safe as a row-level duplicate safety net. Same-order double approve is primarily
  stopped by order row lock + expected-status transition.
- There is no half-state between status update and reservation on ordinary
  failures because status update, reservation, history, and audit run in one
  Prisma transaction.

## Test Evidence

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_order_approval_review_test_20260617?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_order_approval_review_shadow_test_20260617?schema=public`

Commands/results:

| Command | Result |
| --- | --- |
| Clean DB `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 17 migrations applied |
| Second `db:migrate:deploy` | PASS, no pending migrations |
| `db:seed` twice | PASS, idempotent counts: 65 permissions, 6 roles, 210 role permissions |
| `db:validate` | PASS |
| `db:generate` | PASS |
| `db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| `db:verify-catalog` | PASS |
| Targeted API order/stock/product/customer/warehouse/RBAC/OpenAPI regressions | PASS, 273/273 |
| PermissionGuard unit | PASS, 22/22 |
| Domain warehouse-scope/grant-ceiling/RBAC | PASS, 34/34 |
| Focused DB warehouse-scope/tenant/authz regressions | PASS, 31/31 |
| Full API gate `pnpm.cmd test:integration:api` | PASS, 370/370 real PostgreSQL tests, 0 skipped |
| Full DB gate `pnpm.cmd test:database-gate` | PASS, 133/133 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd typecheck` | PASS, 18/18 Turbo tasks |
| `pnpm.cmd build` | PASS, 10/10 Turbo tasks |
| Ad hoc lifecycle verification via temporary Vitest file | PASS as evidence: inactive product after draft still approved/reserved; inactive warehouse after draft denied/no reservation |

## Final Gate

**REJECTED**
