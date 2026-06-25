# Frontend Order Operations + Invoice UI Review

Commit: `069e902`
Branch: `feat/web-app-shell-auth-dashboard`
Result: `APPROVED_WITH_NON_BLOCKING_NOTES`

## Scope

Reviewed only the Frontend Order Operations + Invoice UI foundation commit. The commit changes are limited to `apps/web` order lifecycle UI, invoice UI/client/tests, sidebar wiring, and idempotency helper. Backend/API source files were not changed by this commit, so the full API gate was not required.

## Blocking Findings

None.

## Non-Blocking Notes

- There is no committed web E2E spec for orders/invoices lifecycle actions. Unit tests cover approve/ship/invoice contracts, and I ran a live smoke for `/orders` and `/invoices`, but not a full live approve -> ship -> invoice flow.
- Duplicate or already-invoiced SHIPPED orders are handled by backend `409` because `OrderView` does not expose invoice-exists state. The UI surfaces that error inline; adding explicit invoice state later would improve affordance but is not a contract blocker.
- Invoice issue retry-after-error same-key behavior is implemented by a dialog-lifetime `useState(newIdempotencyKey)`, but unlike ship there is no direct unit test that retries invoice issue after an error and asserts the same key.
- `pnpm --filter @b2b/web lint` exits successfully as a no-op because `@b2b/web` has no package-level `lint` script. Root `pnpm lint` does run `eslint .` and passed.

## Review Notes

- Order detail action visibility matches backend lifecycle: DRAFT shows approve plus draft edit/cancel, APPROVED shows ship, SHIPPED shows issue invoice, and CANCELLED shows no operation action.
- Non-eligible lifecycle actions are not rendered in the detail DOM. Existing list edit/cancel buttons are disabled outside DRAFT, and backend still enforces status constraints.
- Approve uses `POST /orders/:id/approve`, sends no request body, and sends no `Idempotency-Key`, matching the backend approve contract.
- Ship uses `POST /orders/:id/ship`, sends mandatory `Idempotency-Key`, and sends no body or line DTO. The key is stable for the dialog lifetime and reused after an inline error retry.
- Invoice issue uses `POST /orders/:id/invoice`, sends mandatory `Idempotency-Key`, and sends no body. Backend `CreateInvoiceDto` is intentionally empty and rejects client-supplied amounts, ids, or totals.
- Lifecycle requests do not send `companyId` or server-derived price, tax, subtotal, VAT, or total fields.
- Success paths refresh both order detail and the order list. The invoice success dialog keeps its own order snapshot, so detail reload does not unmount the success view before the issued invoice number is shown.
- RFC7807 errors for approve, ship, invoice issue, and duplicate invoice are shown inline in their dialogs.
- `/invoices` is wired in the sidebar and sits under the authenticated app shell.
- Invoice list uses `GET /invoices` with only `status` and `cursor`, matching backend `ListInvoicesQuery`. The status filter values match backend `INVOICE_STATUS_FILTERS`.
- Invoice list/detail consume `InvoiceView` fields directly, use `GET /invoices/:id` for detail, include loading/empty/error/retry states, and do not add PDF/download controls.
- Invoice and order money are formatted from minor-unit strings via `formatMoney`, avoiding JS number precision loss.
- `orders-client` and `invoices-client` keep the shared `apiFetch` behavior: `credentials: 'include'`, bearer header only when a memory token exists, RFC7807 parsing, and one 401 refresh retry.
- Token storage remains memory/module-scoped in `auth-client`; no `localStorage` or `sessionStorage` token write was introduced.

## Verification

- PASS: `pnpm --filter @b2b/web test` - 18 files, 114 tests passed.
- PASS: `pnpm --filter @b2b/web typecheck`.
- PASS: `pnpm --filter @b2b/web lint` - successful no-op, package has no lint script.
- PASS: `pnpm --filter @b2b/web build`.
- PASS: `pnpm typecheck`.
- PASS: `pnpm lint`.
- PASS: `pnpm build`.
- PASS: `pnpm check:boundaries`.
- PASS: `pnpm check:no-skip`.
- PASS: `pnpm --filter @b2b/database db:migrate:deploy` on isolated PostgreSQL database `b2b_order_ops_invoice_ui_review_test_20260622212607`.
- PASS: `pnpm --filter @b2b/database db:seed` plus `node apps/api/scripts/seed-e2e-user.mjs` on the same isolated database.
- PASS: manual live orders/invoices smoke with Playwright against real API + Next production server: login, Orders navigation and terminal state, Invoices navigation and terminal state.
