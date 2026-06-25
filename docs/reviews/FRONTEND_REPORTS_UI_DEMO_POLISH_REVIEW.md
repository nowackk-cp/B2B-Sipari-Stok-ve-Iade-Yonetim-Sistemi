# Frontend Reports UI + Demo Polish Review

Commit: `f66300e`
Branch: `feat/web-app-shell-auth-dashboard`
Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Scope

Reviewed the reports page, sales/inventory/returns report components, reports
client, money/quantity formatting, sidebar navigation, report-specific unit
tests, reports Playwright smoke, backend reports DTO/service/repository contract,
and the prior dashboard/reports backend review notes.

The commit diff is limited to web UI/test/style files. No backend production,
database, domain, or contract file changed, so the full API gate was not
required for this review.

## Blocking Findings

None.

## Non-Blocking Notes

1. Direct `?tab=` deep links work on initial render, and invalid tabs fall back
   to sales. However, `ReportsView` only uses `useSearchParams()` to seed React
   state once (`apps/web/app/(app)/reports/page.tsx:37-39`), and tab clicks only
   call `setTab()` without updating the URL (`apps/web/app/(app)/reports/page.tsx:84`).
   A same-route query change after the page is already mounted, such as clicking
   the Inventory sidebar link while already on `/reports`, can leave the URL and
   selected tab stale relative to each other depending on App Router remount
   behavior. Existing tests cover initial deep-linking but not same-route query
   updates.
2. `pnpm --filter @b2b/web lint` exits successfully but does not run a web lint
   script because `@b2b/web` has no `lint` script. Root `pnpm lint` did run and
   passed.
3. The reports Playwright smoke could not run in this local environment because
   the live API webServer fails env validation without `DATABASE_URL` and
   `PASSWORD_RESET_DELIVERY_KEY`. This is non-blocking for this frontend-only
   commit because unit/typecheck/build/root gates passed and backend files did
   not change, but CI should run the smoke with a real PostgreSQL-backed stack.

## Contract And Security Review

- `/reports` is under the authenticated `(app)` layout and therefore behind
  `AuthGate` (`apps/web/app/(app)/layout.tsx:8`).
- `useSearchParams` is below a Suspense boundary, and `next build` completed
  without a CSR bailout error for `/reports`
  (`apps/web/app/(app)/reports/page.tsx:97-108`).
- Only the active tab component is mounted through the `tab` switch
  (`apps/web/app/(app)/reports/page.tsx:59-68`), so inactive report endpoints are
  not called.
- Sales forwards only `dateFrom`, `dateTo`, `warehouseId`, and `groupBy`;
  it does not send a status filter or tenant/company claim
  (`apps/web/app/components/reports/sales-report.tsx:33-38`,
  `apps/web/src/lib/reports-client.ts:98-107`).
- Inventory forwards only `search`, `lowStockOnly`, `warehouseId`, and `cursor`
  from the UI; `limit` is client-supported but not sent by the current component.
  `lowStockOnly=false` is omitted by the client
  (`apps/web/app/components/reports/inventory-report.tsx:34-39`,
  `apps/web/src/lib/reports-client.ts:114-124`).
- Inventory cursor navigation uses `pageInfo.nextCursor` for next-page requests
  and tracks previous cursors locally (`apps/web/app/components/reports/inventory-report.tsx:66-75`).
- Returns forwards only `dateFrom`, `dateTo`, `status`, and `warehouseId`
  (`apps/web/app/components/reports/returns-report.tsx:35-40`,
  `apps/web/src/lib/reports-client.ts:128-138`).
- Warehouse filters are populated best-effort via `listWarehouses({ limit: 100 })`;
  failure hides the filter and does not block reports
  (`apps/web/app/(app)/reports/page.tsx:42-57`).
- Frontend code sends no `companyId` or tenant claim for reports; backend scope
  remains server-resolved through the reviewed dashboard/reports implementation.
- `reports-client` keeps `credentials: include` through `apiFetch`, retries once
  after a 401 refresh, and preserves RFC7807 `ApiError` parsing
  (`apps/web/src/lib/reports-client.ts:31-51`,
  `apps/web/src/lib/api-fetch.ts:55-74`).
- Access tokens remain module-scoped memory only; no production code writes
  auth tokens to `localStorage` or `sessionStorage`
  (`apps/web/src/lib/auth-client.ts:13-37`).
- Money and quantity formatting avoids `Number()` and groups integer strings via
  `BigInt`, preserving values beyond JS safe integer range. `formatQuantity`
  safely handles null/undefined/empty values as a dash and renders invalid
  non-numeric input verbatim rather than throwing
  (`apps/web/src/lib/money.ts:13-37`, `apps/web/src/lib/money.ts:58-65`).
- Sidebar Reports points to `/reports`, Inventory points to
  `/reports?tab=inventory`, query-bearing Inventory does not claim the active
  highlight, and the current app route set has no remaining dead sidebar link
  (`apps/web/app/components/sidebar.tsx:15-25`,
  `apps/web/app/components/sidebar.tsx:35-46`).

## Verification

- `pnpm --filter @b2b/web test` first hit PowerShell execution policy on
  `pnpm.ps1`; reran with `pnpm.cmd`.
- `pnpm.cmd --filter @b2b/web test` - PASS, 179/179.
- `pnpm.cmd --filter @b2b/web typecheck` - PASS.
- `pnpm.cmd --filter @b2b/web lint` - no-op because the package has no `lint`
  script.
- `pnpm.cmd --filter @b2b/web build` - PASS, `/reports` built successfully.
- `pnpm.cmd typecheck` - PASS, 18/18 Turbo tasks.
- `pnpm.cmd lint` - PASS.
- `pnpm.cmd build` - PASS, 10/10 Turbo tasks.
- `pnpm.cmd check:boundaries` - PASS.
- `pnpm.cmd check:no-skip` - PASS.
- `pnpm.cmd --filter @b2b/web test:e2e -- reports.spec.ts` - NOT RUN to test
  completion; webServer failed before tests because required live API env
  (`DATABASE_URL`, `PASSWORD_RESET_DELIVERY_KEY`) was missing.
- `git diff --name-only f66300e^ f66300e -- apps/api packages/database packages/domain packages/contracts`
  - no backend/database/domain/contract files changed.
- `git diff --check f66300e^ f66300e` - PASS.
