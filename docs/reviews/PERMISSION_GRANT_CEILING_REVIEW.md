# RBAC Grant Ceiling Foundation Review

Date: 2026-06-16

Scope: add the **grant-ceiling** authorization foundation — a pure domain policy
plus a DB-backed service — so a future role/user-role/permission management
surface cannot let an actor grant above their own authority. No HTTP endpoint,
warehouse-scope, frontend, guard-binding, metadata-merge, tenant/cache migration
or business module was touched.

Result: **APPROVED**

## What was added

- **`GrantCeilingPolicy`** (`packages/domain/src/authz/grant-ceiling.ts`) — a
  pure, framework-independent decision module (no DB, no Nest). Four total
  functions: `canAssignRoleToUser`, `canRemoveRoleFromUser`,
  `canAddPermissionToRole`, `canRemovePermissionFromRole`. Each returns
  `{ allowed: true } | { allowed: false; reason }` with a stable `GrantDenyReason`.
- **`AuthorizationGrantService`**
  (`apps/api/src/modules/authorization/authorization-grant.service.ts`) — the
  DB-backed orchestrator. Resolves the actor + targets from PostgreSQL and
  delegates the decision to the pure policy. Registered/exported from
  `AuthorizationModule` (no controller, no route).

## Grant-ceiling decision model

A grant is allowed only when ALL hold (deny-by-default — any unmet condition or
unresolved row denies):

1. **Tenant** — actor, target user and target role share one company.
2. **Base capability** — actor holds `user:assign-role` (user↔role ops) or
   `role:manage` (role↔permission ops).
3. **Protected grant** — touching a protected role or protected permission also
   requires `role:manage:protected`.
4. **Privilege ceiling** — `actor.maxPrivilegeLevel ≥ targetRole.privilegeLevel`.
5. **Cannot-grant-above-self** — every permission granted (or conferred by an
   assigned role) must be in the actor's own effective permission set.
6. **Removal symmetry** — removals are gated identically to additions.

## Protected-grant behaviour

The existing catalog permission `role:manage:protected` is reused as the
"protected-grant" right (no new permission introduced; `PROTECTED_GRANT_PERMISSION`
is an alias). It is **necessary but not sufficient**: a protected role/permission
also has to pass the tenant, privilege and ceiling checks. So an actor with
`role:manage:protected` but missing one permission the protected target confers is
still denied (`CEILING_EXCEEDED`). The protected gate keys on `roles.is_protected`
(not `is_system`), matching SECURITY_MODEL §2a — a non-protected system role such
as ADMIN stays normally manageable.

## How the tenant boundary is preserved

The actor's company, effective permissions and privilege level come ONLY from
PostgreSQL (`PermissionRepository.loadEffectivePermissionCodes` + a fresh user/
role read), never a JWT claim. Targets are compared against the actor's real
company, so a SYSTEM_ADMIN in company A is denied (`CROSS_TENANT`) when the target
user or role belongs to company B — protected/system status never crosses tenants.

## How self-escalation is blocked

The cannot-grant-above-self rule is sufficient: assigning a role to oneself, or
adding a permission to a role one belongs to, can never introduce a permission the
actor did not already hold (`CEILING_EXCEEDED`), and a higher-ranked/protected role
is stopped by the privilege and protected gates. Removal is gated like addition so
it is not an escalation side-channel.

## Cache-freshness (rule 11)

Grant decisions read effective permissions through the uncached, tenant-scoped
repository query, so a decision can never ride on a stale authorization-cache
entry. The existing version-anchored cache (PG-004) is untouched.

## Tests run (real PostgreSQL @ 127.0.0.1:55432)

| Command | Result |
| --- | --- |
| Domain unit (`@b2b/domain`) incl. 16 grant-ceiling cases | PASS, 38/38 |
| New grant-ceiling integration suite | PASS, 16/16 |
| Existing authz integration (tenant/cache/guard/global/merged) | PASS, 46/46 |
| Full API integration gate | PASS, 146/146, 0 skipped |
| API unit | PASS, 74/74 |
| Full DB gate | PASS, 113/113, 0 skipped |
| Clean DB `migrate deploy` ×2 | PASS, 11 migrations; 2nd no-op |
| `db:seed` ×2 | PASS, idempotent |
| `db:drift` / `db:verify-catalog` | PASS |
| `db:validate` / `db:generate` | PASS |
| `typecheck` | PASS, 18/18 |
| `lint` / `format:check` | PASS |
| `build` | PASS, 10/10 |
| `check:no-skip` / `check:boundaries` | PASS |

## Files changed

- `packages/domain/src/authz/grant-ceiling.ts` (new)
- `packages/domain/src/authz/index.ts` (new)
- `packages/domain/src/index.ts` (export authz)
- `packages/domain/src/rbac.ts` (grant-management permission constants)
- `packages/domain/test/grant-ceiling.test.ts` (new)
- `apps/api/src/modules/authorization/authorization-grant.service.ts` (new)
- `apps/api/src/modules/authorization/authorization.module.ts` (register/export service)
- `apps/api/test/integration/authz-grant-ceiling.test.ts` (new)
