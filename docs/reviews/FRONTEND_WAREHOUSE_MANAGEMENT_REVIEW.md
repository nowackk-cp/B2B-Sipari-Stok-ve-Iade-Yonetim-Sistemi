# Frontend Warehouse Management UI Review

Commit: `ba392cbefa319bc50159a05c36e3c0398888c98f`
Branch: `feat/web-app-shell-auth-dashboard`
Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Scope

Reviewed the warehouse list route, create/edit form modal, delete dialog,
warehouse API client, sidebar wiring, warehouse unit/e2e tests, the existing
products UI pattern, and the backend warehouse contracts. The commit diff is
limited to `apps/web`; no backend production files changed, so the full API gate
was not required.

## Blocking Findings

None.

## Non-Blocking Notes

1. `pnpm --filter @b2b/web lint` exits 0 but does not run anything because
   `@b2b/web` has no `lint` script. Root `pnpm lint` did run and passed.
2. Playwright warehouses smoke was possible and was run against real API + Next
   + PostgreSQL. The first test passed. The second test opened the modal, then
   failed in Playwright strict mode because `getByLabel('code')` matched both
   `aria-label="code"` and `aria-label="postalCode"`. This is an e2e locator
   ambiguity, not a backend contract or production data-flow failure.
3. Clean-DB web e2e still needs the default tenant/RBAC bootstrap seed before
   the existing `seed-e2e-user.mjs` helper can update the deterministic user.
   This is test harness friction and matches prior frontend smoke runs.

## Review Notes

- `/warehouses` is under the authenticated app layout, and the sidebar
  Warehouses link is marked ready and points to `/warehouses`
  (`apps/web/app/components/sidebar.tsx:13`).
- Warehouse list uses `GET /warehouses` with supported `search`, `isActive`, and
  `cursor` params, and consumes `pageInfo.nextCursor` / `hasNextPage`
  (`apps/web/app/(app)/warehouses/page.tsx:39-53`, `:79-91`).
- Loading, empty, error, retry, and pagination states are present
  (`apps/web/app/(app)/warehouses/page.tsx:130-150`, `:154-221`).
- Table fields map to `WarehouseView`: `code`, `name`, nullable `city`,
  nullable `country`, and `isActive`
  (`apps/web/app/(app)/warehouses/page.tsx:163-184`).
- Create/edit payloads contain only backend-accepted fields and never include
  `companyId`. Optional address/city/postal fields are sent as `null` when
  empty, and country is sent as uppercase 2-letter ISO or `null`
  (`apps/web/app/components/warehouses/warehouse-form-modal.tsx:41-65`).
- Backend contract confirms `country` is optional/nullable and validated as a
  2-letter ISO code; service normalizes country uppercase
  (`apps/api/src/modules/warehouses/dto/create-warehouse.dto.ts:54-63`,
  `apps/api/src/modules/warehouses/warehouses.service.ts:277-281`).
- Create/edit success closes the modal and refreshes the list; duplicate-code
  409 and RFC7807 field/server errors are rendered inline
  (`apps/web/app/components/warehouses/warehouse-form-modal.tsx:95-104`).
- Delete has an explicit confirmation. Success refreshes the list and closes the
  dialog; failure keeps the dialog open and renders the error
  (`apps/web/app/components/warehouses/delete-warehouse-dialog.tsx:21-31`).
- `warehouses-client` uses `apiFetch` for list/create/update/delete, inherits
  forced `credentials: 'include'`, sends bearer only when the memory token is
  truthy, and retries once after a 401 refresh
  (`apps/web/src/lib/warehouses-client.ts:31-40`, `:80-113`,
  `apps/web/src/lib/api-fetch.ts:53-65`).
- Token storage remains unchanged: access token is module memory only; no
  production code writes localStorage/sessionStorage.
- Warehouse scope remains backend-owned. The UI calls list/get/update/delete
  endpoints normally; backend applies tenant and warehouse-scope filters.
- Dashboard/products/auth behavior remains covered by the existing web unit
  suite.

## Verification

- `pnpm --filter @b2b/web test` - PASS, 53/53.
- `pnpm --filter @b2b/web typecheck` - PASS.
- `pnpm --filter @b2b/web lint` - no-op because the package has no `lint`
  script.
- `pnpm --filter @b2b/web build` - PASS; `/warehouses` route included.
- `pnpm typecheck` - PASS, 18/18 Turbo tasks.
- `pnpm lint` - PASS.
- `pnpm build` - PASS, 10/10 Turbo tasks.
- `pnpm check:boundaries` - PASS.
- `pnpm check:no-skip` - PASS.
- Isolated PostgreSQL test DB `b2b_warehouses_ui_review_test_20260622_2025`:
  `pnpm --filter @b2b/database db:migrate:deploy` - PASS, 21 migrations applied.
- `pnpm --filter @b2b/database db:seed` against that test DB - PASS.
- `pnpm --filter @b2b/web build` with build-time
  `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1` - PASS.
- `pnpm --filter @b2b/web test:e2e -- e2e/warehouses.spec.ts` with real API +
  Next + PostgreSQL - PARTIAL: 1/2 passed; second test failed due locator
  ambiguity after modal visibility was confirmed.

