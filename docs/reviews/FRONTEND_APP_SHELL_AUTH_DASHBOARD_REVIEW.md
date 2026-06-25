# Frontend App Shell + Auth + Dashboard Review

Commit: `f469b1821906723d02fe6e655b51e7484663e566`
Branch: `feat/web-app-shell-auth-dashboard`
Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Scope

Reviewed the frontend app shell, auth client/gates, dashboard client/page, money
formatting, web tests, Playwright smoke, and the backend auth/dashboard response
contracts. The commit diff is limited to `apps/web`, `pnpm-lock.yaml`, and web
test/config files; no backend production/API files changed, so the full API gate
was not required for this review.

## Blocking Findings

None.

## Non-Blocking Notes

1. Playwright smoke is sensitive to build-time public env configuration.
   `apps/web/playwright.config.ts:62` supplies `NEXT_PUBLIC_API_BASE_URL` to
   `next start`, but Next public env values are inlined at `next build`. A bundle
   built without that env kept the browser on `/login`; rebuilding with
   `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1` made the same smoke
   pass 6/6. CI should set the public API base before `next build`, not only
   before `next start`.
2. The existing E2E seed helper is not clean-DB standalone after tenant-required
   users. `apps/api/scripts/seed-e2e-user.mjs:43` creates a user without a
   company when the user does not already exist. On a freshly migrated test DB,
   Playwright global setup failed until the default tenant/RBAC seed created the
   tenant-bound E2E user first; after that, the helper updated the password and
   the smoke passed.
3. `pnpm --filter @b2b/web lint` exits successfully but does not run a web lint
   script because `@b2b/web` has no `lint` script. Root `pnpm lint` did run and
   passed.
4. Sidebar placeholder destinations are marked `soon` and `aria-disabled`, but
   they are still normal `Link` elements to unimplemented routes
   (`apps/web/app/components/sidebar.tsx:33-42`). This is clear enough for a
   foundation shell, but users can still navigate into placeholder routes.
5. Dashboard 401 retry is bounded and does not loop, but a failed refresh from
   the dashboard data path propagates to the dashboard error state instead of
   actively bouncing to `/login` (`apps/web/src/lib/dashboard-client.ts:19-23`,
   `apps/web/app/(app)/dashboard/page.tsx:43-50`). Initial protected-route mount
   and reload still bounce through `AuthGate`.

## Security And Contract Review

- `/login` renders the expected form, redirects to `/dashboard` after successful
  `login()`, and uses a generic invalid-credentials message
  (`apps/web/app/(auth)/login/page.tsx:21-24`, `:42`, `:54`, `:62`).
- The access token is module-scoped memory only
  (`apps/web/src/lib/auth-client.ts:13`, `:29`, `:36`); no production code writes
  it to `localStorage` or `sessionStorage`, and Playwright verified storage did
  not contain token-like values after login.
- Refresh token handling matches the backend contract: the API sets it as an
  HttpOnly cookie, and frontend code never reads it. Backend cookie settings are
  HttpOnly, SameSite Strict, narrow path, and secure in production.
- `apiFetch` forces `credentials: 'include'` after spreading caller options, so
  callers cannot accidentally omit cookie credentials
  (`apps/web/src/lib/api-fetch.ts:57-63`). It only sends `Authorization: Bearer`
  when a truthy in-memory access token exists.
- `AuthGate` restores session on mount, renders only a loading state before auth
  is known, redirects unauthenticated users to `/login`, and clears token state
  via backend logout before returning to `/login`
  (`apps/web/app/components/auth-gate.tsx:31-49`).
- `GuestGate` probes session before rendering guest content and redirects
  authenticated `/login` visits to `/dashboard`
  (`apps/web/app/components/guest-gate.tsx:20-40`).
- RFC7807 problem JSON and 204 responses are covered in `apiFetch` and unit
  tests (`apps/web/src/lib/api-fetch.ts:69-74`).
- Dashboard summary fields match `DashboardSummaryView`; missing numeric values
  render as `0`, loading and retryable error states exist, and money arrays are
  rendered per currency (`apps/web/app/(app)/dashboard/page.tsx:21-30`, `:62-77`,
  `:87-98`).
- Money display keeps minor-unit amounts as strings and uses `BigInt` for integer
  grouping, avoiding JS `number` precision loss
  (`apps/web/src/lib/money.ts:13-37`). Empty/null money lists render safely.
- Root `/` redirects to `/dashboard`; route groups are valid App Router layouts.
- Backend auth and dashboard contracts remain compatible:
  `POST /auth/login`, `POST /auth/logout`, `POST /auth/refresh`,
  `GET /auth/me`, and `GET /dashboard/summary`.
- No backend production files changed in this commit, and the reviewed dashboard
  endpoint remains a backend read surface; no frontend change introduces an API
  mutation/audit path.

## Verification

- `pnpm --filter @b2b/web test` - PASS, 14/14.
- `pnpm --filter @b2b/web typecheck` - PASS.
- `pnpm --filter @b2b/web lint` - no-op because the package has no `lint`
  script.
- `pnpm --filter @b2b/web build` - PASS.
- `pnpm typecheck` - PASS, 18/18 Turbo tasks.
- `pnpm lint` - PASS.
- `pnpm build` - PASS, 10/10 Turbo tasks.
- `pnpm check:boundaries` - PASS.
- `pnpm check:no-skip` - PASS.
- Isolated PostgreSQL test DB `b2b_web_app_shell_review_test_20260622`:
  `pnpm --filter @b2b/database db:migrate:deploy` - PASS, 21 migrations applied.
- Direct real API probe against the E2E DB:
  `/auth/login`, `/auth/me`, and `/auth/refresh` - PASS.
- `pnpm --filter @b2b/web test:e2e` with real API + Next + PostgreSQL - PASS,
  6/6, after setting the required API secret, seeding the default tenant/RBAC,
  and rebuilding the web bundle with build-time `NEXT_PUBLIC_API_BASE_URL`.

