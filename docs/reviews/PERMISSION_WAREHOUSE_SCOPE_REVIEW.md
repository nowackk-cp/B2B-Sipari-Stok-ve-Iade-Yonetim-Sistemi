# Permission Warehouse Scope Review

Date: 2026-06-16

Commit reviewed: `0d68c2eb902a5200eb2032d20c35a68245ff44fb`

Scope: review only of the Warehouse Scope Foundation fix. Production code was
not changed. This review inspected the requested source, migrations and tests,
ran the requested gates against real PostgreSQL, and added this document.

Result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Decision

No mandatory reject condition was hit.

- Cross-company warehouse scope grants are rejected by PostgreSQL composite FKs.
- `warehouse:scope:all` is evaluated only after the tenant gate, so it does not
  reach another company's warehouse.
- Legacy warehouse tenant backfill fails closed for multi-company data; an
  ad-hoc real PostgreSQL probe reproduced `WAREHOUSE_TENANT_BACKFILL_AMBIGUOUS`.
- `user_warehouse_scopes` changes bump company authz version in the same
  transaction, and rollback leaves no leaked bump.
- Warehouse scope decisions are resolved from PostgreSQL, not JWT authorization
  claims or role names.
- Targeted and full DB/API gates ran against real PostgreSQL with zero skipped
  tests.

## Validation Matrix

| # | Validation | Result |
| --- | --- | --- |
| 1 | `warehouses.company_id` is NOT NULL and tenant-scoped | PASS |
| 2 | Warehouse backfill fails closed for multi-company legacy data | PASS |
| 3 | `user_warehouse_scopes.company_id` is NOT NULL | PASS |
| 4 | `user_warehouse_scopes(user_id, company_id)` composite FK exists | PASS |
| 5 | `user_warehouse_scopes(warehouse_id, company_id)` composite FK exists | PASS |
| 6 | Cross-company warehouse scope insert is rejected by DB | PASS |
| 7 | User/warehouse hard delete does not silently cascade scope grants | PASS |
| 8 | Duplicate active scope is blocked by PK `(user_id, warehouse_id)` | PASS |
| 9 | Role name (`ADMIN`/`SYSTEM_ADMIN`) does not create implicit scope | PASS |
| 10 | `warehouse:scope:all` applies only to same-company warehouses | PASS |
| 11 | `warehouse:scope:all` does not allow another company's warehouse | PASS |
| 12 | Base permission without warehouse scope denies | PASS |
| 13 | Base permission plus explicit matching scope allows | PASS |
| 14 | Base permission plus different warehouse scope denies | PASS |
| 15 | Inactive/deleted user denies | PASS |
| 16 | Inactive/deleted warehouse denies | PASS |
| 17 | JWT company/warehouse claims are not trusted | PASS |
| 18 | Scope decision is resolved from PostgreSQL | PASS |
| 19 | Scope insert/update/delete bumps authzVersion | PASS |
| 20 | Transaction rollback rolls back the authzVersion bump | PASS |
| 21 | Tenant isolation, grant ceiling and authz cache version tests show no regression | PASS |
| 22 | `@b2b/database` / `@b2b/domain` `dist/` consumption is CI-safe | PASS |

## Code Review Evidence

- Migration `20260616040000_warehouse_scope_foundation` adds
  `warehouses.company_id`, fails closed unless legacy warehouses can be mapped to
  exactly one company, then enforces `NOT NULL`.
- The same migration adds `user_warehouse_scopes.company_id`, composite
  RESTRICT FKs to `users(id, company_id)` and `warehouses(id, company_id)`, and
  `authz_bump_user_warehouse_scopes`.
- Live catalog metadata confirmed:
  `warehouses.company_id` and `user_warehouse_scopes.company_id` are nullable
  `NO`; both composite FKs and `warehouses_company_id_fkey` are
  `ON DELETE RESTRICT`; `authz_bump_user_warehouse_scopes` exists.
- `WarehouseScopePolicy` evaluates: required permission, tenant gate,
  `warehouse:scope:all`, explicit scope, deny. The tenant gate precedes global
  scope.
- `WarehouseScopeService` resolves active/non-deleted actor, effective
  permissions, explicit warehouse scopes and active/non-deleted warehouse from
  PostgreSQL. It accepts only `actorUserId`, `warehouseId` and a required
  permission; it has no JWT claim input path.
- `PermissionRepository.loadEffectivePermissionCodes` is a fresh DB read scoped
  to same-company user, assignment and role rows.
- `AuthorizationModule` exports `WarehouseScopeService` but declares no HTTP
  controller for scope management in this commit.
- `turbo.json` uses `^build` for `build`, `typecheck`, `test` and integration
  tasks. I also rebuilt `@b2b/domain`, `@b2b/database` and `@b2b/api` directly
  with `tsc` and reran the warehouse scope API integration test against the
  rebuilt `dist/` outputs.

## Risk Checks

- No silent lowest/default company selection was found in warehouse backfill.
  The executable backfill requires exactly one company when legacy warehouses
  exist, and the ad-hoc real PostgreSQL probe failed with
  `WAREHOUSE_TENANT_BACKFILL_AMBIGUOUS` on two-company legacy data.
- `warehouse:scope:all` cannot bypass tenant isolation because policy checks
  actor company against warehouse company before checking the permission.
- Explicit scope revocation cannot leave stale warehouse access through the
  permission cache: scope changes bump company authz version in PostgreSQL, and
  `WarehouseScopeService` reads explicit scopes directly from PostgreSQL.
- Hard delete for `user_warehouse_scopes` is acceptable for current-state
  authorization data. The row is the grant; revocation deletes it, and audit is
  expected in the future management layer rather than in this foundation commit.
- API false green/red from stale package `dist/` was not reproduced after direct
  package rebuild and a repeated warehouse scope API integration run.

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_permission_guard_final_review_test_20260616?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_permission_guard_final_review_shadow_20260616?schema=public`

| Command | Result |
| --- | --- |
| Reset isolated test/shadow public schemas | PASS |
| Clean `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 12 migrations applied |
| Second `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 0 unexpected drift |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| Direct `@b2b/domain`, `@b2b/database`, `@b2b/api` builds | PASS |
| `pnpm.cmd --filter @b2b/domain exec vitest run test/warehouse-scope.test.ts` | PASS, 9/9 |
| `pnpm.cmd --filter @b2b/database exec vitest run --config vitest.integration.config.ts test/integration/warehouse-scope.test.ts test/integration/tenant-rbac.test.ts test/integration/tenant-backfill.test.ts test/integration/tenant-backfill-checksum-guard.test.ts test/integration/authz-cache-version.test.ts` | PASS, 47/47 |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/warehouse-scope.test.ts test/integration/authz-tenant-isolation.test.ts test/integration/authz-grant-ceiling.test.ts test/integration/authz-cache-version.test.ts test/integration/authz-permission-guard.test.ts` | PASS, 61/61 |
| Re-run warehouse scope API integration after direct dist rebuild | PASS, 12/12 |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/permission-guard.test.ts` | PASS, 22/22 |
| Warehouse backfill ad-hoc real PostgreSQL multi-company probe | PASS, failed closed with `WAREHOUSE_TENANT_BACKFILL_AMBIGUOUS` |
| `pnpm.cmd test:database-gate` | PASS, 125/125 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd test:integration:api` | PASS, 158/158 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |

## Non-Blocking Notes

1. The exact warehouse backfill fail-closed behavior was verified during this
   review with an ad-hoc real PostgreSQL probe, but there is no committed
   warehouse-specific migration backfill probe analogous to the RBAC tenant
   backfill tests. Adding one would make future migration edits safer.
2. `user_warehouse_scopes` hard delete is acceptable as current-state
   authorization. When the future scope-management endpoint is added, it should
   enforce grant ceiling/scope ceiling and write business audit in the same
   transaction.

## Final Gate

**APPROVED_WITH_NON_BLOCKING_NOTES**
