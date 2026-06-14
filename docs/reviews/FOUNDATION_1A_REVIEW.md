# Foundation Milestone 1A Review

**Date:** 2026-06-14  
**Reviewer role:** Principal Code Reviewer / QA Architect / Foundation Gate Reviewer  
**Scope:** TASK-001, TASK-002, TASK-003, TASK-005, TASK-006, TASK-007 plus implemented web/worker foundation surfaces  
**Production code changes:** None

## Gate Summary

`APPROVED_WITH_NON_BLOCKING_NOTES`

No mandatory rejection condition was observed:

- `pnpm install --frozen-lockfile` passed with `pnpm.cmd`.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed.
- API booted from `apps/api/dist/main.js`; `/api/v1/health` and `/api/docs` returned 200.
- Unknown endpoint returned RFC 7807 `application/problem+json` with `requestId`.
- TypeScript strict and `noUncheckedIndexedAccess` are enabled in the base config and not locally disabled.
- Frontend has no DB/Prisma imports.
- No real production secret or private key was found in tracked files.
- Docker Compose could not be executed locally because Docker CLI is unavailable; static compose inspection found the required service markers.

The gate is not `APPROVED_FOR_DATABASE_FOUNDATION` because several foundation quality gaps should be fixed before or during TASK-004, especially logger token redaction, CI executable-checklist coverage, and package path drift.

## Task Mapping

| Expected task | Implemented equivalent | Status |
|---|---|---|
| TASK-001 Monorepo | `77996b2 chore: initialize monorepo foundation` | Implemented, with package naming drift noted below. |
| TASK-002 Config | `packages/config` env schemas and tests | Implemented. Startup-process fail-fast test gap remains. |
| TASK-003 Logger | `packages/logger` Pino wrapper, ALS context, tests | Implemented with a token redaction gap. |
| TASK-005 Docker Compose | `docker-compose.yml`, `.env.example`, infra smoke script | Implemented; local live validation blocked by missing Docker CLI. |
| TASK-006 CI | `.github/workflows/ci.yml`, `docker-validation.yml`, docs checker | Partially implemented; several checklist gates are hooks only. |
| TASK-007 API foundation | `apps/api` NestJS prefix, health, Swagger, RFC 7807, request ID | Implemented; DTO whitelist is configured but not executable-tested. |
| Extra: web shell | `7fbe1fe feat: add web foundation shell` | Equivalent to a partial future web shell; no DB coupling found. |
| Extra: worker foundation | `a3293d7 feat: add api and worker foundations` | Equivalent to partial TASK-026 bootstrap; no business processor found. |

## Verification Performed

Repository and git:

- Branch: `ai/claude-foundation-1a`.
- Baseline branches present: `master`, `origin/master`; no `main` branch.
- `git status --short --branch`: clean.
- Standard git commands initially failed with Git dubious ownership; review used `git -c safe.directory=C:/Users/Administrator/Desktop/depo ...`.
- Range `master..HEAD`: 5 commits, 129 changed files, 4091 insertions.

Commands:

| Command | Result | Notes |
|---|---:|---|
| `pnpm install --frozen-lockfile` | PASS | `pnpm.ps1` blocked by PowerShell policy; `pnpm.cmd` passed. |
| `pnpm format:check` | PASS | Prettier clean. |
| `pnpm lint` | PASS | Includes web DB/Prisma import restriction. |
| `pnpm typecheck` | PASS | Normal sandbox hit Turbo spawn `EPERM`; elevated run passed. |
| `pnpm test` | PASS | Normal sandbox hit Turbo spawn `EPERM`; elevated run passed. |
| `pnpm test:unit` | PASS | Elevated run passed. |
| `pnpm test:integration` | PASS | Elevated run passed; API integration tests ran. |
| `pnpm test:e2e` | PASS | Elevated run passed; current smoke is contract-level, no browser/server. |
| `pnpm build` | PASS | Elevated run passed; Next build succeeded. |
| `node scripts/check-docs-links.mjs` | PASS | All relative markdown links resolve. |
| `pnpm --filter @b2b/api openapi:json` | PASS | Normal sandbox `EPERM` writing ignored artifact; elevated run passed. |
| `pnpm --filter @b2b/api-client generate` | PASS | Normal sandbox `EPERM` writing ignored artifact; elevated run passed. |
| `docker compose config` | NOT RUN | `docker` command not found. |
| `docker-compose config` | NOT RUN | `docker-compose` command not found. |

Runtime API probe:

- `GET /api/v1/health`: 200, `status=ok`, `service=api`.
- `GET /api/docs`: 200.
- `GET /api/v1/review-missing` with `x-request-id=review-missing-1`: 404, `application/problem+json`, `type=https://errors.b2bops.local/not-found`, `code=NOT_FOUND`, `requestId=review-missing-1`, `instance=/api/v1/review-missing`.

## Findings

### F-001

**Severity:** HIGH  
**Problem:** Logger does not redact a generic `token` field, although TASK-003 and observability docs require token redaction.

**Evidence:**

- `docs/tasks/IMPLEMENTATION_PLAN.md:43` requires `authorization/password/token` redaction.
- `docs/OBSERVABILITY.md:7` requires `authorization`, `password`, `token`, `refreshToken`, `cookie` masking.
- `packages/logger/src/logger.ts:10-17` redacts `authorization`, `cookie`, `password`, `accessToken`, `refreshToken`, `apiKey`, `secret`, but not `token`.
- Runtime capture showed `"token":"raw-token"` remained plaintext while the listed fields were `[REDACTED]`.
- `packages/logger/test/logger.test.ts:37-57` validates several sensitive fields but does not include `token`.

**Impact:** Any log payload using a common `token` key will leak the token in plaintext. This is a TASK-003 acceptance gap and will matter before auth/refresh token work lands.

**Recommended fix:** Add `token` to `REDACTED_FIELDS`; consider common variants such as `idToken`, `csrfToken`, `xApiKey`, and nested paths used by request serializers.

**Required test:** Extend logger capture tests to assert top-level and nested `token` are censored in actual JSON output.

**Effect on TASK-004:** Not a direct DB schema blocker, but should be fixed before auth/RBAC seeds or migrations introduce secret-bearing logs.

### F-002

**Severity:** MEDIUM  
**Problem:** Validation whitelist behavior is configured but cannot be runtime-tested because there is no body DTO endpoint.

**Evidence:**

- `apps/api/src/bootstrap.ts:19-23` configures `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, and `transform`.
- API route scan found only health GET routes: `apps/api/src/modules/health/health.controller.ts:9,14,21,28`.
- `apps/api/src/modules/health/health.dto.ts:5` is a Swagger response DTO, not a request body DTO.
- No `@Body`, `@Post`, `@Put`, or `@Patch` route exists under `apps/api/src`.

**Impact:** The mass-assignment defense is present in configuration, but a regression in DTO validation cannot be caught by current tests. The requested "invalid DTO extra field" probe is not possible against this API surface.

**Recommended fix:** Add a test-only controller in the API integration test module, or add the first real command DTO with a negative test as soon as a mutating endpoint lands.

**Required test:** Send a body with an unknown field and assert 400 RFC 7807 `VALIDATION_ERROR`, with stable `type`, `title`, `status`, `detail`, `requestId`, and field error details.

**Effect on TASK-004:** No direct database-schema impact, but DB-backed mutation endpoints must not ship without this test.

### F-003

**Severity:** HIGH  
**Problem:** TASK-006 CI executable checklist is only partially enforced.

**Evidence:**

- TASK-006 requires service containers/env/health wait, `prisma migrate deploy`, Redis/MinIO smoke, worker smoke, Playwright browser install/smoke, OpenAPI drift = 0, docs link check, coverage gate (`docs/tasks/IMPLEMENTATION_PLAN.md:64-67`).
- `.github/workflows/ci.yml:45` runs `pnpm test:unit`; API tests are not run in that job because `@b2b/api` has no `test:unit` script.
- `.github/workflows/ci.yml:56-58` generates OpenAPI and api-client, but does not run `git diff --exit-code`.
- `.github/workflows/ci.yml` has no `prisma migrate deploy`, no migration drift check, no coverage gate, no worker process smoke, and no `playwright install --with-deps`.
- Docker Compose validation exists in `.github/workflows/docker-validation.yml:24`, but it is separate from the main CI path.

**Impact:** Future API/client or DB migration drift can pass CI. TASK-004 migrations would not be protected by the migration deploy/drift gates described in the plan.

**Recommended fix:** Add explicit CI steps for `prisma migrate deploy`, migration drift check, OpenAPI regenerate + `git diff --exit-code`, worker boot smoke, coverage reporting/gate, and a real Playwright browser smoke when the web route is ready.

**Required test:** CI should fail on an intentionally stale generated client, broken migration drift, or missing worker boot readiness.

**Effect on TASK-004:** Significant. TASK-004 should not merge DB migrations without CI applying them against real Postgres and checking drift.

### F-004

**Severity:** HIGH  
**Problem:** Package structure drifts from the architecture and implementation plan.

**Evidence:**

- Architecture expects `packages/domain`, `packages/db`, and `packages/contracts` (`docs/architecture/ARCHITECTURE.md:51-54`) and dependency flow `api -> domain -> db` / `web -> api-client -> contracts` (`docs/architecture/ARCHITECTURE.md:67-70`).
- Implementation plan references `packages/db` for TASK-004 and later tasks (`docs/tasks/IMPLEMENTATION_PLAN.md:49-50`, `96`, `104`, `182`).
- Repository currently has `packages/database/package.json:2` named `@b2b/database` and `packages/shared/package.json:2` named `@b2b/shared`; no `packages/db`, `packages/domain`, or `packages/contracts` directory exists.

**Impact:** TASK-004 can easily create a second database package or implement migrations in a path that conflicts with the current skeleton. Future domain/contracts work also lacks the expected package boundary.

**Recommended fix:** Choose one canonical structure before TASK-004: either rename `packages/database` to `packages/db` and create `domain`/`contracts` skeletons, or update architecture and implementation plan consistently to `database`/`shared`.

**Required test:** Workspace filters used by the plan should resolve, e.g. `pnpm --filter @b2b/db ...` or the plan should be updated to the actual package names and verified in CI.

**Effect on TASK-004:** Direct. This should be resolved before database migrations begin.

### F-005

**Severity:** MEDIUM  
**Problem:** Config fail-fast tests validate parser functions, not actual process startup failure.

**Evidence:**

- TASK-002 requires missing/invalid env to fail fast at boot (`docs/tasks/IMPLEMENTATION_PLAN.md:35`).
- `packages/config/test/env.test.ts` calls `loadApiConfig`, `loadWorkerConfig`, and `loadWebConfig` directly.
- API/worker modules wire the config factories at boot, but no subprocess/startup test asserts non-zero process exit on missing env.

**Impact:** Parser behavior is covered, but boot wiring could regress while parser unit tests still pass.

**Recommended fix:** Add a small process-level smoke for API and worker startup with a missing required env variable and assert non-zero exit plus sanitized error output.

**Required test:** Spawn `node apps/api/dist/main.js` and worker main with `DATABASE_URL` or `REDIS_URL` missing; assert fail-fast exit and no secret leakage.

**Effect on TASK-004:** Low direct effect, but useful before DB migrations require reliable `DATABASE_URL` behavior.

### F-006

**Severity:** LOW  
**Problem:** RFC 7807 tests do not assert the full documented shape.

**Evidence:**

- Runtime unknown-route probe returned problem+json with status/type/title/code/requestId/instance.
- `apps/api/test/health.test.ts:52-60` asserts content type, status, code, instance, type, title, requestId, and absence of stack, but does not assert `detail`.
- There is no test for generic 500 mapping to ensure production stack/internal messages are hidden.

**Impact:** A regression could drop `detail` or leak unexpected 500 detail without current tests catching it.

**Recommended fix:** Extend API integration or unit tests for `mapExceptionToProblem`.

**Required test:** Assert `status`, `type`, `title`, `detail`, `requestId`, and no stack for 404 and generic 500.

**Effect on TASK-004:** No direct DB impact; relevant before DB-backed error paths are exposed.

### F-007

**Severity:** LOW  
**Problem:** Local Docker Compose validation and service health checks could not be executed in this review environment.

**Evidence:**

- `docker compose config` failed because `docker` was not recognized.
- `docker-compose config` also failed because `docker-compose` was not recognized.
- Static inspection found PostgreSQL, Redis, MinIO, MinIO bucket init, Mailpit, healthcheck, restart policy, volumes, and `depends_on.condition: service_healthy` markers in `docker-compose.yml`.
- `.github/workflows/docker-validation.yml:24` runs `docker compose config` in CI.

**Impact:** I cannot certify live Docker service health from this machine. This is an environment limitation, not an observed compose syntax failure.

**Recommended fix:** Run the Docker validation workflow or run locally on a machine with Docker Desktop/Engine available.

**Required test:** `docker compose config`, `docker compose up -d`, `docker compose ps`, and service health/port smoke.

**Effect on TASK-004:** Medium operational relevance: TASK-004 migrations need a verified local/CI Postgres path.

## Positive Checks

- **Repository:** Feature branch exists and working tree is clean. Generated/build outputs are ignored and not tracked.
- **pnpm/Turbo:** Workspace includes `apps/*`, `packages/*`, and `tests/*`; lockfile is present and frozen install passed.
- **TypeScript:** `strict: true` and `noUncheckedIndexedAccess: true` are enabled in `tsconfig.base.json:15-16`; no package disables them.
- **Boundary:** ESLint forbids web imports of `@b2b/database`, `@prisma/client`, `@prisma/*`, and `prisma` (`eslint.config.mjs:44-57`); repo scan found no web DB/Prisma usage.
- **Frontend:** App Router files exist (`layout`, `error`, `loading`, `not-found`); API base URL is centralized in `apps/web/src/lib/api.ts`.
- **API:** `/api/v1` global prefix, `/api/v1/health`, Swagger `/api/docs`, global validation pipe, CORS, request ID middleware, structured logging, RFC 7807 filter, and shutdown hooks are present.
- **Worker:** Redis/BullMQ infrastructure exists with lazy Redis connection, explicit startup connect/ping, connection error logging, worker identity, readiness log, and graceful shutdown. No business processor was found.
- **Secrets:** Targeted scans found no private keys or obvious real provider tokens. `.env.example` and compose use clearly labeled development defaults.
- **Architecture drift:** `ARCHITECTURE.md` section 6 is now aligned with ADR-008: effect receipts use `PLANNED/IN_PROGRESS/SUCCEEDED/FAILED/UNKNOWN`, receipt presence alone is not success, and outbox is processed only after `SUCCEEDED`.
- **Business scope:** No catalog/order/invoice/stock business modules were implemented early. Redis is not used as source-of-truth. Full Prisma domain schema was not implemented early.

## Final Gate Result

`APPROVED_WITH_NON_BLOCKING_NOTES`
