# Customer Management Foundation Review

Date: 2026-06-17

Commit reviewed: `f689a426a6fd2307a8c1338ff398d455f86a3a57`

Scope: review only of the Customer Management API Foundation commit.
Production code was not changed. This review inspected the requested source,
migration, Prisma schema, contracts and tests, ran the requested gates against
real PostgreSQL, and added this document.

Result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Findings

No blocking findings.

## Non-Blocking Notes

1. The requested paths `docs/architecture/PERMISSION_MATRIX.md` and
   `docs/architecture/API_CONVENTIONS.md` do not exist in this repo. I reviewed
   the actual canonical files `docs/PERMISSION_MATRIX.md` and
   `docs/API_CONVENTIONS.md` instead.
2. `CustomerAddress` remains out of this API slice. There is no partial
   controller/service integration or TODO in `apps/api/src/modules/customers`,
   and the DB default-address invariant is covered. The pre-existing
   `customer_addresses.customer_id` FK is `ON DELETE CASCADE`, but the Customer
   API only soft-deletes customers and exposes no hard-delete path.
3. The customer tenant backfill migration is fail-closed on existing data: if
   legacy customers exist with zero or multiple companies, it aborts and requires
   an explicit mapping migration. This is safe, but it is an operational rollout
   requirement for non-empty legacy environments.

## Validation Matrix

| # | Validation | Result |
| --- | --- | --- |
| 1 | Customer is company-scoped | PASS: `customers.company_id` is NOT NULL with RESTRICT FK; Prisma has `companyId`; repository/service scope every read/write by actor company. |
| 2 | `companyId` is not read from request body and body `companyId` returns 400 | PASS: DTO has no `companyId`, global ValidationPipe uses `forbidNonWhitelisted`, and customer integration test covers 400. |
| 3 | Actor company comes from PostgreSQL principal | PASS: `JwtAuthGuard` resolves user from DB and sets `principal.companyId = user.companyId`. |
| 4 | Forged JWT `companyId` does not change result | PASS: customer integration test for forged signed token still sees only the DB principal company. |
| 5 | Cross-company get/update/delete hides existence | PASS: resolve path filters by `publicId`, `companyId`, `deletedAt: null`; tests assert 404 and unchanged cross-tenant rows. |
| 6 | Same-company duplicate customer code rejected | PASS: API returns 409; DB partial unique is `(company_id, code) WHERE deleted_at IS NULL`. |
| 7 | Different-company same customer code accepted | PASS: integration test covers cross-company duplicate code acceptance. |
| 8 | Soft-deleted customers hidden from list/get | PASS: repository lists/gets only `deletedAt: null`; integration test covers list and get after delete. |
| 9 | Soft-delete code reuse decision tested | PASS: integration test verifies reuse creates a new row after soft delete. |
| 10 | CustomerAddress safely out of scope | PASS with note: no customer-address API integration in this commit; DB default-address uniqueness tests pass. |
| 11 | Create/update/delete business audit same transaction | PASS: service writes audit through the same `tx` used for mutation; create audit is integration-tested and full API audit rollback tests pass. |
| 12 | PermissionGuard global chain used; no local controller guard | PASS: AppModule binds `JwtAuthGuard` then `PermissionGuard`; CustomersController has no `@UseGuards`. |
| 13 | Route permission matrix correct | PASS: create/read/update/delete map to `customer:create/read/update/delete`, matching permission matrix and RBAC seed. |
| 14 | No role-name branch | PASS: customer module does not branch on role names; only audit snapshot records role names. |
| 15 | Pagination/search/filter correct and safe | PASS: limit max 100, cursor validated, type whitelisted, search is Prisma-parameterized and tenant/soft-delete scoped. |
| 16 | RFC7807 + requestId preserved | PASS: customer not-found test asserts `application/problem+json` and `requestId`. |
| 17 | Swagger/OpenAPI response schemas non-empty | PASS: explicit response DTOs and customer OpenAPI tests cover create/list/get/update/delete schemas. |
| 18 | No order/invoice/balance/debt business logic added | PASS: static search found no customer module behavior for order, invoice, payment, balance, receivable or payable logic. |
| 19 | Product/Warehouse/Stock/Transfer/RBAC regressions | PASS: full API and DB gates passed; focused Product, Warehouse, Stock, Transfer, RBAC/cache tests passed. |
| 20 | Drift/verify-catalog cover customer partial unique and company FK | PASS: drift allowlist includes customer `(company_id, code)` unique; verify-catalog asserts `customers_code_key`, `customers_company_id_fkey`, and NOT NULL `customers.company_id`. |

## Code Review Evidence

- Customer migration adds `company_id`, fail-closed backfill, NOT NULL, tenant
  index, RESTRICT company FK, and company-scoped partial unique:
  `packages/database/prisma/migrations/20260617130000_customer_company_scope/migration.sql:24`,
  `packages/database/prisma/migrations/20260617130000_customer_company_scope/migration.sql:33`,
  `packages/database/prisma/migrations/20260617130000_customer_company_scope/migration.sql:58`,
  `packages/database/prisma/migrations/20260617130000_customer_company_scope/migration.sql:62`,
  `packages/database/prisma/migrations/20260617130000_customer_company_scope/migration.sql:71`.
- Prisma `Customer` has `companyId`, RESTRICT company relation, composite
  unique metadata and company index:
  `packages/database/prisma/schema.prisma:856`,
  `packages/database/prisma/schema.prisma:863`,
  `packages/database/prisma/schema.prisma:874`,
  `packages/database/prisma/schema.prisma:886`,
  `packages/database/prisma/schema.prisma:887`.
- Customer repository scopes list/get by company and soft-delete:
  `apps/api/src/modules/customers/customer.repository.ts:98`,
  `apps/api/src/modules/customers/customer.repository.ts:110`,
  `apps/api/src/modules/customers/customer.repository.ts:121`.
- Customer service uses `actor.companyId`, hides cross-company rows through
  404, and writes audit inside the same transaction:
  `apps/api/src/modules/customers/customers.service.ts:58`,
  `apps/api/src/modules/customers/customers.service.ts:59`,
  `apps/api/src/modules/customers/customers.service.ts:60`,
  `apps/api/src/modules/customers/customers.service.ts:108`,
  `apps/api/src/modules/customers/customers.service.ts:110`,
  `apps/api/src/modules/customers/customers.service.ts:131`,
  `apps/api/src/modules/customers/customers.service.ts:133`,
  `apps/api/src/modules/customers/customers.service.ts:150`.
- Strict body validation excludes `companyId`:
  `apps/api/src/bootstrap.ts:23`,
  `apps/api/src/bootstrap.ts:26`,
  `apps/api/src/modules/customers/dto/create-customer.dto.ts:15`.
- JWT principal company is DB-resolved:
  `apps/api/src/modules/auth/guards/jwt-auth.guard.ts:61`,
  `apps/api/src/modules/auth/guards/jwt-auth.guard.ts:70`,
  `apps/api/src/modules/auth/guards/jwt-auth.guard.ts:73`.
- Customer controller uses global guard chain plus per-route permissions and
  explicit OpenAPI response DTOs:
  `apps/api/src/app.module.ts:50`,
  `apps/api/src/app.module.ts:51`,
  `apps/api/src/modules/customers/customers.controller.ts:56`,
  `apps/api/src/modules/customers/customers.controller.ts:68`,
  `apps/api/src/modules/customers/customers.controller.ts:87`,
  `apps/api/src/modules/customers/customers.controller.ts:101`.
- Customer tests cover tenant isolation, forged JWT, body `companyId`,
  duplicate/reuse semantics, cross-company update/delete 404, search,
  pagination, RFC7807, permission checks and create audit:
  `apps/api/test/integration/customers.test.ts:121`,
  `apps/api/test/integration/customers.test.ts:148`,
  `apps/api/test/integration/customers.test.ts:173`,
  `apps/api/test/integration/customers.test.ts:187`,
  `apps/api/test/integration/customers.test.ts:199`,
  `apps/api/test/integration/customers.test.ts:224`,
  `apps/api/test/integration/customers.test.ts:246`,
  `apps/api/test/integration/customers.test.ts:272`,
  `apps/api/test/integration/customers.test.ts:285`,
  `apps/api/test/integration/customers.test.ts:308`,
  `apps/api/test/integration/customers.test.ts:346`,
  `apps/api/test/integration/customers.test.ts:359`,
  `apps/api/test/integration/customers.test.ts:387`.
- Customer OpenAPI tests assert non-empty response schemas:
  `apps/api/test/integration/customers-openapi.test.ts:38`,
  `apps/api/test/integration/customers-openapi.test.ts:44`,
  `apps/api/test/integration/customers-openapi.test.ts:49`,
  `apps/api/test/integration/customers-openapi.test.ts:54`,
  `apps/api/test/integration/customers-openapi.test.ts:66`.
- Drift and catalog verification include customer checks:
  `packages/database/scripts/drift-eval.mjs:12`,
  `packages/database/scripts/verify-catalog.mjs:112`,
  `packages/database/scripts/verify-catalog.mjs:182`,
  `packages/database/scripts/verify-catalog.mjs:210`.

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:***@127.0.0.1:55432/b2b_customer_review_test_20260617_codex?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:***@127.0.0.1:55432/b2b_customer_review_shadow_20260617_codex?schema=public`

| Command | Result |
| --- | --- |
| Clean DB create for review test/shadow databases | PASS |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 16 migrations applied including `20260617130000_customer_company_scope` |
| Second `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable: 65 permissions, 6 roles, 210 role permissions |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| Live pg_catalog check for `customers_code_key`, `customers_company_id_fkey`, `customers.company_id`, `customers.email` | PASS |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| PermissionGuard unit test | PASS, 22/22 |
| DB focused tenant/RBAC/cache/transfer/address/migration run | PASS, 44/44 |
| Focused API run for customer/product/warehouse/stock/transfer/RBAC/cache files | PASS in vitest output, 157/157; shell harness timeout was hit at 301s after completion output, so full API gate below is the authoritative pass |
| `pnpm.cmd test:integration:api` | PASS, 305/305 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd test:database-gate` | PASS, 133/133 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |

## Final Gate

**APPROVED_WITH_NON_BLOCKING_NOTES**
