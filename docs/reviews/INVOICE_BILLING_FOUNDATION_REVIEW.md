# Invoice / Billing Foundation Review

Date: 2026-06-18

Commit reviewed: `96806bedfb5ada84b7dc7abc66d51bce2d42287d`

Scope: review only of the Invoice / Billing Foundation commit. Production code
was not changed. I inspected the requested database design/API/rules documents,
the prior order-shipment review, migration
`20260618000000_invoice_billing_foundation`, Prisma `Order`, `OrderItem`,
`Invoice`, `InvoiceItem`, and `InvoiceSeries` models, the invoice module,
`OrdersService.getInvoiceableOrder`, `OrdersService.lockOrderForInvoicing`,
invoice integration/OpenAPI tests, and verify-catalog/drift allowlist changes.

Result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Findings

No blocking findings. None of the mandatory reject conditions were hit:
gapless invoice numbers are allocated from a transaction-locked
`invoice_series` row, rollbacks do not burn `next_number`, duplicate active
invoices are blocked, client totals/prices/company ids are rejected, warehouse
scope is enforced, failed invoice creation writes no audit/invoice, order/stock
regressions stayed green, and full real PostgreSQL API/DB gates ran with 0
skipped tests.

## Validation Matrix

| # | Validation | Result |
| --- | --- | --- |
| 1 | Invoice can be created only for `SHIPPED` orders | PASS: service checks `SHIPPED` before and after the order row lock; tests cover success. |
| 2 | `DRAFT` / `APPROVED` / `CANCELLED` invoice create returns 409 | PASS: invoice integration tests cover all three states. |
| 3 | Duplicate active invoice for the same order cannot be created | PASS: service checks active invoice, transaction rechecks under order lock, and DB partial unique enforces `(company_id, order_id) WHERE status <> 'VOID'`. |
| 4 | `Idempotency-Key` is mandatory | PASS: missing header returns 400 before side effects. |
| 5 | Same key + same order replay is safe | PASS: replay returns the existing invoice; tests verify one invoice. |
| 6 | Same key + different order returns 409 | PASS: `(company_id, idempotency_key)` lookup rejects key reuse for another order. |
| 7 | Same order + different key returns 409 | PASS: active invoice guard rejects the second request. |
| 8 | Gapless invoice number is generated without a PostgreSQL sequence | PASS: legal number comes from `invoice_series.next_number`; migration adds no invoice-number sequence and live catalog query found none. |
| 9 | Invoice series row is locked `FOR UPDATE` | PASS: repository uses `SELECT ... FROM invoice_series ... FOR UPDATE` before reading `next_number`. |
| 10 | Transaction rollback does not burn an invoice number | PASS: API and DB tests force rollback after allocation and verify the next successful invoice gets the contiguous number. |
| 11 | Concurrent invoice create does not duplicate or gap numbers | PASS: concurrent different-order test produced `[1,2,3,4]`; DB gate also tests concurrent row-lock allocation. |
| 12 | Invoice header, items, number allocation, status history, and audit are one transaction | PASS: one `prisma.transaction` wraps order lock, series bump, invoice/items create, history, and `INVOICE_ISSUED` audit. |
| 13 | Invoice totals equal order totals | PASS: invoice totals copy the shipped order totals; multi-line test asserts subtotal/VAT/total equality. |
| 14 | Invoice items are copied from order-item snapshots | PASS: line description, product, quantity, unit price, VAT rate, and line amounts copy from the order snapshot. |
| 15 | Client total/price/companyId body fields return 400 | PASS: empty command DTO plus strict pipe rejects `total`, `unitPrice`, `companyId`, and `status`. |
| 16 | Cross-company order/invoice access is hidden as 404 | PASS: order and invoice lookups are company-scoped; tests cover create/get. |
| 17 | JWT company/order/invoice claims are not trusted | PASS: principal and scope are resolved from PostgreSQL; forged-claim test stays denied. |
| 18 | Warehouse scope applies to list/detail/create | PASS: create checks object scope and permission scope; list filters by resolved warehouse access; detail checks object scope. |
| 19 | No warehouse scope makes list safely empty | PASS: list returns an empty page when access has no global or explicit warehouse scope. |
| 20 | Explicit scope only shows accessible warehouse invoices | PASS by code path: non-global list passes `onlyIds` to the repository and filters `warehouse_id IN (...)`; tests cover in-scope vs no-scope behavior. |
| 21 | `warehouse:scope:all` only shows same-company invoices | PASS: all invoice queries also filter `companyId`; tests cover same-company success and cross-company global-scope denial. |
| 22 | `INVOICE_ISSUED` audit is in the same transaction | PASS: audit writer receives the transaction client after invoice/history creation; test verifies audit row and request id. |
| 23 | Failed invoice create writes no audit | PASS: failed DRAFT-order invoice create leaves no invoice and no `INVOICE_ISSUED` audit. |
| 24 | Invoice OpenAPI create/list/detail schemas are non-empty | PASS: OpenAPI tests verify response refs and InvoiceResponse/List fields. |
| 25 | Order draft/approve/ship, stock, product/customer/warehouse regressions remain green | PASS: targeted regressions and full API/DB gates passed. |

## Risk Checks

- Gapless numbering is rollback-safe: `next_number` is read and bumped inside
  the same transaction as invoice creation; rollback reverts the counter update.
- `invoice_series.next_number` did not remain advanced after forced rollback in
  both API and DB tests.
- Concurrent different-order invoice creation serializes on the series row lock,
  so numbers are unique, monotonic, and contiguous.
- Existing-active-invoice uniqueness is enforced twice: service-level precheck
  and the live partial unique index:
  `WHERE order_id IS NOT NULL AND status <> 'VOID'::invoice_status`.
- `status <> 'VOID'` is compatible with future void/re-issue behavior because a
  VOID invoice keeps its number while allowing a later non-VOID invoice for the
  same order.
- `invoice_items.order_item_id ON DELETE SET NULL` does not weaken the invoice
  snapshot: every invoice line stores description, quantity, price, VAT, and
  totals independently, and order items are immutable after shipment.
- `InvoicesModule` does not access order tables directly. It imports
  `OrdersModule` and reads/locks orders only through `OrdersService`.
- Order items cannot be changed after approval/shipment in the existing order
  lifecycle, so the copied invoice snapshot is stable.
- Formatted invoice number is deterministic from the locked series row prefix
  plus zero-padded `next_number` (`INV-<fiscalYear>-000001` in the default
  series).
- Drift allowlist added exactly the Prisma-visible residue for the active
  invoice partial unique. `db:drift` reported 6 allowlisted partial-unique
  statements and 0 unexpected; `verify-catalog` asserts the real predicate.

## Tests Run

Environment:

- PostgreSQL: 16.9 via local `.pgtest` server
- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_invoice_billing_review_test_20260618?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_invoice_billing_review_shadow_test_20260618?schema=public`

| Command / Gate | Result |
| --- | --- |
| Clean DB `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 19 migrations applied including `20260618000000_invoice_billing_foundation` |
| Second `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable: 65 permissions, 6 roles, 210 role permissions, 1 company, 1 warehouse, 1 invoice series |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 6 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| Invoice + order targeted API integration/OpenAPI group | PASS, 6 files, 133/133 tests |
| Stock/product/customer/warehouse/authz targeted API integration/OpenAPI group | PASS, 14 files, 193/193 tests |
| PermissionGuard unit tests | PASS, 22/22 |
| Full API gate `pnpm.cmd test:integration:api` | PASS, 34 files, 438/438 real PostgreSQL tests, 0 skipped |
| Full DB gate `pnpm.cmd test:database-gate` | PASS, 20 files, 133/133 real PostgreSQL tests, 0 skipped |
| Live catalog probe for `invoices_company_id_order_id_active_key` predicate | PASS |
| Live catalog probe for invoice-number PostgreSQL sequence | PASS, no invoice-number sequence found |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |

## Non-Blocking Notes

1. The requested `docs/architecture/INVOICE_RULES.md` and
   `docs/architecture/API_CONVENTIONS.md` paths do not exist in this tree. The
   active files reviewed are `docs/business-rules/INVOICE_RULES.md` and
   `docs/API_CONVENTIONS.md`.
2. `API_CONVENTIONS.md` still describes `command_idempotency` as the general
   mechanism for critical POST replay. This slice uses the invoice row itself,
   with `(company_id, idempotency_key)` unique, as the durable idempotency anchor.
   The behavior is covered by same-key replay/mismatch/concurrency tests, but the
   architecture note should be reconciled when the shared idempotency table is
   introduced or explicitly deferred.
