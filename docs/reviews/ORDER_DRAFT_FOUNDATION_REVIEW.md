# Order Draft Foundation Review

Commit: `b9c72383616710c5732d561bdcc8cbdb6cb0c296`

Result: `REJECTED`

## Blocking Finding

1. Concurrent `PATCH /orders/:id` can mutate an order after it has been cancelled.

   `OrdersService.update` resolves the order and checks `existing.status !== 'DRAFT'`
   before opening the write transaction (`apps/api/src/modules/orders/orders.service.ts:153`).
   The actual write path then calls `OrderRepository.updateOrder`, whose DB update is
   keyed only by internal `id` (`apps/api/src/modules/orders/order.repository.ts:284`)
   and is not conditional on `status = 'DRAFT'`. If a concurrent cancel transitions the
   row after the pre-check but before the update transaction, the update can still
   replace items/note/customer/warehouse on a `CANCELLED` order and write
   `ORDER_UPDATED` audit for that post-cancel mutation.

   Cancel correctly uses an expected-state write (`updateMany({ id, status: 'DRAFT' })`
   at `apps/api/src/modules/orders/order.repository.ts:320`), but update lacks the same
   concurrency guard. The current test only covers the sequential case where the order is
   already cancelled before PATCH starts (`apps/api/test/integration/orders.test.ts:412`).
   This violates the DRAFT-only update invariant.

## Verified

- Order and OrderItem carry `company_id`; customer, warehouse, order and product links are pinned by composite FKs.
- `companyId` and client price/tax/total fields are not DTO fields and are rejected by the global strict ValidationPipe.
- Actor company is read from PostgreSQL principal resolution; forged JWT company/customer/warehouse/product claims do not change access.
- Cross-company customer/product/warehouse on create and cross-company get/update/cancel are hidden as 404.
- Warehouse scope is applied on create, get, list, update and cancel; `warehouse:scope:all` is DB-sourced and same-company only.
- Controller uses the global `JwtAuthGuard -> PermissionGuard` chain and declares only route permissions.
- Scope stayed within DRAFT create/update/list/detail/cancel; no approve, stock ledger, balance, reservation or invoice behavior was added.
- Server pricing uses product list price, tax rate and currency; mixed currencies are rejected and line VAT is floored.
- Quantity validation rejects zero, negative, decimal, empty and over-PostgreSQL-BIGINT strings with 400.
- Create/cancel status history is append-only, and create/update/cancel audit writes are inside the mutation transaction.
- RFC7807 + requestId and non-empty OpenAPI response schemas are preserved.
- Drift/verify-catalog cover order/customer/warehouse/product composite FKs, order/order_item company columns and customer code partial unique.

## Test Evidence

- Focused API integration: 199/199 passed.
- PermissionGuard unit: 22/22 passed.
- Focused DB integration: 54/54 passed.
- Full API gate: 342/342 real PostgreSQL tests executed, 0 skipped.
- Full DB gate: 133/133 real PostgreSQL tests executed, 0 skipped.
- Clean DB `migrate deploy`: passed.
- Second `migrate deploy`: no pending migrations.
- `seed` twice: passed and idempotent.
- Prisma validate/generate: passed.
- Drift: passed.
- Verify catalog: passed.
- Typecheck: passed.
- Lint: passed.
- Format check: passed.
- Build: passed.
- No-skip check: passed.
- Boundary check: passed.
