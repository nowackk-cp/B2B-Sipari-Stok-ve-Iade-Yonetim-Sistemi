# Product CSV Import / Export Follow-up Review

Commit: `ad01e3a`

Result: **APPROVED**

Production code was not changed during this review. Only this review file was added.

## Scope

Reviewed the requested follow-up commit and files:

- `docs/reviews/PRODUCT_IMPORT_EXPORT_FOUNDATION_REVIEW.md`
- `apps/api/src/modules/products/import-export/product-csv.ts`
- `apps/api/src/modules/products/import-export/product-export.service.ts`
- `apps/api/src/openapi.ts`
- `apps/api/test/integration/products-import-export.test.ts`
- `apps/api/test/integration/products-import-export-openapi.test.ts`
- `apps/api/test/unit/product-csv.test.ts`

Additional read-only checks covered the import parser/service call chain and production
config validation.

## Findings

No blocking findings.

## Blocker Follow-up Assessment

### CSV export formula injection

PASS.

`toCsv` is now the central CSV export sink and runs every cell through
`sanitizeCsvCell` before CSV encoding. The sanitizer prefixes risky cells with a
single quote before quoting/escaping, so CSV syntax is preserved.

Verified behavior:

- `=`, `+`, `-`, and `@` leading cells are neutralized.
- Tab, CR, and LF leading cells are neutralized.
- Leading ASCII spaces followed by a risky formula character are neutralized.
- Safe values such as `SKU-001`, normal product names, descriptions, empty strings,
  `TRY`, and numeric strings remain unchanged.
- `-10+20` is neutralized because the cell genuinely starts with `-`; `SKU-001` is
  unchanged because the hyphen is not the leading cell character.
- Comma, quote, CR, and LF CSV escaping still happens after sanitization, including
  cells that are both formula-like and quoted.
- The sanitizer is export-only: import uses `parseCsv` directly and never calls
  `sanitizeCsvCell`.
- Existing product rows are not mutated by export; `ProductExportService` only reads
  rows and serializes a response body.
- Export `content-type` and attachment filename behavior is unchanged.

The single-quote prefix is an accepted spreadsheet literal-text neutralization for
Excel, LibreOffice, and Google Sheets. The implementation places the quote inside
the CSV field data and before CSV escaping, which is the correct order for preserving
both spreadsheet safety and CSV syntax.

### OpenAPI env defaults

PASS.

`apps/api/src/openapi.ts` now supplies dummy-safe defaults for
`SMTP_USER`, `SMTP_PASSWORD`, and `PASSWORD_RESET_DELIVERY_KEY` only inside the
OpenAPI generation entrypoint. The production runtime schema in
`packages/config/src/env.ts` still requires SMTP credentials in production through
`requireProductionMail`, and still requires `PASSWORD_RESET_DELIVERY_KEY` to be at
least 32 bytes.

`check:openapi` was run bare and passed without manual env injection.

## Validation Matrix

| # | Check | Result |
|---|---|
| 1 | CSV export cells pass through central sanitizer | PASS |
| 2 | `=`, `+`, `-`, `@` leading cells neutralized | PASS |
| 3 | Tab, CR, LF leading cells neutralized | PASS |
| 4 | Leading spaces before risky character neutralized | PASS |
| 5 | Safe normal values unchanged | PASS |
| 6 | Quoted comma/newline/quote CSV escaping preserved | PASS |
| 7 | Sanitizer applies only to export output | PASS |
| 8 | Import parser behavior unchanged | PASS |
| 9 | DB product values not mutated by export | PASS |
| 10 | Export content-type/filename unchanged | PASS |
| 11 | Export injection integration tests pass on real PostgreSQL | PASS |
| 12 | Product CSV unit tests pass | PASS |
| 13 | Bare `check:openapi` passes | PASS |
| 14 | OpenAPI env default fix does not relax production runtime validation | PASS |
| 15 | `PASSWORD_RESET_DELIVERY_KEY`, `SMTP_USER`, `SMTP_PASSWORD` defaults are OpenAPI-only dummy placeholders | PASS |
| 16 | Product import/export OpenAPI tests pass | PASS |
| 17 | Full API gate passes cleanly | PASS |
| 18 | Full DB gate passes cleanly | PASS |
| 19 | Product CRUD and order/invoice/return/stock regressions covered by passing full API gate | PASS |

## Test Results

Environment:

- `DATABASE_URL=postgresql://b2b:***@127.0.0.1:55432/b2b_product_import_export_followup_review_test_20260622?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:***@127.0.0.1:55432/b2b_product_import_export_followup_review_shadow_20260622?schema=public`

| Command | Result |
|---|---|
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` on clean DB | PASS: 21 migrations applied |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/product-csv.test.ts` | PASS: 8/8 |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/permission-guard.test.ts` | PASS: 22/22 |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/products-import-export.test.ts` | PASS: 29/29 real PostgreSQL tests |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/products-import-export-openapi.test.ts` | PASS: 5/5 |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/products.test.ts` | PASS: 22/22 |
| `pnpm.cmd --filter @b2b/api test:integration` | PASS: 546/546 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd --filter @b2b/database test:database-gate` | PASS: 133/133 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd check:openapi` | PASS bare; OpenAPI/client generation succeeded with no tracked-file drift |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` second run | PASS: no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS: both idempotent |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS: 7 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd build` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd --filter @b2b/config test:unit` | PASS: 12/12 |

## Final Verdict

APPROVED
