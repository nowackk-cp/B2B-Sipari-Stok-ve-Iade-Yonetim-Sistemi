# Product CSV Import / Export Foundation Review

Commit: `bb470bf`

Result: **REJECTED**

Production code was not changed. This review only inspected the commit and wrote this
review file.

## Scope Notes

- Read `docs/architecture/DATABASE_DESIGN.md`.
- Requested `docs/architecture/API_CONVENTIONS.md` does not exist in this worktree; the
  available API conventions document is `docs/API_CONVENTIONS.md` and was read.
- Reviewed Product Catalog code, `apps/api/src/modules/products/`,
  `apps/api/src/modules/products/import-export/`, Prisma `Product`, `File`,
  `ImportJob`, `ImportJobError`, RBAC, contracts, import/export tests, OpenAPI tests,
  drift, and verify-catalog changes.

## Blocking Findings

### 1. CSV export is vulnerable to spreadsheet formula injection

`ProductExportService` serializes attacker-controlled product fields directly into CSV:
`sku`, `name`, and `description` are passed straight to `toCsv`
(`apps/api/src/modules/products/import-export/product-export.service.ts:61`).

The CSV writer only quotes cells containing comma/quote/newline
(`apps/api/src/modules/products/import-export/product-csv.ts:97`), and does not neutralize
cells beginning with `=`, `+`, `-`, or `@`.

Local probe:

```text
formulaCsv="sku,name\r\n=2+3,+SUM(A1:A2)\r\n-10,@cmd\r\n"
```

Impact: a product created with a formula-like SKU/name/description is exported as an
executable spreadsheet formula when opened in Excel/LibreOffice/Google Sheets. The user
explicitly called out export injection risk; this is not mitigated.

Required fix: escape formula-leading cells before CSV serialization, including leading
whitespace cases, and add export tests for `=`, `+`, `-`, and `@`.

### 2. Import row validation errors do not return `{row,column,message}`

The public contract defines row validation errors as:
`{ row, column, message }`
(`packages/contracts/src/products.ts:51`).

The parser accumulates that shape internally
(`apps/api/src/modules/products/import-export/product-import.parser.ts:103`), but the
service converts each error into a string array:
`Row N, column X: ...`
(`apps/api/src/modules/products/import-export/product-import.service.ts:87`).

The global RFC7807 mapper then converts the string array into:

```json
{
  "errors": [{ "field": "(request)", "message": "Row 2, column listPriceAmount: invalid" }]
}
```

This was confirmed with a local runtime probe against
`apps/api/src/common/http/error-mapping.ts:31`.

Impact: clients cannot reliably map validation errors back to CSV rows/columns, and the
runtime response does not match the import contract or the requested review criterion.

### 3. Required real PostgreSQL/API gates did not execute

This environment has no `DATABASE_URL` or `SHADOW_DATABASE_URL`, and Docker/PostgreSQL
tooling is not available. The fail-closed gate behavior is correct, but the requested
real PostgreSQL/API verification did not run.

Commands failed with 0 integration tests executed:

- Product import/export integration + OpenAPI tests:
  `DATABASE_URL must be set for API integration tests (real PostgreSQL required)`.
- Product CRUD/order/invoice/return/stock/customer/warehouse/authz integration group:
  same `DATABASE_URL` failure.
- Full API gate: `API TESTS NOT EXECUTED: DATABASE_URL is not set`.
- Full DB gate and database gate: `DB TESTS NOT EXECUTED: DATABASE_URL is not set`.
- Migrate deploy twice and seed twice: Prisma `P1012`, `DATABASE_URL` missing.
- Drift: `SHADOW_DATABASE_URL is not set`.
- Verify catalog: `DATABASE_URL` missing.

The user explicitly required `REJECTED` if real PostgreSQL/API tests are skipped or not
executed.

## Additional Risks

- Multipart import has a 5 MiB size limit
  (`apps/api/src/modules/products/products.controller.ts:99`) but no file type filter.
  The service stores `file.mimetype` as metadata only
  (`apps/api/src/modules/products/import-export/product-import.service.ts:143`).
- `files` has no `companyId`; the company pin is indirect through `import_jobs.companyId`
  (`packages/database/prisma/schema.prisma:1563`, `packages/database/prisma/schema.prisma:1594`).
  Current import lookup is company-scoped via the job
  (`apps/api/src/modules/products/import-export/product-import.repository.ts:161`), but the
  source file row itself is not tenant-pinned.
- There is no committed concurrency test for same-file import races; the code relies on
  `import_jobs_active_checksum_key` and product unique conflicts, but this was not proven
  locally because PostgreSQL tests did not execute.

## Validation Matrix

| # | Check | Result |
|---|---|---|
| 1 | `POST /api/v1/products/imports` requires `product:import` | PASS by code: `@RequirePermissions('product:import')`; runtime not executed locally. |
| 2 | `GET /api/v1/products/imports/:id` only authorized/company-scoped | PASS by code: `product:import` + `companyId` filter; cross-company runtime not executed. |
| 3 | `GET /api/v1/products/export` requires `product:export` | PASS by code. |
| 4 | Import writes only actor company | PASS by code: `actor.companyId` used in product inserts. |
| 5 | Client `companyId` body/column rejected | PASS by code: multipart extra fields and header `companyId/company_id` rejected. |
| 6 | Missing required column rejects and writes nothing | PASS by code; runtime not executed. |
| 7 | Unknown column rejected | PASS by code: header allowlist rejects unknown columns. |
| 8 | CSV quoted comma/newline/escaped quote/CRLF/LF/BOM support | PASS by local parser probe. |
| 9 | Bigint overflow is 400/422, not 500 | PASS by code; runtime not executed. |
| 10 | `taxRateBp` outside `0..10000` rejected | PASS by code. |
| 11 | Currency format safe | PASS by code: uppercase 3-letter regex. |
| 12 | Duplicate SKU in same company fails | PASS by code; runtime not executed. |
| 13 | Duplicate SKU in same file fails | PASS by code. |
| 14 | Different companies may share SKU | PASS by DB model/code; runtime not executed. |
| 15 | Soft-deleted SKU behavior matches catalog rule | PASS by code: only active SKUs are prechecked; DB partial unique is active-only. |
| 16 | Import all-or-nothing | PASS by code: apply path is one transaction. |
| 17 | Bad row leaves no product/import/audit | PASS by code; runtime not executed. |
| 18 | Row validation error shape `{row,column,message}` | FAIL. Runtime returns RFC7807 field errors, not row/column objects. |
| 19 | Successful import audit in same transaction | PASS by code. |
| 20 | Failed import leaves no audit/product | PASS by code for validation failures. |
| 21 | Same company same completed checksum returns 409 | PASS by code. |
| 22 | Concurrent same-file import creates no duplicate products/imports | UNVERIFIED: no PostgreSQL concurrency test executed. |
| 23 | Import public id does not leak DB id | PASS by code: source file UUID is returned. |
| 24 | Import status/detail cross-company leakage | PASS by code; runtime not executed. |
| 25 | Export actor company only | PASS by code. |
| 26 | Export cross-company leakage | PASS by code; runtime not executed. |
| 27 | Export excludes soft-deleted products | PASS by code. |
| 28 | Default export returns active products | PASS by code. |
| 29 | `search/isActive/categoryId` align with list filters | PASS by code. |
| 30 | Export content-type/filename | PASS by code. |
| 31 | Export/import round-trip schema | PASS by code; runtime not executed. |
| 32 | Product CRUD regressions | UNVERIFIED: API integration did not execute. |
| 33 | Order/invoice/credit-note/return/stock regressions | UNVERIFIED: API integration did not execute. |
| 34 | `product:import` / `product:export` seeded idempotently | PASS by code; seed did not execute locally. |
| 35 | OpenAPI import/export response schemas non-empty | PASS with manual env for OpenAPI generation; integration OpenAPI tests did not execute. |

## Test Results

| Command | Result |
|---|---|
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/products-import-export.test.ts test/integration/products-import-export-openapi.test.ts` | FAIL: `DATABASE_URL` missing; 0 tests executed. |
| Targeted API integration regression group for products/orders/invoices/credit-notes/returns/stock/customers/warehouses/authz | FAIL: `DATABASE_URL` missing; 0 tests executed. |
| `pnpm.cmd --filter @b2b/api test:integration` | FAIL: API tests not executed, `DATABASE_URL` missing. |
| `pnpm.cmd --filter @b2b/database test:integration:db` | FAIL: DB tests not executed, `DATABASE_URL` missing. |
| `pnpm.cmd --filter @b2b/database test:database-gate` | FAIL: DB tests not executed, `DATABASE_URL` missing. |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` twice | FAIL: Prisma `P1012`, `DATABASE_URL` missing. |
| `pnpm.cmd --filter @b2b/database db:seed` twice | FAIL: Prisma `P1012`, `DATABASE_URL` missing. |
| `pnpm.cmd --filter @b2b/database db:drift` | FAIL: `SHADOW_DATABASE_URL` missing. |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | FAIL: `DATABASE_URL` missing. |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/permission-guard.test.ts` | PASS: 22 tests. |
| `pnpm.cmd --filter @b2b/database db:validate` with dummy `DATABASE_URL` | PASS. |
| `pnpm.cmd --filter @b2b/database db:generate` with dummy `DATABASE_URL` | PASS. |
| `pnpm.cmd typecheck` | PASS. |
| `pnpm.cmd lint` | PASS. |
| `pnpm.cmd format:check` | PASS. |
| `pnpm.cmd build` | PASS. |
| `pnpm.cmd check:no-skip` | PASS. |
| `pnpm.cmd check:boundaries` | PASS. |
| `pnpm.cmd check:openapi` without extra env | FAIL: OpenAPI generator defaults miss required auth/SMTP env. |
| `pnpm.cmd check:openapi` with `PASSWORD_RESET_DELIVERY_KEY`, `SMTP_USER`, `SMTP_PASSWORD` set | PASS; no tracked drift. |

## OpenAPI Env Default Assessment

The OpenAPI default-env failure is not introduced by commit `bb470bf`: this commit does
not touch `apps/api/src/openapi.ts` or config validation. The generator sets
`NODE_ENV='production'` but does not default `PASSWORD_RESET_DELIVERY_KEY`,
`SMTP_USER`, or `SMTP_PASSWORD`
(`apps/api/src/openapi.ts:16`). With those env vars provided manually, OpenAPI/client
generation succeeds and the import/export schemas are present.

## Final Verdict

REJECTED
