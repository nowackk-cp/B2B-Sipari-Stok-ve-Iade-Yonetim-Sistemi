# Frontend Customer Management UI Review

Commit: `70a5f66`
Branch: `feat/web-app-shell-auth-dashboard`
Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Scope

Reviewed only the Frontend Customer Management UI foundation commit. The commit changes are limited to the web customer route, customer components, sidebar link, customer client, customer unit tests, and customer Playwright smoke. No backend/API source files changed in this commit, so the full API gate was not required.

## Blocking Findings

None.

## Non-Blocking Notes

- `pnpm --filter @b2b/web lint` exits successfully as a no-op because `@b2b/web` has no package-level `lint` script. Root `pnpm lint` does run `eslint .` and passed.
- The Playwright E2E seed script intentionally refuses databases whose name does not contain `test`; the first isolated review DB name was rejected for that reason. Re-running with `b2b_customers_ui_review_test_20260622203810` passed.

## Review Notes

- `/customers` is under the authenticated app shell and the sidebar points to the real `/customers` route with `ready: true` in `apps/web/app/components/sidebar.tsx:15`.
- Customer list loading, empty, error/retry, table, create/edit modal, and delete dialog states are present in `apps/web/app/(app)/customers/page.tsx`.
- Search maps to `search`; type filter maps `all` to no query param and `COMPANY` / `INDIVIDUAL` directly to `type`, matching `ListCustomersQuery` and `CUSTOMER_TYPES`.
- Pagination consumes backend `pageInfo.hasNextPage` and `pageInfo.nextCursor`.
- Table fields align with `CustomerView`: `code`, `name`, `type`, `taxNumber`, `email`, and `phone`.
- Create/edit payloads include only `code`, `name`, `type`, `taxNumber`, `email`, and `phone`; `companyId` is not sent. Optional empty values are normalized to `null`.
- Email validation skips empty values and blocks clearly invalid values client-side; backend still owns final `@IsEmail` validation.
- Duplicate/server RFC7807 errors are surfaced via `problemMessages`.
- Delete has confirmation; failure leaves the dialog open and shows the server error.
- `customers-client` uses `apiFetch` for every call, keeps `credentials: 'include'`, sends bearer only when an in-memory access token exists, and retries once after a 401 refresh.
- Token storage remains memory/module-scoped in `auth-client`; no `localStorage` or `sessionStorage` token write was introduced.
- Dashboard/products/warehouses/auth foundations were exercised by the full web unit suite and root build/typecheck/lint gates.

## Verification

- PASS: `pnpm --filter @b2b/web test` - 12 files, 68 tests passed.
- PASS: `pnpm --filter @b2b/web typecheck`.
- PASS: `pnpm --filter @b2b/web lint` - successful no-op, package has no lint script.
- PASS: `pnpm --filter @b2b/web build`.
- PASS: `pnpm typecheck`.
- PASS: `pnpm lint`.
- PASS: `pnpm build`.
- PASS: `pnpm check:boundaries`.
- PASS: `pnpm check:no-skip`.
- PASS: `pnpm --filter @b2b/database db:migrate:deploy` on isolated PostgreSQL database `b2b_customers_ui_review_test_20260622203810`.
- PASS: `pnpm --filter @b2b/database db:seed` on the same isolated database.
- PASS: `pnpm --filter @b2b/web exec playwright test e2e/customers.spec.ts` - 2 Chromium smoke tests passed against real API + Next production server.
