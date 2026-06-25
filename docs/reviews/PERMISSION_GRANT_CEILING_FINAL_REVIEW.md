# RBAC Grant Ceiling Final Review

Date: 2026-06-16

Commit reviewed: `66eb74d9dcca6d15feeca19b27c5df163eac69ab`

Scope: review only of the RBAC grant-ceiling foundation. Production code was not
changed. This review inspected the requested source/tests, ran the requested
gates against real PostgreSQL, and added this document.

Result: **APPROVED**

## Decision

No mandatory reject condition was hit.

- Cross-company grant paths deny.
- Actor company, effective permissions and max privilege are resolved from
  PostgreSQL, not JWT authorization claims.
- An actor cannot add or assign permissions outside their own effective set.
- Protected role/permission changes require `role:manage:protected`, and that
  permission is necessary but not sufficient.
- Same-company checks apply to actor, target user and target role on role
  assignment/removal paths; role-permission paths bind actor and target role.
- Grant decisions use the uncached `PermissionRepository` DB read, not the stale
  authz cache.
- `is_protected` drives protected-grant behavior; `is_system` does not by itself
  create protected handling, matching the ADMIN vs SYSTEM_ADMIN model.
- No HTTP endpoint/controller was added in the authorization module.
- Real PostgreSQL targeted and full gate tests executed with zero skipped tests.

## Validation Matrix

| # | Validation | Result |
| --- | --- | --- |
| 1 | Actor and target in different companies are rejected | PASS |
| 2 | Actor company/permission data comes from PostgreSQL, not JWT | PASS |
| 3 | Actor cannot add a permission they do not hold to a role | PASS |
| 4 | Actor cannot assign a role containing a permission they do not hold | PASS |
| 5 | Actor cannot assign a role to another-company user | PASS |
| 6 | Actor cannot assign another-company role | PASS |
| 7 | SYSTEM_ADMIN cannot grant into another company | PASS |
| 8 | Protected role requires `role:manage:protected` | PASS |
| 9 | `role:manage:protected` alone is not enough; ceiling still applies | PASS |
| 10 | Actor cannot grant themselves a higher role | PASS |
| 11 | Actor cannot add a permission they lack to their own role | PASS |
| 12 | Permission/role removal paths do not create an escalation side-channel | PASS |
| 13 | Deleted role cannot be assigned; current schema has no role inactive/soft-delete state | PASS |
| 14 | Inactive/deleted user cannot be a target | PASS |
| 15 | Grant decisions use fresh DB reads, not stale authz cache entries | PASS |
| 16 | Deny-by-default behavior is preserved for unresolved actors/targets and missing capabilities | PASS |
| 17 | `is_protected` vs `is_system` behavior aligns with SECURITY_MODEL | PASS |
| 18 | No HTTP endpoint/controller was added | PASS |
| 19 | Tenant isolation, cache version and PermissionGuard regressions were not found | PASS |

## Code Review Evidence

- `GrantCeilingPolicy.canAssignRoleToUser` checks tenant, base permission,
  protected grant, privilege level and permission ceiling
  (`packages/domain/src/authz/grant-ceiling.ts:122`).
- `canRemoveRoleFromUser` delegates to the assign rule, and
  `canRemovePermissionFromRole` delegates to the add-permission rule, so removal
  is gated symmetrically (`packages/domain/src/authz/grant-ceiling.ts:150`,
  `packages/domain/src/authz/grant-ceiling.ts:190`).
- `AuthorizationGrantService.resolveActor` reads active, non-deleted actor data
  from PostgreSQL and calls `PermissionRepository.loadEffectivePermissionCodes`
  directly (`apps/api/src/modules/authorization/authorization-grant.service.ts:53`,
  `apps/api/src/modules/authorization/authorization-grant.service.ts:68`).
- Target users must be active and non-deleted; missing/deleted roles and
  permissions resolve to explicit deny results
  (`apps/api/src/modules/authorization/authorization-grant.service.ts:77`,
  `apps/api/src/modules/authorization/authorization-grant.service.ts:89`,
  `apps/api/src/modules/authorization/authorization-grant.service.ts:109`).
- `PermissionRepository.loadEffectivePermissionCodes` scopes every hop to the
  company and active user, and `PermissionService` loads DB authz version before
  cache lookup (`apps/api/src/modules/authorization/permission.repository.ts:48`,
  `apps/api/src/modules/authorization/permission.service.ts:75`).
- `JwtAuthGuard` derives `principal.companyId` and roles from the DB user row,
  not token-supplied company/permission claims
  (`apps/api/src/modules/auth/guards/jwt-auth.guard.ts:61`,
  `apps/api/src/modules/auth/guards/jwt-auth.guard.ts:73`).
- Prisma role/user-role schema is company scoped; `user_roles` composite FKs
  restrict cross-company assignment and hard-delete cascade
  (`packages/database/prisma/schema.prisma:415`,
  `packages/database/prisma/schema.prisma:471`,
  `packages/database/prisma/schema.prisma:488`).
- `AuthorizationModule` only registers/exports providers and declares no
  controller (`apps/api/src/modules/authorization/authorization.module.ts:22`).

## Risk Checks

- `canRemovePermissionFromRole` does not let an actor remove a permission they
  lack: it reuses `canAddPermissionToRole`, including the actor-permission
  ceiling.
- An actor cannot first remove an above-ceiling permission from a role to make it
  assignable, because removing that lacking permission is itself denied.
- `canRemoveRoleFromUser` reuses the assignment rule, so removing a protected,
  cross-tenant or above-ceiling role is not a bypass path.
- Protected/system split is not exploitable in the reviewed code: protected
  enforcement keys on `isProtected`; non-protected system roles such as ADMIN
  remain normally manageable but still bounded by tenant, privilege and ceiling.
- Privilege comparison denies only when `actor.maxPrivilegeLevel <
  targetRole.privilegeLevel`; equal-or-lower target roles still require the
  actor to hold every conferred permission and any protected-grant permission.
- Same-company checks are present for actor/user/role assignment paths. Catalog
  permissions are global by design, while role-permission edits still bind actor
  and target role to the same company.

## Tests Run

Environment:

- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_grant_ceiling_final_review_test_20260616?schema=public`
- `SHADOW_DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_grant_ceiling_final_review_shadow_20260616?schema=public`

| Command | Result |
| --- | --- |
| Clean DB `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, 11 migrations applied |
| Second `pnpm.cmd --filter @b2b/database db:migrate:deploy` | PASS, no pending migrations |
| `pnpm.cmd --filter @b2b/database db:seed` twice | PASS, idempotent counts stable |
| `pnpm.cmd --filter @b2b/database db:drift` | PASS, 0 unexpected drift |
| `pnpm.cmd --filter @b2b/database db:verify-catalog` | PASS |
| `pnpm.cmd --filter @b2b/database db:validate` | PASS |
| `pnpm.cmd --filter @b2b/database db:generate` | PASS |
| `pnpm.cmd --filter @b2b/domain exec vitest run test/grant-ceiling.test.ts` | PASS, 16/16 |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/permission-guard.test.ts` | PASS, 22/22 |
| Targeted API authz integration files | PASS, 62/62 real PostgreSQL tests |
| Targeted DB authz cache version + tenant-rbac files | PASS, 14/14 real PostgreSQL tests |
| `pnpm.cmd test:database-gate` | PASS, 113/113 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd test:integration:api` | PASS, 146/146 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:boundaries` | PASS |

## Final Gate

**APPROVED**
