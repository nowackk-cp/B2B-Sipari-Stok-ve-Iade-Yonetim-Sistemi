# Warehouse Management API Foundation Review

Date: 2026-06-16

Commit reviewed: `cc8dc06d82b41d5ae6d861993699de8e8798ba1b`

Scope: review only of the Warehouse Management API Foundation commit.
Production code was not changed. This review inspected the requested
architecture/review docs, migration, Prisma models, API module/controller/service
/repository/scope service, tests, audit changes, contracts, generated OpenAPI,
and reran the requested gates against real PostgreSQL.

Result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Findings

No blocking findings. None of the mandatory reject conditions were hit.

## Validation Matrix

| # | Validation | Result |
| --- | --- |
| 1 | Warehouse is company-scoped | PASS: `warehouses.company_id` is NOT NULL, FK RESTRICT, repository reads/writes are filtered by actor company. |
| 2 | `companyId` body not accepted | PASS: DTO has no `companyId`; global whitelist rejects it with 400; integration test covers create. |
| 3 | Actor company comes from PostgreSQL principal | PASS: service uses `AuthPrincipal.companyId`, which is DB-resolved by auth guard. |
| 4 | Forged JWT company/warehouse claims ignored | PASS: warehouse integration test proves forged `companyId`/`warehouseId` does not alter list/get. |
| 5 | Cross-company get/update/delete hides existence | PASS: all return 404 and leave the other tenant row untouched. |
| 6 | `warehouse:read` without scope | PASS: list returns empty page; same-company get returns 403 per documented safe behavior. |
| 7 | `warehouse:read` + explicit scope | PASS: list/get only the assigned warehouse. |
| 8 | `warehouse:read` + `warehouse:scope:all` | PASS: lists all same-company warehouses only. |
| 9 | `warehouse:scope:all` no tenant bypass | PASS: other-company warehouse stays hidden by list and get returns 404. |
| 10 | Get/update/delete require warehouse scope | PASS: same-company out-of-scope get/update/delete return 403; scoped targets work. |
| 11 | ADMIN/SYSTEM_ADMIN role-name bypass | PASS: scope service has no role-name branch; ADMIN without scope denies; SYSTEM_ADMIN does not cross tenant. |
| 12 | Same-company duplicate code | PASS: API returns 409 and DB partial unique enforces it. |
| 13 | Different-company same code | PASS: API allows it. |
| 14 | Soft-deleted warehouse hidden | PASS: list excludes it and get returns 404. |
| 15 | Code reuse after soft-delete | PASS: API test covers reuse; migration documents partial-unique decision. |
| 16 | No stock quantity/ledger/balance added | PASS: commit did not add warehouse stock state, ledger, or balance behavior. |
| 17 | Mutation audit same transaction | PASS: create/update/delete write audit with the same Prisma transaction handle. |
| 18 | Global PermissionGuard chain | PASS: `AppModule` binds `JwtAuthGuard` then `PermissionGuard`; controller has no local `@UseGuards`. |
| 19 | Route permission matrix | PASS for runtime/seed: routes use `warehouse:create/read/update/delete`, all exist in domain RBAC and are seeded to ADMIN/SYSTEM_ADMIN. See non-blocking doc note below. |
| 20 | RFC7807 + requestId | PASS: integration tests cover not-found and guard errors with problem+json/requestId. |
| 21 | OpenAPI response schemas | PASS: generated spec has non-empty 201/200 schemas and DELETE 204 no-content. |
| 22 | Product/scope/grant/tenant/cache regressions | PASS: focused and full API/DB gates passed with 0 skipped. |

## Risk Checks

- `warehouses_code_key` migration is clean for a DB already at the prior
  warehouse-scope state: the old global partial unique index exists, is dropped,
  and is recreated as `(company_id, code) WHERE deleted_at IS NULL` with the same
  name.
- Clean deploy and a second deploy both passed.
- Drift allowlist includes exactly the company-scoped warehouse partial unique:
  `CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("company_id", "code")`.
- `verify-catalog` requires `warehouses_code_key` to be partial, unique, and to
  contain both `deleted_at` and `company_id`.
- `GET /warehouses` without scope returns an empty list, matching
  `SECURITY_MODEL` list-filter behavior and avoiding same-company data leakage.
- `POST /warehouses` does not auto-grant explicit warehouse scope; this is
  documented in service comments and covered by integration test.
- `resolveWarehouseAccess` only returns the DB-resolved actor access envelope;
  the repository still unconditionally filters by `actor.companyId`.
- Dist consumption was checked after `pnpm.cmd build`: built domain dist includes
  `warehouse:create/update/delete`, and built API controller contains the
  expected route metadata.
- Warehouse hard delete / soft delete / `user_warehouse_scopes` RESTRICT behavior
  remains covered by DB warehouse-scope and full database gates.

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_warehouse_management_review_test_20260616?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_warehouse_management_review_shadow_20260616?schema=public`

| Command | Result |
| --- | --- |
| Create isolated test/shadow databases | PASS |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` on clean DB | PASS, 14 migrations applied |
| `pnpm.cmd --filter @b2b/database db:migrate:deploy` second run | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| Built dist permission/controller inspection | PASS |
| Warehouse API integration + OpenAPI tests | PASS, 29/29 real PostgreSQL/API tests |
| Product integration tests and authz regression tests | PASS, 83/83 real PostgreSQL/API tests |
| PermissionGuard unit tests | PASS, 22/22 |
| Domain warehouse-scope/RBAC tests | PASS, 18/18 |
| DB warehouse-scope + seed integration tests | PASS, 21/21 real PostgreSQL tests |
| `pnpm.cmd test:integration:api` | PASS, 216/216 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd test:database-gate` | PASS, 125/125 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd --filter @b2b/api openapi:json` | PASS, generated warehouse schemas verified |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |

Note: an earlier attempted parallel run mixed API and DB integration tests
against the same database and produced reset/TRUNCATE deadlocks. That run was
discarded as an invalid harness invocation; the serial reruns above are the
valid gate results.

## Non-Blocking Notes

1. `docs/PERMISSION_MATRIX.md` still documents warehouses as
   `warehouse:read / warehouse:manage`, while the runtime route matrix and domain
   RBAC catalog now use granular `warehouse:create`, `warehouse:update`, and
   `warehouse:delete` for mutations. Enforcement is safe because the granular
   permissions exist, are seeded to ADMIN/SYSTEM_ADMIN, and are tested, but the
   document should be updated to avoid operator/role-design drift.
2. `docs/architecture/DATABASE_DESIGN.md` still describes warehouse code
   uniqueness in older global terms. The live migration/schema/tests are
   company-scoped and verified; the architecture text should be brought in line.

## Final Gate

**APPROVED_WITH_NON_BLOCKING_NOTES**
