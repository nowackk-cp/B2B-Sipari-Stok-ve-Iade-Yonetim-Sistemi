# Frontend Orders Draft UI Review

Commit: `4314399`
Branch: `feat/web-app-shell-auth-dashboard`
Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Scope

Reviewed only commit `4314399` (`feat(web): orders draft list + detail + create/edit/cancel UI`) in a detached worktree at the target commit. The commit changes are limited to web order UI/client/tests plus sidebar wiring and shared web CSS. No backend/API/database source files are changed by this commit, so the full API gate was not required.

## Blocking Findings

None.

## Non-Blocking Notes

- Option selects load only the first `100` customers, active warehouses, and active products, and ignore `pageInfo` (`apps/web/app/components/orders/order-form-modal.tsx:41`, `:117`). This is contract-safe, and product/warehouse/customer list endpoints exclude deleted rows as expected, but larger tenants can miss selectable options until the picker supports search or pagination.
- Option loading is only implicit: customer/warehouse/product selects and submit are disabled while options are absent (`apps/web/app/components/orders/order-form-modal.tsx:208`, `:225`, `:243`, `:256`, `:313`). The option error state is visible, but there is no explicit loading message for users.
- Backend list filtering allows `PREPARING`, and the badge handles it, but the UI status filter exposes only `all`, `DRAFT`, `APPROVED`, `SHIPPED`, and `CANCELLED` (`apps/web/app/(app)/orders/page.tsx:13`, `apps/api/src/modules/orders/dto/list-orders.query.ts:6`). This is non-blocking for this draft slice, but it should be revisited if `PREPARING` orders become user-visible.
- A live API `/orders` smoke was not possible in this environment: Docker is unavailable, local PostgreSQL port `5432` is closed, `psql/createdb` are unavailable, and required API/DB env vars are unset. I treated the absence of a live API E2E smoke as non-blocking because this commit does not change backend files and the web/root gates pass.
- In a clean detached worktree, `pnpm install --frozen-lockfile` fails because the existing `pnpm-lock.yaml` `apps/web` importer still lists `@b2b/config` while `apps/web/package.json` does not. That lockfile/package mismatch is not introduced by `4314399`; I used `--no-frozen-lockfile` only in the temporary review worktree to install dependencies for verification.

## Review Notes

- `/orders` is under `apps/web/app/(app)` and is wrapped by `AuthGate` through `apps/web/app/(app)/layout.tsx:10`. The shell validates the session and renders sidebar/topbar before page content (`apps/web/app/components/auth-gate.tsx:31`, `:59`).
- The sidebar Orders item points to the real `/orders` route and is marked ready (`apps/web/app/components/sidebar.tsx:16`).
- The list calls `listOrders({ status, cursor })` only, matching the backend list contract. It does not add unsupported `search` query params (`apps/web/app/(app)/orders/page.tsx:30`, `:44`).
- Loading, empty, error/retry, status filter, cursor next/previous stack, and `pageInfo.nextCursor/hasNextPage` handling are present (`apps/web/app/(app)/orders/page.tsx:43`, `:50`, `:76`, `:81`, `:123`, `:129`, `:139`).
- Money rendering uses the shared string/BigInt-safe formatter and does not coerce minor-unit strings to floating point (`apps/web/app/(app)/orders/page.tsx:186`, `apps/web/src/lib/money.ts:1`).
- Detail drawer re-fetches with `GET /orders/:id`, shows header/totals/line items from `OrderView`, and only shows draft actions for fetched `DRAFT` orders (`apps/web/app/components/orders/order-detail-drawer.tsx:43`, `:136`, `:157`, `:202`).
- Create/edit payloads contain only `customerId`, `warehouseId`, `items: [{ productId, quantity }]`, and `note`; they do not send `companyId`, unit price, tax, subtotal, VAT, or total (`apps/web/app/components/orders/order-form-modal.tsx:166`, `:178`; `apps/web/src/lib/orders-client.ts:118`, `:125`).
- Quantity is validated as a positive whole-number string, at least one item is required, and duplicate products are blocked client-side before submit (`apps/web/app/components/orders/order-form-modal.tsx:55`, `:60`, `:69`, `:72`).
- Backend `PATCH /orders/:id` supports customer and warehouse replacement on DRAFT orders, and the service re-resolves active customer/warehouse rows before writing (`apps/api/src/modules/orders/dto/update-order.dto.ts:27`, `:32`; `apps/api/src/modules/orders/orders.service.ts:171`, `:177`).
- Cancel uses `POST /orders/:id/cancel` with optional reason, has confirmation, refreshes after success, and shows RFC7807-derived errors on failure (`apps/web/src/lib/orders-client.ts:136`, `apps/web/app/components/orders/cancel-order-dialog.tsx:30`, `:31`, `:58`, `:74`; `apps/api/src/modules/orders/orders.controller.ts:100`).
- Non-DRAFT list actions are disabled, and non-DRAFT detail actions are hidden. A tampered DOM can only reach the server-side DRAFT guard, which rejects update/cancel for non-DRAFT orders (`apps/web/app/(app)/orders/page.tsx:193`, `:203`; `apps/web/app/components/orders/order-detail-drawer.tsx:202`; `apps/api/src/modules/orders/orders.service.ts:166`, `:227`).
- `orders-client` sends every request through `apiFetch`, preserving `credentials: 'include'`, in-memory bearer behavior, RFC7807 parsing, and one refresh/retry on 401 (`apps/web/src/lib/api-fetch.ts:58`, `apps/web/src/lib/orders-client.ts:37`, `:40`, `:107`, `:113`, `:120`, `:127`, `:138`).
- Token storage remains module-scoped in memory; no token write to `localStorage` or `sessionStorage` was introduced (`apps/web/src/lib/auth-client.ts:9`). Repository search found no storage writes in `apps/web`.

## Verification

- PASS: `pnpm --filter @b2b/web test` - 14 files, 88 tests passed after building local workspace prerequisites.
- PASS: `pnpm --filter @b2b/web typecheck`.
- PASS: `pnpm --filter @b2b/web lint` - successful no-op because `@b2b/web` has no package-level `lint` script.
- PASS: `pnpm --filter @b2b/web build`.
- PASS: `pnpm typecheck` after `pnpm --filter @b2b/database db:generate` in the temporary worktree.
- PASS: `pnpm lint`.
- PASS: `pnpm build`.
- PASS: `pnpm check:boundaries`.
- PASS: `pnpm check:no-skip`.
- NOT RUN: live API `/orders` smoke; local Docker/PostgreSQL/API environment is unavailable.
- NOT REQUIRED: full API gate; backend/API/database files were not changed by commit `4314399`.
