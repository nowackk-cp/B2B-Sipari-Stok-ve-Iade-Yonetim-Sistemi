# Return / Refund Foundation Review

Date: 2026-06-20

Commit reviewed: `5e5fdfc595a80087de72f5da69cf91b2a8b01254`

Scope: review only of the Return / Refund Foundation commit. Production code was
not changed. I inspected the requested return/inventory/invoice/database design
documents, prior invoice and order-shipment reviews, migration
`20260618120000_return_refund_foundation`, Prisma `Return`, `ReturnItem`,
`Order`, `OrderItem`, `Invoice`, `StockBalance`, and `StockLedger`, the Returns
module, OrdersService return cross-module methods, StockService/StockRepository
return movement methods, return integration/OpenAPI tests, and drift/catalog
checks.

Result: **REJECTED**

## Blocking Finding

1. Return approval can restock into a warehouse that becomes inactive after the
   pre-transaction scope check.

   `ReturnsService.approve` checks warehouse access before opening the approval
   transaction (`apps/api/src/modules/returns/returns.service.ts:237`), then
   opens the transaction (`:247`), locks the order/return, and calls
   `stock.receiveReturn` (`:288`). Inside the transaction there is no second
   warehouse lifecycle validation or `FOR SHARE` lock on the warehouse row before
   `on_hand` is increased and `RETURN_IN` ledger rows are inserted. The inventory
   return path locks only `stock_balances` and updates `on_hand`
   (`apps/api/src/modules/inventory/stock.service.ts:253-272`).

   I reproduced this with a temporary integration probe that:
   - raised a return for a shipped order,
   - held the order row `FOR UPDATE`,
   - started `POST /api/v1/returns/:id/approve` and waited until it was blocked
     on the order lock,
   - set the warehouse `is_active=false`,
   - released the lock.

   Expected safe result: 403, return stays `DRAFT`, `on_hand` remains `98`, no
   return ledger. Actual result: approve returned 200, return became `APPROVED`,
   `on_hand` became `99`, and one `RETURN_IN` ledger row was written.

   This violates the requested warehouse inactive/delete race safety and the
   mandatory reject condition for unsafe approve/restock behavior. The existing
   committed test covers only the simpler case where the warehouse is already
   inactive before approve starts.

## Validation Notes

- Create path:
  - Only `SHIPPED` orders and invoiced shipped orders can be returned.
  - `DRAFT`, `APPROVED`, and `CANCELLED` order return create returns 409.
  - Quantity validation rejects 0, negative, decimal, empty, and over-PostgreSQL
    BIGINT values with 400.
  - Create does not change `stock_balances` and writes no `stock_ledger`.
  - Create idempotency key is mandatory; same-key replay does not create a
    duplicate return; same-key different payload returns 409 by tests, and same
    key different order returns 409 by code path.
  - Cross-company create is hidden as 404; missing warehouse scope denies safely;
    explicit scope and same-company `warehouse:scope:all` work.

- Quantity accounting:
  - Create uses shipped order-item quantity, not client/order totals, as the cap.
  - Create counts prior `DRAFT` and `APPROVED` returns, which is conservative
    relative to the current foundation's DRAFT/requested state and prevents
    over-claiming through pending requests.
  - Approve rechecks against other `APPROVED` returns under the order lock, so
    sibling approvals cannot over-return through normal API paths.

- Approve path:
  - Normal approve sets `APPROVED`, increases `on_hand`, does not change
    `reserved`, writes positive `RETURN_IN` ledger rows with return/return-item
    references, and writes audit/history in the same transaction.
  - Same-key approve replay is safe; different-key repeated approve returns 409;
    concurrent same-return approve creates exactly one ledger/restock.
  - Failed over-return approve and multi-item over-return leave no partial
    balance/ledger/audit/status state.
  - Product inactive/deleted after return creation currently still approves and
    restocks, which matches the committed physical-goods interpretation.
  - Warehouse inactive before approve starts fails, but the race above is unsafe.

- Data model and boundaries:
  - `returns` and `return_items` are company-scoped; migration adds composite
    tenant FKs for order/customer/warehouse/product and create/approve idempotency
    uniques.
  - `returns` hard delete remains blocked and `return_status_history` remains
    append-only; `stock_ledger` immutability remains protected.
  - Returns module reads orders through OrdersService and writes stock through
    StockService. I did not find direct order/stock table writes from the returns
    module.
  - Drift passed with 6 allowlisted partial-unique statements and 0 unexpected.
    Catalog verification passed, but it still only explicitly asserts the
    existing return child FK (`return_items_return_id_fkey`) and does not assert
    every new return tenant FK/index. That is a coverage gap to tighten after the
    blocking race is fixed.
  - The untracked `docs/reviews/*.md` files were present before this review and
    are not part of the reviewed commit's production behavior.

## Tests Run

Environment:

- PostgreSQL: 16.9 on `127.0.0.1:55432`
- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_return_review_test_20260620?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_return_review_shadow_20260620?schema=public`

| Command / Gate | Result |
| --- | --- |
| Clean DB `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 20 migrations applied including `20260618120000_return_refund_foundation` |
| Second `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent: 65 permissions, 6 roles, 210 role permissions |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS on isolated rerun; first parallel attempt hit a Windows Prisma DLL rename lock |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 6 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| Return integration tests | PASS, 30/30 |
| Return OpenAPI tests | PASS, 7/7 |
| Temporary warehouse lifecycle race probe | FAIL as expected: reproduced unsafe approve/restock race |
| Targeted order/invoice/stock/product/customer/warehouse/authz API group | PASS, 326/326 |
| PermissionGuard unit tests | PASS, 22/22 |
| Domain warehouse-scope + grant-ceiling tests | PASS, 25/25 |
| Full DB gate `pnpm.cmd test:database-gate` | PASS, 133/133 real PostgreSQL tests, 0 skipped |
| Full API gate `pnpm.cmd test:integration:api` | PASS, 475/475 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |

The previously reported full API gate flake in `stock-transfers.test.ts` did not
reproduce in this run; the full API gate passed cleanly. The rejection is solely
for the Return approve warehouse lifecycle race above.
