# Final Project Status — B2B Operations Suite

Release-readiness snapshot for the demo milestone. Authority for behaviour stays
with [PROJECT_SPEC.md](../../PROJECT_SPEC.md) and `docs/`; this is an index of
what is done, how it was reviewed, and what remains before production.

- Branch: `feat/web-app-shell-auth-dashboard`
- Snapshot taken at the **Final Demo Polish + Release Readiness** task (this PR).
- Demo guide: [docs/demo/DEMO_RUNBOOK.md](../demo/DEMO_RUNBOOK.md).

---

## 1. Completed modules

### Backend (apps/api, packages/domain, packages/database)

| Module                          | Capability                                                                 | Lead review                                                              |
| ------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Foundation / monorepo           | Turborepo, config (zod), logger (pino), CI, app skeletons                   | [FOUNDATION_1A_REVIEW](FOUNDATION_1A_REVIEW.md)                          |
| Database foundation             | 48-model schema, forward-only migrations, append-only triggers, drift gate | [DATABASE_FOUNDATION_REVIEW](DATABASE_FOUNDATION_REVIEW.md)              |
| Authentication                  | Argon2id, HS256 sessions, rotation/reuse detection, password reset (sealed)| [AUTHENTICATION_FOUNDATION_REVIEW](AUTHENTICATION_FOUNDATION_REVIEW.md)  |
| Permission guard / RBAC         | Effective-permission resolution, company/tenant isolation, cache versioning| [PERMISSION_GUARD_FINAL_REVIEW](PERMISSION_GUARD_FINAL_REVIEW.md)        |
| Grant ceiling                   | ADMIN cannot self-escalate / assign protected roles or unheld permissions  | [PERMISSION_GRANT_CEILING_FINAL_REVIEW](PERMISSION_GRANT_CEILING_FINAL_REVIEW.md) |
| Warehouse scope                 | No implicit scope; explicit scope rows or protected `warehouse:scope:all`   | [PERMISSION_WAREHOUSE_SCOPE_REVIEW](PERMISSION_WAREHOUSE_SCOPE_REVIEW.md)|
| Product catalog + import/export | CRUD, company scope, BigInt-safe numerics, CSV import/export (injection-safe)| [PRODUCT_IMPORT_EXPORT_FOLLOWUP_REVIEW](PRODUCT_IMPORT_EXPORT_FOLLOWUP_REVIEW.md) |
| Warehouse management            | CRUD, company-scoped code uniqueness                                        | [WAREHOUSE_MANAGEMENT_FOUNDATION_REVIEW](WAREHOUSE_MANAGEMENT_FOUNDATION_REVIEW.md) |
| Inventory: stock ledger         | Adjustments/balances/movements, FOR UPDATE lock, row-level idempotency      | [STOCK_LEDGER_FOUNDATION_REVIEW](STOCK_LEDGER_FOUNDATION_REVIEW.md)      |
| Inventory: stock transfer       | Atomic two-balance transfer, ordered locks, source/destination scope        | [STOCK_TRANSFER_FOUNDATION_REVIEW](STOCK_TRANSFER_FOUNDATION_REVIEW.md)  |
| Customers                       | CRUD, company scope, soft delete                                            | [CUSTOMER_MANAGEMENT_FOUNDATION_REVIEW](CUSTOMER_MANAGEMENT_FOUNDATION_REVIEW.md) |
| Orders: draft                   | DRAFT lifecycle, server pricing, DRAFT-only PATCH with expected-status guard| [ORDER_DRAFT_PATCH_RACE_FOLLOWUP_REVIEW](ORDER_DRAFT_PATCH_RACE_FOLLOWUP_REVIEW.md) |
| Orders: approve + reserve       | All-or-nothing reservation, product revalidation, full-reject on shortfall  | [ORDER_APPROVAL_PRODUCT_REVALIDATION_FOLLOWUP_REVIEW](ORDER_APPROVAL_PRODUCT_REVALIDATION_FOLLOWUP_REVIEW.md) |
| Orders: ship                    | APPROVED→SHIPPED, commits reserved stock                                    | [ORDER_SHIPMENT_STOCK_COMMIT_REVIEW](ORDER_SHIPMENT_STOCK_COMMIT_REVIEW.md) |
| Invoicing / billing             | SHIPPED→ISSUED, gapless `invoice_series` counter (no DB sequence)           | [INVOICE_BILLING_FOUNDATION_REVIEW](INVOICE_BILLING_FOUNDATION_REVIEW.md)|
| Returns / refunds               | Return against SHIPPED order, warehouse revalidation under lock at approve   | [RETURN_WAREHOUSE_REVALIDATION_FOLLOWUP_REVIEW](RETURN_WAREHOUSE_REVALIDATION_FOLLOWUP_REVIEW.md) |
| Credit notes                    | APPROVED return → `CRN-<year>-N`, requires original invoice                  | [CREDIT_NOTE_FOUNDATION_REVIEW](CREDIT_NOTE_FOUNDATION_REVIEW.md)        |
| Dashboard / reports             | Read-only sales/inventory/returns aggregates, tenant-scoped reads           | [DASHBOARD_REPORTS_TENANT_LEAK_FOLLOWUP_REVIEW](DASHBOARD_REPORTS_TENANT_LEAK_FOLLOWUP_REVIEW.md) |

### Frontend (apps/web)

| Screen / area                | Routes                                  | Lead review                                                       |
| ---------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| App shell + auth + dashboard | `/login`, `/dashboard`, `/`             | [FRONTEND_APP_SHELL_AUTH_DASHBOARD_REVIEW](FRONTEND_APP_SHELL_AUTH_DASHBOARD_REVIEW.md) |
| Products + CSV               | `/products`                             | [FRONTEND_PRODUCTS_IMPORT_EXPORT_REVIEW](FRONTEND_PRODUCTS_IMPORT_EXPORT_REVIEW.md) |
| Warehouses                   | `/warehouses`                           | [FRONTEND_WAREHOUSE_MANAGEMENT_REVIEW](FRONTEND_WAREHOUSE_MANAGEMENT_REVIEW.md) |
| Customers                    | `/customers`                            | [FRONTEND_CUSTOMER_MANAGEMENT_REVIEW](FRONTEND_CUSTOMER_MANAGEMENT_REVIEW.md) |
| Orders + lifecycle           | `/orders`                               | [FRONTEND_ORDERS_DRAFT_UI_REVIEW](FRONTEND_ORDERS_DRAFT_UI_REVIEW.md) |
| Order ops + invoices         | `/orders` actions, `/invoices`          | [FRONTEND_ORDER_OPERATIONS_INVOICE_UI_REVIEW](FRONTEND_ORDER_OPERATIONS_INVOICE_UI_REVIEW.md) |
| Returns + credit notes       | `/returns`, `/credit-notes`             | (covered with returns/credit-note backend reviews)               |
| Reports + nav polish         | `/reports` (`?tab=`)                     | [FRONTEND_REPORTS_UI_DEMO_POLISH_REVIEW](FRONTEND_REPORTS_UI_DEMO_POLISH_REVIEW.md) |

All listed reviews resolved to **APPROVED** or **APPROVED_WITH_NON_BLOCKING_NOTES**.

---

## 2. Route / navigation audit (this task)

Audited every sidebar destination and the app's redirect rules:

- **No dead links.** Sidebar entries map 1:1 to real routes: `/dashboard`,
  `/products`, `/warehouses`, `/customers`, `/orders`, `/invoices`, `/returns`,
  `/credit-notes`, `/reports`. The **Inventory** entry deep-links to
  `/reports?tab=inventory` (there is no standalone `/inventory` screen this
  milestone) — it never 404s.
- **Active highlight** is derived from the pathname; query-bearing entries
  (Inventory) deliberately do not claim the highlight, so the canonical `Reports`
  item stays active while on `/reports`.
- **Auth redirects:** unauthenticated access to any `(app)` route bounces to
  `/login` (`AuthGate`); an authenticated visit to `/login` bounces to
  `/dashboard` (`GuestGate`); `/` redirects to `/dashboard`.
- **Logout** is in the topbar (present on every authenticated route) and returns
  to `/login`.
- **Polish applied:** `/reports` now follows a same-route `?tab=` change (e.g.
  clicking the Inventory sidebar link while already on `/reports`) instead of
  leaving the selected tab stale — the one non-blocking note from the prior
  reports review. No other dead links or broken redirects were found.

---

## 3. UI polish reviewed per screen

Verified loading / empty / error+retry states, modal close behaviour, BigInt-safe
money/quantity formatting, and RFC 7807 error surfacing across Dashboard,
Products, Warehouses, Customers, Orders, Invoices, Returns, Credit Notes and
Reports. These states already existed and are covered by the component suite; the
only behavioural change this task is the reports tab/URL sync above. No business
logic, schema, auth, or money handling was touched.

---

## 4. Recent commit list (most recent first)

```
f66300e feat(web): reports UI (sales/inventory/returns) + nav polish
f90b795 feat(web): returns + credit notes UI foundation
069e902 feat(web): order lifecycle actions (approve/ship/invoice) + invoices UI
4314399 feat(web): orders draft list + detail + create/edit/cancel UI
70a5f66 feat(web): customers list + create/edit/delete UI foundation
ba392cb feat(web): warehouses list + create/edit/delete UI foundation
df2b463 feat(web): products list + CSV import/export UI foundation
f469b18 feat(web): app shell + auth + dashboard summary foundation
c0c6125 fix(reports): pin warehouse tenant on inventory/low-stock stock-balance reads
32339fa feat(reports): read-only dashboard + sales/inventory/returns report API
ad01e3a fix(catalog): neutralize CSV export formula injection + OpenAPI env defaults
bb470bf feat(catalog): product CSV import/export foundation
e04bb45 feat(billing): issue credit notes for APPROVED returns
e381fed fix(returns): revalidate warehouse lifecycle under lock at return approve
5e5fdfc feat(returns): add return and refund foundation
96806be feat(billing): issue invoices for SHIPPED orders
f3a2cbf feat(orders): ship APPROVED orders, committing reserved stock
6bb646b feat(orders): order approval + stock reservation foundation
b9c7238 feat(orders): DRAFT order API foundation
f689a42 feat(customers): customer management API foundation
826fbd7 feat(inventory): atomic stock transfer foundation
2ade6d1 feat(inventory): stock ledger + balance foundation
cc8dc06 feat(warehouses): warehouse management API foundation
4115958 feat(catalog): product catalog foundation
0d68c2e feat(authz): warehouse scope foundation
66eb74d feat(authz): grant-ceiling policy + service foundation
… (auth, RBAC, and database foundation commits precede the above)
```

---

## 5. Gate results (this task's run)

Run on the local Windows dev box. Frontend + repo-wide gates run without external
services; the backend DB/API gates require a real PostgreSQL, which is **not
provisioned in this environment** — they are reported as NOT RUN, not passed.

### Frontend (apps/web)

| Gate                         | Result                                       |
| ---------------------------- | -------------------------------------------- |
| `--filter @b2b/web test`     | **PASS** — 180/180 (was 179; +1 reports sync)|
| `--filter @b2b/web typecheck`| **PASS**                                     |
| `--filter @b2b/web build`    | **PASS** — all routes prerender, `/reports` OK|
| `--filter @b2b/web lint`     | n/a — package has no `lint` script (root lint covers it) |
| `--filter @b2b/web test:e2e` | **NOT RUN** — needs live PostgreSQL-backed API + web |

### Repo-wide

| Gate                  | Result                       |
| --------------------- | ---------------------------- |
| `pnpm typecheck`      | **PASS** — 18/18 tasks       |
| `pnpm lint`           | **PASS**                     |
| `pnpm build`          | **PASS** — 10/10 tasks       |
| `pnpm format:check`   | **PASS** — after a mechanical `prettier --write` of 15 pre-existing files (see §6) |
| `pnpm check:boundaries` | **PASS**                   |
| `pnpm check:no-skip`  | **PASS**                     |
| `pnpm check:docs`     | **PASS** — all links resolve |

### Backend (require real PostgreSQL — NOT RUN here)

| Gate                                              | Result   |
| ------------------------------------------------- | -------- |
| `--filter @b2b/api test:integration` (API gate)   | NOT RUN  |
| `--filter @b2b/database test:database-gate`       | NOT RUN  |
| `db:migrate:deploy` (clean DB, then 2nd time)     | NOT RUN  |
| `db:seed` ×2 (idempotency)                        | NOT RUN  |
| `db:drift` / `db:verify-catalog`                  | NOT RUN  |
| `prisma validate` / `prisma generate`             | NOT RUN  |

> No backend production, schema, domain, or contract files changed in this task
> (changes are limited to `apps/web` UI/test + docs), so the backend gates are
> unaffected by this PR. CI must still run them against a real PostgreSQL before
> merge. Last known-green backend run (per project memory, 2026-06-19): DB
> 133/133, API 475/475, 0 skipped.

---

## 6. Remaining non-blocking work

- Run the backend DB + API gates and the web Playwright smoke against a real
  PostgreSQL stack in CI (not possible in this local environment).
- README top-of-file status still reads "Foundation Milestone 1A"; consider
  refreshing it to reflect the implemented modules (left as-is here to avoid
  scope creep beyond demo polish).
- `format:check` was failing on **15 pre-existing** `apps/web` files (committed
  unformatted in earlier frontend commits; the gate had not been enforced on
  them). This task ran a whitespace-only `prettier --write` to make the gate
  green — no logic changed. Worth a guard in CI so it cannot regress.
- Reports tab clicks update state but do not push the `?tab=` back into the URL
  (deep-link in and same-route nav both work; only manual in-page tab clicks
  leave the URL on its prior value). Cosmetic.

---

## 7. Flows ready for demo

The full happy path is demo-ready against the local stack: **login → dashboard →
product (create/import/export) → warehouse → customer → draft order → approve →
ship → issue invoice → create return → approve return → issue credit note →
reports**. Step-by-step expected results are in
[DEMO_RUNBOOK.md §8](../demo/DEMO_RUNBOOK.md#8-demo-flow-happy-path-and-expected-results).

---

## 8. Before production

- Provision and run the **backend DB + API gates** and **web E2E** in CI against
  real PostgreSQL/Redis; treat anything skipped as a fail (gates are fail-closed).
- Replace every development secret in `.env` (`JWT_ACCESS_SECRET`,
  `PASSWORD_RESET_DELIVERY_KEY`, DB/S3/SMTP credentials) via a secret manager;
  set `NODE_ENV=production`; disable or auth-gate Swagger.
- Provision the bootstrap SYSTEM_ADMIN with a real argon2id hash; grant warehouse
  scope deliberately (no implicit scope exists).
- Decide on out-of-scope items for a later milestone: **PDF invoices/credit
  notes**, hosted deployment + pipeline, payments, notifications/email beyond
  password reset.
- Confirm append-only/immutability triggers and partial-unique indexes via
  `db:verify-catalog` on the production database after migrate-deploy.
