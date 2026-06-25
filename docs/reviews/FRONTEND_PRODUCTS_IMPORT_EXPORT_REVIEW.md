# Frontend Products List + CSV Import/Export Review

Commit: `df2b4636522a02142cd8444506828896702e6d92`
Branch: `feat/web-app-shell-auth-dashboard`
Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Scope

Reviewed the products list route, product create/edit/delete modals, CSV import
modal, CSV export/download client, money formatting, sidebar route wiring, web
unit/e2e tests, and the backend product/import/export contracts. The commit diff
is limited to `apps/web`; no backend production files changed, so the full API
gate was not required.

## Blocking Findings

None.

## Non-Blocking Notes

1. Export does not preserve the UI's `All` status filter exactly. The products
   list maps `All` to an omitted `isActive` query, which means "all" for
   `GET /products`. The export UI does the same, but the backend export contract
   explicitly defaults omitted `isActive` to active-only
   (`apps/api/src/modules/products/dto/export-products.query.ts:8-21`,
   `apps/api/src/modules/products/import-export/product-export.service.ts:53-57`).
   Result: with `All` selected, the table can include inactive products while
   export downloads active products only. This is not a security or wire-contract
   break, but it is a UX/filter parity gap worth fixing or making explicit.
2. `pnpm --filter @b2b/web lint` exits 0 but does not run anything because
   `@b2b/web` has no `lint` script. Root `pnpm lint` did run and passed.
3. The Playwright products smoke can run on a clean DB, but the existing
   `seed-e2e-user.mjs` helper still assumes the E2E user already has a tenant
   when the `users.companyId` field is required. I seeded the default
   tenant/RBAC/bootstrap user before the Playwright global setup, then the smoke
   passed. This is e2e harness friction, not a product UI production issue.
4. Import file selection has basic client-side checks (`file` required and
   `.csv,text/csv` accept hint), but it does not pre-check empty file size.
   The backend rejects empty uploads and the modal shows the RFC7807 error.
5. `GET /products/imports/:id` remains backend-supported but is not consumed by
   this UI foundation. The modal uses the synchronous `POST /products/imports`
   response for the summary.

## Review Notes

- `/products` is under the authenticated app layout; the sidebar Products link
  is marked ready and points to `/products`
  (`apps/web/app/components/sidebar.tsx:13`).
- Product list calls `GET /products` with search, active/inactive status, cursor,
  and `pageInfo.nextCursor`/`hasNextPage` handling
  (`apps/web/app/(app)/products/page.tsx:52-63`, `:161`, `:206-262`).
- Loading, empty, error, retry, and export error states are present
  (`apps/web/app/(app)/products/page.tsx:186-202`, `:192-197`, `:178-182`).
- Money/list price display keeps the backend minor-unit string and formats via
  `BigInt`; no JS number precision loss path was found
  (`apps/web/src/lib/money.ts:13-37`).
- Create/edit payload construction omits `companyId`, sends `listPrice.amount`
  as a string, sends `vatRate` in backend-expected basis points, and maps empty
  `criticalStockThreshold` to `null`
  (`apps/web/app/components/products/product-form-modal.tsx:57-70`).
- Create/edit/delete success paths close the modal/dialog and refresh the list
  (`apps/web/app/components/products/product-form-modal.tsx:109-118`,
  `apps/web/app/components/products/delete-product-dialog.tsx:21-31`).
- Create/edit duplicate SKU and validation failures are surfaced through
  RFC7807-derived `problemMessages` (`apps/web/src/lib/products-client.ts:21-28`).
- CSV import uses `FormData`, does not force JSON `content-type`, shows upload
  state, shows applied rows/status/import id on success, and displays backend
  row/column or conflict errors (`apps/web/src/lib/products-client.ts:157-166`,
  `apps/web/app/components/products/import-products-modal.tsx:32-42`, `:49-64`,
  `:91-96`).
- CSV export carries search plus active/inactive filters, downloads a blob, reads
  `Content-Disposition`, has a fallback filename, and revokes object URLs
  (`apps/web/src/lib/products-client.ts:171-183`,
  `apps/web/src/lib/download.ts:9-18`).
- Product API calls go through `apiFetch`/`apiFetchResponse`; credentials are
  forced to `include`, bearer headers are sent only for a truthy memory token,
  RFC7807 parse remains intact, and 401 refresh/retry is bounded to one retry
  (`apps/web/src/lib/api-fetch.ts:53-65`, `:69-107`,
  `apps/web/src/lib/products-client.ts:31-40`).
- Token storage security remains unchanged: access token is module memory only;
  no production code writes localStorage/sessionStorage.
- Dashboard/auth behavior remained covered by the existing unit suite.

## Verification

- `pnpm --filter @b2b/web test` - PASS, 38/38.
- `pnpm --filter @b2b/web typecheck` - PASS.
- `pnpm --filter @b2b/web lint` - no-op because the package has no `lint`
  script.
- `pnpm --filter @b2b/web build` - PASS; `/products` route included.
- `pnpm typecheck` - PASS, 18/18 Turbo tasks.
- `pnpm lint` - PASS.
- `pnpm build` - PASS, 10/10 Turbo tasks.
- `pnpm check:boundaries` - PASS.
- `pnpm check:no-skip` - PASS.
- Isolated PostgreSQL test DB `b2b_products_ui_review_test_20260623_0108`:
  `pnpm --filter @b2b/database db:migrate:deploy` - PASS, 21 migrations applied.
- `pnpm --filter @b2b/database db:seed` against that test DB - PASS.
- `pnpm --filter @b2b/web build` with build-time
  `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1` - PASS.
- `pnpm --filter @b2b/web test:e2e -- e2e/products.spec.ts` with real API +
  Next + PostgreSQL - PASS, 2/2.

