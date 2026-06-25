# Permission RBAC Delete Restrict Review

Date: 2026-06-16

Reviewed commit: `530b081244e317cb390f7192ede37cf4011d862d`

Production code changed by this review: no. This review only inspected code, ran tests, and added this document.

Result: **FIX_APPROVED_WITH_NON_BLOCKING_NOTES**

## Scope Read

- `docs/reviews/PERMISSION_TENANT_ISOLATION_REVIEW.md`
- `docs/reviews/PERMISSION_TENANT_BACKFILL_FOLLOWUP_REVIEW.md`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20260616020000_rbac_user_roles_delete_restrict/migration.sql`
- `packages/database/test/integration/rbac-user-roles-delete-restrict.test.ts`
- `packages/database/scripts/verify-catalog.mjs`
- `packages/database/test/integration/tenant-rbac.test.ts`
- `packages/database/prisma/migrations/20260616000000_rbac_company_tenant_scope/migration.sql`
- `packages/database/prisma/migrations/20260616010000_rbac_tenant_backfill_checksum_guard/migration.sql`
- Commit metadata/diff for `530b081244e317cb390f7192ede37cf4011d862d`

## Verdict Rationale

The RBAC user-role hard-delete cascade risk is closed for active assignments. The new additive migration re-creates both `user_roles` composite FKs with `ON DELETE RESTRICT ON UPDATE CASCADE`, preserving the tenant composite-FK guarantee while refusing to silently erase assignments during user/role hard deletes.

Live PostgreSQL catalog confirmed:

- `user_roles_user_id_company_id_fkey`: `ON DELETE RESTRICT`, `ON UPDATE CASCADE`
- `user_roles_role_id_company_id_fkey`: `ON DELETE RESTRICT`, `ON UPDATE CASCADE`
- `users_company_id_fkey`: `ON DELETE RESTRICT`, `ON UPDATE CASCADE`
- `roles_company_id_fkey`: `ON DELETE RESTRICT`, `ON UPDATE CASCADE`

The fix is correctly additive. Commit `530b081` did not modify `20260616000000_rbac_company_tenant_scope` or `20260616010000_rbac_tenant_backfill_checksum_guard`; it adds `20260616020000_rbac_user_roles_delete_restrict`, updates the Prisma relation metadata, extends catalog verification, and adds a real-PostgreSQL integration test.

## Required Validations

| # | Validation | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `user_roles(user_id, company_id)` -> `users(id, company_id)` is `ON DELETE RESTRICT` | PASS | Live catalog `confdeltype='r'`; constraint definition says `ON DELETE RESTRICT`. |
| 2 | `user_roles(role_id, company_id)` -> `roles(id, company_id)` is `ON DELETE RESTRICT` | PASS | Live catalog `confdeltype='r'`; constraint definition says `ON DELETE RESTRICT`. |
| 3 | `ON UPDATE CASCADE` and composite tenant guarantee preserved | PASS | Both composite FKs retain `confupdtype='c'`; cross-company assignment tests still fail at DB level. |
| 4 | `companies -> users/roles` RESTRICT policy preserved | PASS | `users_company_id_fkey` and `roles_company_id_fkey` remain `ON DELETE RESTRICT ON UPDATE CASCADE`. |
| 5 | `20260616000000_rbac_company_tenant_scope` unchanged by this commit | PASS | `git show --name-only 530b081` excludes this migration. |
| 6 | `20260616010000_rbac_tenant_backfill_checksum_guard` unchanged by this commit | PASS | `git show --name-only 530b081` excludes this migration. |
| 7 | Role hard delete with UserRole present is DB-rejected | PASS | `rbac-user-roles-delete-restrict.test.ts` 2/6 passed; assignment and role row survive. |
| 8 | User hard delete with UserRole present is DB-rejected or blocked by trigger | PASS | Test 1 rejects with assignment present; test 4 confirms `no_delete_users` still blocks after assignment removal. |
| 9 | Role hard delete after UserRole removal is possible | PASS | Test 3 explicitly deletes `user_roles` first, then role delete succeeds. |
| 10 | Cross-company assignment still DB-rejected | PASS | Delete-restrict test 5 and tenant-rbac cross-company tests passed. |
| 11 | Seed remains idempotent | PASS | `db:seed` twice: 61 permissions, 6 roles, 201 rolePermissions, 1 company on both runs. |
| 12 | Drift and verify-catalog inspect these FKs correctly | PASS | Drift clean; `verify-catalog.mjs` now requires both `user_roles_*_company_id_fkey` constraints to be non-cascading and passed. |
| 13 | Tenant isolation tests show no regression | PASS | DB tenant-rbac 8/8 and API authz tenant isolation 7/7 passed. |
| 14 | Full DB gate green on real PostgreSQL without skips | PASS | `Database gate: 107/107 real PostgreSQL tests executed, 0 skipped.` |

## Non-blocking Note

`role_permissions.role_id` still has `ON DELETE CASCADE`. This remains in the explicitly out-of-scope area for this fix and is non-blocking because an active user permission assignment path is now guarded: when a role has a `user_roles` assignment, role hard delete is rejected before any `role_permissions` cascade can remove grants. I also ran a live transaction probe with both `user_roles` and `role_permissions` present; role delete was blocked and both rows were preserved.

If the product later supports hard-deleting unassigned custom roles, that path should still be explicitly audited and invalidate/refresh authorization cache state, because deleting an unassigned role will cascade its role-permission grant rows.

## Command Results

All database checks used isolated PostgreSQL 16.9 databases at `localhost:55432`.

| Check | Result |
| --- | --- |
| Clean DB `pnpm --filter @b2b/database db:migrate:deploy` | PASS, 10 migrations applied including `20260616020000_rbac_user_roles_delete_restrict`. |
| Second `pnpm --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations. |
| Live catalog FK query | PASS, two `user_roles` composite FKs are `RESTRICT/CASCADE`; `users/roles -> companies` remain `RESTRICT/CASCADE`. |
| Role-permission cascade probe with active `user_roles` | PASS, role delete blocked and `role_permissions` preserved. |
| `rbac-user-roles-delete-restrict.test.ts` | PASS, 6/6. |
| `tenant-rbac.test.ts` | PASS, 8/8. |
| `authz-tenant-isolation.test.ts` | PASS, 7/7. |
| `tenant-backfill-checksum-guard.test.ts` | PASS, 11/11. |
| `pnpm --filter @b2b/database test:database-gate` | PASS, 107/107 real PostgreSQL tests, 0 skipped. |
| `pnpm --filter @b2b/database db:seed` twice | PASS, idempotent. |
| `pnpm --filter @b2b/database db:drift` | PASS, 5 allowlisted partial-unique statements, 0 unexpected. |
| `pnpm --filter @b2b/database db:verify-catalog` | PASS. |
| `pnpm --filter @b2b/database db:validate` | PASS. |
| `pnpm --filter @b2b/database db:generate` | PASS. |
| `pnpm typecheck` | PASS, 18/18 tasks. |
| `pnpm lint` | PASS. |
| `pnpm format:check` | PASS. |
| `pnpm build` | PASS, 10/10 tasks. |
| `pnpm check:no-skip` | PASS. |

## Final Gate

**FIX_APPROVED_WITH_NON_BLOCKING_NOTES**
