# Permission Guard Global Binding Review

Date: 2026-06-15

Reviewed commit: `6f6ef14 fix(authz): bind PermissionGuard into the production request chain`

Production code changed by this review: no.

Result: **FIX_APPROVED_WITH_NON_BLOCKING_NOTES**

## Scope

Reviewed:

- `apps/api/src/app.module.ts`
- `apps/api/src/modules/auth/guards/jwt-auth.guard.ts`
- `apps/api/src/modules/authorization/guards/permission.guard.ts`
- `apps/api/src/common/auth/public.decorator.ts`
- `apps/api/src/modules/auth/auth.controller.ts`
- `apps/api/src/modules/health/health.controller.ts`
- `apps/api/test/integration/authz-global-guard.test.ts`
- `apps/api/test/support/global-authz-probe.controller.ts`
- `apps/api/test/unit/permission-guard.test.ts`
- `apps/api/test/integration/authz-permission-guard.test.ts`
- related auth integration/regression tests

## Verification

PostgreSQL test database:

`DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_auth_test?schema=public`

`Test-NetConnection 127.0.0.1:55432` returned `TcpTestSucceeded=True`. `docker` CLI was not available, but the database port was reachable.

Commands run:

| Check | Result |
| --- | --- |
| temporary PG-001 attack/mutation probes | PASS, 4/4 tests |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/permission-guard.test.ts` | PASS, 14/14 tests |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/authz-global-guard.test.ts` | PASS, 6/6 tests |
| `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/authz-permission-guard.test.ts` | PASS, 15/15 tests |
| `pnpm.cmd --filter @b2b/api test:integration` | PASS, 105/105 real PostgreSQL tests, 0 skipped |
| `pnpm.cmd typecheck` | PASS, 18/18 turbo tasks |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd build` | PASS, 10/10 turbo tasks |

The temporary attack test was removed after execution and is not part of the final workspace changes.

## Review Findings

### PG-001-LOW-001

Severity: LOW

Issue: Global guard order is order-sensitive and relies on `APP_GUARD` provider declaration order.

Evidence: `JwtAuthGuard` is registered before `PermissionGuard` in `apps/api/src/app.module.ts:42` and `apps/api/src/app.module.ts:43`. The code explicitly documents order at `apps/api/src/app.module.ts:37`. The unit test locks this order at `apps/api/test/unit/permission-guard.test.ts:214`.

Impact: A future provider-order refactor could make permission evaluation run before principal creation. That would be a denial/regression risk, not an observed authorization bypass in this commit.

Recommendation: Keep the order assertion in CI. If more global guards are added, add a chain-level integration test that proves principal creation happens before permission evaluation.

PG-001 impact: Non-blocking. The current order is correct and tested.

### PG-001-LOW-002

Severity: LOW

Issue: Some authenticated auth controller handlers still apply local `@UseGuards(JwtAuthGuard)` even though `JwtAuthGuard` is now global.

Evidence: `logout-all`, `sessions`, session revoke, `me`, and `change-password` use local `JwtAuthGuard` at `apps/api/src/modules/auth/auth.controller.ts:88`, `apps/api/src/modules/auth/auth.controller.ts:102`, `apps/api/src/modules/auth/auth.controller.ts:111`, `apps/api/src/modules/auth/auth.controller.ts:123`, and `apps/api/src/modules/auth/auth.controller.ts:132`.

Impact: No privilege escalation was found. The risk is double authentication work and future confusion about whether protection is local or global.

Recommendation: In a cleanup commit, remove redundant local auth guards or document that the duplication is intentional.

PG-001 impact: Non-blocking. These routes are not public.

### PG-001-LOW-003

Severity: LOW

Issue: Class-level `@Public()` is inherited by every unmarked handler in that controller.

Evidence: `JwtAuthGuard` uses `reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, class])` at `apps/api/src/modules/auth/guards/jwt-auth.guard.ts:43`. A temporary attack probe with controller-level `@Public()` confirmed an unmarked handler returns 200 without a token.

Impact: No production protected endpoint is currently affected. Production class-level `@Public()` appears only on `HealthController`, whose handlers are intended to be unauthenticated. If a future protected handler is added to a public controller without explicit protection, it will become public.

Recommendation: Do not mix protected handlers into class-level public controllers. Add a test-only public-controller collision regression if this pattern expands.

PG-001 impact: Non-blocking. No wrong production endpoint was made public.

### PG-001-LOW-004

Severity: LOW

Issue: A handler with `@RequirePermissions(...)` inside a class-level `@Public()` controller fails closed, but is also unusable even with a valid token.

Evidence: `@Public()` skips `JwtAuthGuard` before it attaches `request.principal`; `PermissionGuard` then sees required permission metadata and throws 401 when the principal is absent at `apps/api/src/modules/authorization/guards/permission.guard.ts:48`. The temporary attack probe confirmed 401 without a token and 401 with a valid token that held `product:read`.

Impact: This is not an open-access bypass. The risk is a future misconfiguration that produces an unreachable route.

Recommendation: Avoid combining controller-level `@Public()` with permission-protected handlers. Prefer method-level `@Public()` on the exact public endpoints.

PG-001 impact: Non-blocking.

## Required Checks

1. `JwtAuthGuard` and `PermissionGuard` are bound into the production request chain with `APP_GUARD`.
   Evidence: `apps/api/src/app.module.ts:42` and `apps/api/src/app.module.ts:43`.

2. Execution order is authentication first, permission second.
   Evidence: provider order in `AppModule`; unit assertion at `apps/api/test/unit/permission-guard.test.ts:214`; production integration behavior in `authz-global-guard.test.ts`.

3. Guard order is provider-order based.
   Evidence: `AppModule` comment and `APP_GUARD` order test. This is order-sensitive, but currently tested.

4. `@Public()` is limited to expected production public endpoints.
   Evidence: login, refresh, logout, forgot-password, reset-password, and health only.

5. No accidentally public production endpoint was found.
   Evidence: `logout-all`, `sessions`, session revoke, `me`, and `change-password` do not carry `@Public()`.

6. Endpoint status:
   `login`, `refresh`, `forgot-password`, `reset-password`, and `logout` are public. `logout-all`, `sessions`, `me`, and `change-password` are authenticated. `DELETE /auth/sessions/:sessionId` is also authenticated.

7. Public `logout` does not break session-revoke behavior.
   Evidence: it revokes only the presented refresh token and clears the cookie; `logout-all` remains authenticated. `auth-sessions.test.ts` and the full integration gate passed.

8. Authenticated production routes without permission metadata still require authentication.
   Evidence: global `JwtAuthGuard` rejects missing bearer tokens; `PermissionGuard` no-ops only after auth has passed. `authz-global-guard.test.ts` verifies 401 without token and 200 with token for a no-permission-metadata route.

9. A `@RequirePermissions` route behaves correctly.
   Evidence: production global probe returns 401 with no token, 403 without permission, and 200 with permission.

10. `PermissionGuard` is globally registered once.
    Evidence: one `APP_GUARD` entry in `AppModule`; unit test asserts one. `AuthorizationModule` also provides/exports `PermissionGuard` as an injectable provider, but not as another global guard.

11. The global authz probe controller does not manually apply `PermissionGuard`.
    Evidence: no `@UseGuards` in `apps/api/test/support/global-authz-probe.controller.ts`; integration test asserts handler guard metadata does not contain `PermissionGuard`.

12. The test module does not bypass production `APP_GUARD` registration.
    Evidence: `createTestApp` imports production `AppModule` and registers the probe controller separately. The probe has no local guards.

13. RFC7807 401/403 and `requestId` are preserved.
    Evidence: `authz-global-guard.test.ts` and `authz-permission-guard.test.ts` assert `application/problem+json`, stable codes, and `requestId`.

14. No auth endpoint regression was observed.
    Evidence: API integration gate passed 105/105 tests, including login, refresh, logout, logout-all, sessions, me, change-password, forgot-password, reset-password, audit, and concurrency coverage.

## Attack Checks

- Controller-level `@Public()` with an unmarked handler: the handler is public. This is expected inheritance, but it means protected handlers must not be placed under class-level public controllers. No production protected handler is currently in that shape.
- Public controller with handler-level permission metadata: open access does not win. The route returns 401 because `PermissionGuard` requires a principal and `JwtAuthGuard` skipped principal creation due `@Public()`.
- Forged JWT permission claims: did not grant access. Existing DB-backed authz test returned 403.
- Global `JwtAuthGuard` removal: a temporary metadata mutation made the global probe's authenticated-no-permission route return 200 without a token, so the existing global guard test is sensitive to removal.
- Global `PermissionGuard` removal: a temporary metadata mutation made the global probe's permission-protected route return 200 for an authenticated user without the permission, so the existing global guard test is sensitive to removal.

## Final Decision

FIX_APPROVED_WITH_NON_BLOCKING_NOTES
