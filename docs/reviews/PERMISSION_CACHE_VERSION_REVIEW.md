# Permission Cache Version Review

Date: 2026-06-16

Reviewed commit: `da274cc1278b6842dbab5dcbac8ac55940e8818d`

Production code changed: no. This review only inspected code, ran tests, and added
this document.

Result: **FIX_APPROVED_WITH_NON_BLOCKING_NOTES**

## Decision

No reject condition was hit.

- No stale allow was reproduced after permission revoke, user-role removal,
  role-grant removal, disabled user, or two independent in-memory cache instances.
- `authzVersion` is read from PostgreSQL via
  `PermissionRepository.loadAuthzVersion`, not from JWT claims.
- The cache key shape is `companyId:userId:authzVersion:securityVersion`.
- Trigger bumps are transactional; rollback does not leave a leaked version bump.
- Full DB and API gates ran against real PostgreSQL with zero skipped tests.

## Code Review

- Cache freshness is DB-sourced: `PermissionService.getEffectivePermissions`
  reads `repo.loadAuthzVersion(subject.companyId)` before cache lookup and builds
  `authzVersion:securityVersion` (`apps/api/src/modules/authorization/permission.service.ts:64`,
  `apps/api/src/modules/authorization/permission.service.ts:75`).
- The in-memory adapter prefixes `companyId:userId`, making the full key
  `companyId:userId:authzVersion:securityVersion`
  (`apps/api/src/modules/authorization/adapters/in-memory-permission-cache.ts:32`).
- `PermissionRepository.loadAuthzVersion` reads `companyAuthzVersion.version`
  from PostgreSQL (`apps/api/src/modules/authorization/permission.repository.ts:39`).
- Effective permissions are scoped through active, not-deleted user, assignment
  company, and role company filters
  (`apps/api/src/modules/authorization/permission.repository.ts:48`).
- `JwtAuthGuard` builds principal `companyId` from the DB user record, not token
  claims (`apps/api/src/modules/auth/guards/jwt-auth.guard.ts:66`).
- `PermissionGuard` is globally bound after `JwtAuthGuard`
  (`apps/api/src/app.module.ts:42`).
- Migration creates `company_authz_versions`, backfills existing companies,
  creates the company insert baseline trigger, and creates triggers for
  `user_roles`, `role_permissions`, `roles`, and `users`
  (`packages/database/prisma/migrations/20260616030000_authorization_cache_version/migration.sql:50`,
  `packages/database/prisma/migrations/20260616030000_authorization_cache_version/migration.sql:64`,
  `packages/database/prisma/migrations/20260616030000_authorization_cache_version/migration.sql:99`,
  `packages/database/prisma/migrations/20260616030000_authorization_cache_version/migration.sql:216`).
- `CompanyAuthzVersion` is represented in Prisma schema
  (`packages/database/prisma/schema.prisma:243`).
- `verify-catalog` asserts the authz triggers and required
  `company_authz_versions` columns
  (`packages/database/scripts/verify-catalog.mjs:49`,
  `packages/database/scripts/verify-catalog.mjs:172`).

## Required Checks

| # | Check | Result |
| --- | --- | --- |
| 1 | Cache key includes company, user, authz version, and security version | PASS |
| 2 | `authzVersion` read from PostgreSQL, not JWT | PASS |
| 3 | Role permission removal denies without local cache clear | PASS |
| 4 | Role permission addition allows without local cache clear | PASS |
| 5 | UserRole removal cannot stale-allow | PASS |
| 6 | UserRole addition overcomes stale deny cache | PASS |
| 7 | Role inactive/soft-delete stale allow | PASS for current schema semantics: no role status/deletedAt field exists; stripping role grants and hard-delete/cascade safety are covered |
| 8 | User inactive/deleted stale allow | PASS |
| 9 | Two in-memory cache instances cannot stale-allow | PASS |
| 10 | Company A bump does not move Company B authz version/cache partition | PASS |
| 11 | Transaction rollback leaves no version bump | PASS |
| 12 | Login hot-path updates do not bump authz version | PASS |
| 13 | Cache adapter failures do not fail open | PASS |
| 14 | Tenant isolation and forged JWT company/authzVersion claims remain safe | PASS |
| 15 | Triggers bump only the relevant company version | PASS |
| 16 | `role_permissions` trigger is safe during role delete/cascade | PASS |
| 17 | Company insert creates baseline `company_authz_versions` row | PASS |
| 18 | Existing companies get migration backfill baseline row | PASS |
| 19 | Drift and verify-catalog cover trigger/column checks | PASS |
| 20 | Full DB/API gates ran in real PostgreSQL with no skips | PASS |

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_perm_cache_review_test_20260616?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_perm_cache_review_shadow_20260616?schema=public`

Commands:

| Command | Result |
| --- | --- |
| Clean DB `pnpm.cmd exec prisma migrate deploy` | PASS, 11 migrations applied |
| Second `pnpm.cmd exec prisma migrate deploy` | PASS, no pending migrations |
| API authz-cache-version test | PASS, 11/11 |
| DB authz-cache-version test | PASS, 6/6 |
| PermissionGuard unit test | PASS, 22/22 |
| Authz permission guard integration test | PASS, 15/15 |
| Authz tenant isolation integration test | PASS, 7/7 |
| DB tenant-rbac integration test | PASS, 8/8 |
| Full DB gate | PASS, 113/113 real PostgreSQL tests, 0 skipped |
| Full API gate | PASS, 130/130 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd db:seed` twice | PASS, idempotent |
| Backfill simulation: apply pre-authz migrations, insert existing company, apply authz migration | PASS, baseline row `version=1` created |
| `pnpm.cmd db:drift` | PASS, 0 unexpected drift |
| `pnpm.cmd db:verify-catalog` | PASS |
| `pnpm.cmd db:validate` | PASS after setting `DATABASE_URL` |
| `pnpm.cmd db:generate` | PASS |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |

## Non-Blocking Notes

1. Every permission check now pays one PostgreSQL read for
   `company_authz_versions`. That is an intentional security tradeoff in this
   design: it makes multi-instance stale allow structurally unreachable. If this
   becomes hot, optimize around the version read only with a design that preserves
   the same revocation guarantee.
2. The schema has no role `status` or `deletedAt` column. Current coverage proves
   the equivalent present-day behaviors: stripping grants denies immediately, and
   role delete with grant cascade is trigger-safe. If role soft-delete/status is
   added later, repository filters and trigger tests should be extended.
3. The API test named "Company A bump does not disturb Company B" mainly proves
   the company-scoped key path for A; DB tests prove B's version is unchanged and
   tenant/cache tests prove company partitioning. A future API test with a warm
   Company B cache would make that coverage more direct.

