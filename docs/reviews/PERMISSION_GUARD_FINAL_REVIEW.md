# Permission Guard Final Review

Date: 2026-06-16

Scope: final aggregate review of the PermissionGuard/RBAC foundation fixes.

Production code changed: no. This review only inspected code, ran tests, and
added this document.

Result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Decision

No mandatory reject condition was hit.

- `PermissionGuard` is globally bound in the production `AppModule` after
  `JwtAuthGuard`.
- Permission-protected routes require JWT authentication plus the merged required
  permissions; public routes opt out with `@Public()`, and authenticated-only
  routes intentionally require JWT only.
- Permission, company and authz-version JWT claims are not trusted for
  authorization decisions.
- RBAC tenant isolation is enforced by DB composite FKs and by repository
  filters.
- Cross-company permission leakage and protected/SYSTEM_ADMIN tenant bypass were
  not reproduced.
- `user_roles` hard-delete cascade was replaced by RESTRICT.
- Authz cache stale allow, including two independent in-memory cache instances,
  was not reproduced.
- Full DB and API gates ran against real PostgreSQL with zero skipped tests.

## Aggregate Validations

| # | Validation | Result |
| --- | --- | --- |
| 1 | Global guard is active in production chain | PASS |
| 2 | Public route exception preserved; permission-protected routes require JWT + permissions | PASS |
| 3 | Controller + handler permission metadata merge | PASS |
| 4 | JWT permission/company/authzVersion claims are ignored for authz | PASS |
| 5 | Role/user/userRole tenant isolation is enforced in DB and repository | PASS |
| 6 | Cross-company permission leakage | PASS: not found/reproduced |
| 7 | SYSTEM_ADMIN/protected role tenant bypass | PASS: not found/reproduced |
| 8 | `user_roles` hard-delete cascade silently losing assignments | PASS: now RESTRICT |
| 9 | Authz cache stale allow | PASS: not found/reproduced |
| 10 | Multi-instance local cache stale allow | PASS: not found/reproduced |
| 11 | Clean DB migration deploy and second deploy | PASS |
| 12 | Seed idempotency | PASS |
| 13 | Drift and verify-catalog | PASS |
| 14 | Real PostgreSQL tests skipped | PASS: 0 skipped |
| 15 | Authentication regression | PASS |

## Code Review Notes

- `AppModule` registers global guards in order: `JwtAuthGuard` then
  `PermissionGuard` (`apps/api/src/app.module.ts:42`).
- `PermissionGuard` uses `getAllAndMerge` and de-duplicates controller/handler
  permission metadata (`apps/api/src/modules/authorization/guards/permission.guard.ts:43`).
- `JwtAuthGuard` builds `principal.companyId` from the DB user record, not token
  claims (`apps/api/src/modules/auth/guards/jwt-auth.guard.ts:73`).
- `PermissionRepository` reads authz version from `companyAuthzVersion` and
  resolves permissions only through same-company user, assignment and role rows
  (`apps/api/src/modules/authorization/permission.repository.ts:39`,
  `apps/api/src/modules/authorization/permission.repository.ts:48`).
- `PermissionService` reads DB authz version before every cache lookup and folds
  it into the cache version (`apps/api/src/modules/authorization/permission.service.ts:75`).
- Prisma models make users and roles company-scoped and `user_roles` composite
  FKs `onDelete: Restrict` (`packages/database/prisma/schema.prisma:265`,
  `packages/database/prisma/schema.prisma:415`,
  `packages/database/prisma/schema.prisma:471`).
- RBAC tenant backfill now fails closed on ambiguous legacy data, checksum guard
  blocks databases that already applied the unsafe backfill, delete-restrict
  migration removes silent assignment cascade, and authz-version migration adds
  per-company cache-version triggers.

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_permission_guard_final_review_test_20260616?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_permission_guard_final_review_shadow_20260616?schema=public`

| Command | Result |
| --- | --- |
| Clean DB `pnpm.cmd exec prisma migrate deploy` | PASS, 11 migrations applied |
| Second `pnpm.cmd exec prisma migrate deploy` | PASS, no pending migrations |
| `pnpm.cmd db:seed` twice | PASS, idempotent |
| `pnpm.cmd db:drift` | PASS, 0 unexpected drift |
| `pnpm.cmd db:verify-catalog` | PASS |
| `pnpm.cmd db:validate` | PASS |
| `pnpm.cmd db:generate` | PASS |
| PermissionGuard unit tests | PASS, 22/22 |
| API authz/cache/tenant/metadata/global guard targeted tests | PASS, 46/46 |
| DB tenant/cache/backfill/delete-restrict targeted tests | PASS, 41/41 |
| Full DB gate | PASS, 113/113 real PostgreSQL tests, 0 skipped |
| Full API integration gate | PASS, 130/130 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd format:check` | PASS |

## Non-Blocking Notes

1. Current production controllers are public or authenticated-only; the
   permission-protected behavior is runtime-proven with production `AppModule`
   probe controllers. When business controllers with `@RequirePermissions` are
   added, keep or extend route-classification coverage so missing permission
   metadata cannot drift in silently.
2. The current schema has no role `status` or `deletedAt`. Existing tests cover
   the present semantics: stripping grants denies immediately, role hard delete
   with active assignments is blocked, and role grant cascade is authz-version
   safe. If role soft-delete/status is added later, add repository filters and
   trigger tests for those fields.
3. The cache design intentionally reads `company_authz_versions` from
   PostgreSQL before every permission check. That is the security mechanism that
   prevents multi-instance stale allow; performance work should preserve the same
   revocation guarantee.

## Final Gate

**APPROVED_WITH_NON_BLOCKING_NOTES**

