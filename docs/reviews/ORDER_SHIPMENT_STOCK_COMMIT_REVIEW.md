# Order Shipment / Stock Commit Foundation Review

Date: 2026-06-18

Commit reviewed: `f3a2cbf`

Scope: review only of the Order Shipment / Stock Commit Foundation commit.
Production code was not changed. I inspected the requested order/inventory rules
and database design documents, prior order approval and stock ledger reviews, the
`20260617150000_order_shipment_foundation` migration, Prisma `Order`,
`OrderItem`, `OrderShipment`, `StockBalance`, `StockReservation`, and
`StockLedger` models, Orders and Inventory modules, order shipment integration
tests, and order OpenAPI tests. I also checked the commit diff for accidental
invoice, return, or frontend changes.

Result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Findings

No blocking findings. None of the mandatory reject conditions were hit:
duplicate shipment/ledger was not possible in reviewed flows, failed shipment
paths rolled back, `reserved` and `on_hand` were updated correctly, warehouse
scope checks held, full real PostgreSQL API/DB gates ran with 0 skipped tests,
and the commit did not touch invoice, return, or frontend scope.

## Validation Matrix

| # | Validation | Result |
| --- | --- | --- |
| 1 | `POST /api/v1/orders/:id/ship` only works for `APPROVED` orders | PASS: service pre-checks and row-lock rechecks `APPROVED`; shipment uses expected-status update. |
| 2 | `DRAFT`/`CANCELLED` ship returns 409 | PASS: integration tests cover both states. |
| 3 | Already `SHIPPED` order with a different idempotency key returns 409 | PASS: service rejects pre-transaction and after row-lock recheck. |
| 4 | Same idempotency key replay does not duplicate shipment/ledger/reservation consume | PASS: replay re-reads the existing shipment/order; tests verify one shipment, one consumed reservation, and one ledger movement. |
| 5 | Same idempotency key for different order/payload returns 409 | PASS: `(company_id, idempotency_key)` shipment lookup rejects a different order. The ship endpoint has no request payload body. |
| 6 | Shipment sets order status to `SHIPPED` | PASS: `shipIfApproved` transitions the row and tests assert response/DB state. |
| 7 | `Order.shippedAt` is set | PASS: migration/schema add `shipped_at`; repository sets it with the shipment timestamp. |
| 8 | Missing `ACTIVE` reservation returns 409 and rolls back | PASS: test verifies order remains `APPROVED` and no shipment/ledger/balance change remains. |
| 9 | `reserved < quantity` returns 409 and rolls back | PASS: checked under locked balance before writes; test verifies no partial commit. |
| 10 | `on_hand < quantity` returns 409 and rolls back | PASS: checked under locked balance before writes; test verifies no partial commit. |
| 11 | Shipment decreases `reserved` | PASS: `shipBalance` decrements `reserved` by quantity and tests assert balance. |
| 12 | Shipment decreases `on_hand` | PASS: `shipBalance` decrements `on_hand` by quantity and tests assert balance. |
| 13 | Reservation status changes `ACTIVE -> CONSUMED` | PASS: conditional `consumeReservation` update and tests cover consumed status/timestamp. |
| 14 | One negative `stock_ledger` movement per order item | PASS: shipment movement writes `changeType=SHIPMENT` and negative quantity per line; tests cover multi-line counts. |
| 15 | Ledger reference fields bind order/shipment correctly | PASS: `referenceType=ORDER_SHIPMENT`, `referenceId=orderId`, `referenceLineId=orderItemId`; tests assert the mapping. |
| 16 | Ledger update/delete immutability remains protected | PASS: existing DB trigger/tests reject UPDATE and DELETE. |
| 17 | Shipment record update/delete is immutable | PASS: `order_shipments` has an append-only trigger; raw DB probe rejected UPDATE and DELETE. |
| 18 | One shipment per order is enforced at DB level | PASS: migration adds unique `order_id`; raw DB probe rejected a second shipment. |
| 19 | Balance update, reservation consume, ledger insert, shipment record, status history, and audit are in one transaction | PASS: one `prisma.transaction` wraps every step and passes the same `tx` to stock and audit writes. |
| 20 | Failed ship leaves no audit/history/ledger/shipment/balance changes | PASS: committed tests cover missing reservation, short reserved/on-hand, inactive product/warehouse, and explicit failed-side-effect assertions. |
| 21 | Product inactive/deleted at ship time fails | PASS: products are revalidated under lock inside the transaction; tests return 422 and leave no stock commit. |
| 22 | Warehouse inactive/deleted at ship time fails | PASS: warehouse scope/revalidation fail closed; tests verify no stock commit. |
| 23 | Missing warehouse scope is object-policy safe | PASS: order is hidden/denied before mutation; tests cover no-scope behavior. |
| 24 | Explicit warehouse scope allows ship | PASS: integration test covers explicit scoped success. |
| 25 | `warehouse:scope:all` only applies within the same company | PASS: tests cover same-company allow and cross-company deny. |
| 26 | Cross-company order ship is hidden with 404 | PASS: company-scoped order resolution and integration tests cover this. |
| 27 | Forged JWT company/warehouse/product claims do not change the result | PASS: auth context is DB-derived; forged-claim tests remain denied. |
| 28 | Concurrent same-order ship does not duplicate ledger/consume | PASS: concurrent distinct-key test yields one success, one 409, and one stock commit. |
| 29 | Concurrent same-key ship is one commit plus replay | PASS: concurrent same-key test verifies identical response shape and no duplicate rows. |
| 30 | Concurrent ship plus stock decrease/transfer has no lost update | PASS: committed stock decrease test passed; additional real-DB Vitest probe for ship plus transfer-out on the same balance also passed. |
| 31 | Row lock order closes practical deadlock risk | PASS: order row is locked before balances; shipment balance locks are sorted by product id; stock transfer tests also cover opposite-direction deadlock behavior. |
| 32 | Existing approve reservation tests are not broken | PASS: targeted order approval integration tests passed. |
| 33 | Existing draft/cancel/update tests are not broken | PASS: existing orders integration tests passed. |
| 34 | Stock adjustment/transfer tests are not broken | PASS: targeted stock adjustment and transfer tests passed. |
| 35 | Invoice/return/frontend scope was not touched | PASS: commit diff did not include invoice, return, or frontend files. |
| 36 | OpenAPI ship response schema is non-empty | PASS: order OpenAPI tests verify `/orders/{id}/ship` references `OrderResponse`, including `shippedAt`. |
| 37 | Full API/DB gate is green on real PostgreSQL with no skipped tests | PASS: full API gate ran 404/404 tests, full DB gate ran 133/133 tests, 0 skipped. |

## Risk Checks

- `order_shipments` is intentionally one-record-per-order in this foundation.
  That matches the requested one-shipment invariant. Future partial shipment,
  invoice, or return workflows will need additive design, but this commit did
  not create invoice/return side effects or touch frontend scope.
- Shipment idempotency replay response is compatible with the first successful
  response: create and replay both map through the normal `OrderResponse` view,
  and same-key concurrent tests assert equality.
- P2002 handling separates replay from conflict correctly: if the winning row is
  found for the same company/key/order, it replays; otherwise it returns a
  conflict. Duplicate `(order_id)` with a different key is therefore not replayed.
- If the transaction sees `SHIPPED` after taking the order row lock, same-key
  replay is safe because it re-reads the shipment by order id and compares the
  idempotency key before returning the order.
- `ORDER_SHIPMENT:{orderId}:{orderItemId}` is a stable per-line ledger
  idempotency key. The unique ledger key prevents a duplicate physical movement;
  a duplicate insert aborts the transaction before replay/conflict handling.
- Product and warehouse lifecycle revalidation happens before stock commit. The
  shipment flow locks the order first, revalidates products/warehouse, then locks
  balance rows in deterministic product-id order.
- `reserved <= on_hand` is not transiently violated during shipment because
  `shipBalance` decrements `on_hand` and `reserved` by the same quantity in a
  single UPDATE after both values are checked under `FOR UPDATE`.
- Multi-item shipment is all-or-nothing: pass 1 validates all active
  reservations and locked balances before pass 2 writes; any throw rolls back the
  whole transaction.
- Missing or already-consumed reservation fails closed with 409 and leaves no
  partial shipment, ledger, audit, history, or balance mutation.

## Tests Run

Environment:

- PostgreSQL: 16.9 via local `.pgtest` server
- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_order_shipment_review_test_20260618?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_order_shipment_review_shadow_test_20260618?schema=public`

| Command / Gate | Result |
| --- | --- |
| Clean DB `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 18 migrations applied including `20260617150000_order_shipment_foundation` |
| Second `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable: 65 permissions, 6 roles, 210 role permissions, 1 company, 1 warehouse, 1 invoice series |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| Order shipment integration tests | PASS in targeted API integration group |
| Order approval integration tests | PASS in targeted API integration group |
| Existing order draft/cancel/update tests | PASS in targeted API integration group |
| Order OpenAPI tests | PASS in targeted API integration group |
| Stock adjustment tests | PASS in targeted API integration group |
| Stock transfer tests | PASS in targeted API integration group |
| Product/customer/warehouse tests | PASS in targeted API integration group |
| Warehouse scope tests | PASS in targeted API/DB integration groups |
| PermissionGuard unit tests | PASS, 22/22 |
| Tenant isolation tests | PASS in targeted API/DB integration groups |
| Grant ceiling tests | PASS in targeted API integration group |
| Authz cache version tests | PASS in targeted API/DB integration groups |
| Targeted API integration group | PASS, 18 files, 292/292 tests |
| Targeted DB integration group | PASS, 10 files, 71/71 tests |
| Raw DB `order_shipments` immutability/uniqueness probe | PASS |
| Additional ship plus transfer-out concurrency probe | PASS, 1/1 real PostgreSQL integration test |
| Full API gate `pnpm.cmd test:integration:api` | PASS, 32 files, 404/404 tests, 0 skipped |
| Full DB gate `pnpm.cmd test:database-gate` | PASS, 20 files, 133/133 tests, 0 skipped |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |

## Non-Blocking Notes

1. The requested `docs/architecture/ORDER_RULES.md` and
   `docs/architecture/INVENTORY_RULES.md` paths do not exist in this tree. The
   active files reviewed are `docs/business-rules/ORDER_RULES.md` and
   `docs/business-rules/INVENTORY_RULES.md`.
2. The current business/design docs still contain older `PREPARING -> SHIPPED`
   wording, while this commit and review scope implement the requested
   `APPROVED -> SHIPPED` foundation. This is documentation drift, not a blocker
   for the reviewed commit.
