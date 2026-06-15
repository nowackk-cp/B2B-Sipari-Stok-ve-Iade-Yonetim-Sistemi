# Authentication Foundation Review

Date: 2026-06-15

Role: Principal Application Security Reviewer / Independent Authentication Gate Reviewer

Scope: TASK-009 Authentication Foundation review only. Production code, migrations, and tests were not modified.

Gate result: **REJECTED_AUTHENTICATION_FOUNDATION**

## Executive Decision

Authentication Foundation is not approved for RBAC Foundation yet.

The implementation passes the majority of authentication controls: Argon2id password hashing, bounded password length, generic login failures, JWT signature/issuer/audience/expiration validation, refresh-token digest storage, atomic refresh rotation, reuse family revocation, HttpOnly refresh cookie transport, strict DTO validation, real PostgreSQL integration gates, and browser E2E checks.

The gate is rejected because password-reset bearer material is persisted in the database as plaintext inside the transactional outbox payload. This is a mandatory reject condition: raw token DB leakage.

## Reviewed Inputs

Read before review:

- `PROJECT_SPEC.md`
- `CLAUDE.md`
- `AGENTS.md`
- `docs/architecture/SECURITY_MODEL.md`
- `docs/API_CONVENTIONS.md`
- `docs/ERROR_HANDLING.md`
- `docs/OBSERVABILITY.md`
- `docs/TEST_STRATEGY.md`
- `docs/reviews/DATABASE_FOUNDATION_REVIEW_FOLLOWUP.md`

Authentication implementation reviewed:

- API auth controller/service/guards/DTOs/cookies/adapters.
- Session service/repository and refresh-token rotation logic.
- Password reset service/repository/outbox adapter.
- Identity user repository/view mapper and account lockout service.
- Auth-related Prisma schema and migrations.
- Auth unit, API integration, DB integration, concurrency, contract, and E2E tests.
- Frontend auth client, login page, protected dashboard, and Playwright auth suite.

## Findings

### AUTH-BLOCK-001

Severity: **BLOCKER**

Problem:

Raw password reset tokens are persisted in PostgreSQL inside `outbox_events.payload.resetToken`.

Evidence:

- `PasswordResetService.requestReset` generates `{ token, digest }`, stores the digest in `password_reset_tokens`, then passes the raw `token` to the email outbox in the same transaction: `apps/api/src/modules/security/password-reset.service.ts:49-65`.
- `OutboxEmailAdapter.enqueuePasswordReset` writes `payload.resetToken: event.resetToken` to `outbox_events`: `apps/api/src/modules/auth/adapters/outbox-email.adapter.ts:19-33`.
- The repository comment explicitly says the plaintext token lives in the outgoing email payload: `apps/api/src/modules/security/password-reset.repository.ts:5-8`.
- Ad-hoc attack test against the real API and PostgreSQL returned:
  - `forgotStatus: 200`
  - `outboxRawResetTokenPresent: true`
  - `outboxRawResetTokenLength: 43`
  - `resetTokenTablePlaintextRows: 0`
  - `resetTokenOutboxSearchRows: 1`

Attack or failure scenario:

Any principal with read access to the application database, database backups, logical replication stream, BI export, outbox worker diagnostics, or support tooling that exposes `outbox_events.payload` can recover a live password reset bearer token and take over the account before the user uses the link. The digest-only protection in `password_reset_tokens` is bypassed because the same token is stored in plaintext elsewhere in the same database.

Recommended fix:

Do not persist plaintext reset bearer tokens in PostgreSQL. If the transactional outbox must carry deliverable secret material, envelope-encrypt that field with a key not stored in the database, restrict decryption to the mail dispatcher, redact it from all logs, and erase/overwrite it after successful delivery. Prefer a design where database rows contain only digest/selector/template metadata and no recoverable bearer secret.

Required test:

Add a real PostgreSQL integration test that requests a reset, captures the delivered token through the approved delivery boundary, then searches all persisted tables likely to contain payloads (`password_reset_tokens`, `outbox_events`, email/message tables, audit rows) and asserts the raw reset token is absent. Keep the existing single-use, expiration, reset-race, audit, revoke, and rollback tests.

RBAC milestone impact:

RBAC Foundation must not start on top of this gate. A database/outbox reader could reset a privileged user's password and then exercise whatever RBAC permissions that user has, making RBAC enforcement irrelevant for that compromise path.

### AUTH-MED-002

Severity: **MEDIUM**

Problem:

The access-token signer uses HS256 while the architecture security model specifies asymmetric RS256 signing.

Evidence:

- Security model requires asymmetric signing: `docs/architecture/SECURITY_MODEL.md:8-10`.
- Implementation header is `HS256`: `apps/api/src/modules/auth/adapters/hmac-access-token.signer.ts:13`.
- Config comments also document HS256 for this milestone: `packages/config/src/env.ts:95-102`.
- The same signer does correctly verify signature before claims and checks issuer, audience, expiration, and minimal session/user claims: `apps/api/src/modules/auth/adapters/hmac-access-token.signer.ts:52-76`.
- Ad-hoc JWT tests confirmed tampered signature, wrong issuer, wrong audience, expired token, and algorithm mismatch all returned `401`.

Attack or failure scenario:

With HS256, every service that verifies tokens must hold signing authority. If the HMAC secret leaks from any verifier, the attacker can mint tokens. With RS256/EdDSA, API and workers can verify with public keys while only the auth issuer holds the private key.

Recommended fix:

Move the signer adapter to RS256 or EdDSA with private-key-only signing, public-key verification, `kid`-based key rotation, and strict algorithm allowlisting.

Required test:

Add tests for wrong algorithm, public-key-as-HMAC confusion, invalid `kid`, rotated keys, wrong issuer/audience/expiration, and tampered payload/signature.

RBAC milestone impact:

Before RBAC permissions are put in or near tokens, the signing boundary should match the architecture model so verifiers do not become token issuers.

### AUTH-MED-003

Severity: **MEDIUM**

Problem:

Forgot-password responses are generic, but active-account and unknown/inactive-account code paths do materially different work. There is no explicit timing equalization for forgot-password.

Evidence:

- Unknown/inactive accounts log and return without token generation, transaction, reset-token insert, or outbox insert: `apps/api/src/modules/security/password-reset.service.ts:38-47`.
- Active accounts generate a token and write reset/outbox rows in a transaction: `apps/api/src/modules/security/password-reset.service.ts:49-66`.
- Coarse API timing sample after warmup:
  - Known user: `13.7ms`, `9.7ms`, `9.5ms`, `8.3ms`
  - Unknown user: `4.7ms`, `3.9ms`, `4.7ms`, `5.2ms`, `4.4ms`
- Body/status were generic and identical: `200` with `If an account exists for that email, a password reset link has been sent.`

Attack or failure scenario:

An attacker can repeatedly call forgot-password for a candidate email list and use response-time distributions to infer which accounts exist, especially from a low-latency network or internal vantage point.

Recommended fix:

Add explicit timing equalization or a comparable dummy path for unknown/inactive accounts. Avoid sending mail for unknown users, but make the observable request budget much closer by using bounded padding, a fake digest generation path, and/or a controlled dummy transaction. Apply per-identifier and per-IP throttling to forgot-password as well.

Required test:

Add an integration test that compares known, unknown, suspended, and soft-deleted forgot-password calls under a controlled clock or calibrated timing harness and enforces a documented maximum timing delta. Also assert generic status/body remain identical.

RBAC milestone impact:

No direct RBAC grant-ceiling impact, but account discovery against future privileged users increases targeted password-reset and credential-stuffing risk.

## Control Review

### Password

Status: **PASS**

- Argon2id is used via `hash-wasm`: `apps/api/src/modules/auth/adapters/argon2-password-hasher.ts:26-36`.
- Parameters are config-based and validated: `packages/config/src/env.ts:110-113`.
- Rehash policy exists: `apps/api/src/modules/auth/adapters/argon2-password-hasher.ts:48-49`; login rehashes when needed: `apps/api/src/modules/auth/auth.service.ts:94-97`.
- Password policy bounds hashing DoS with a 128 code-point max and normalizes NFKC without trimming whitespace: `packages/domain/src/auth/password-policy.ts:19-23`, `packages/domain/src/auth/password-policy.ts:63-68`.
- Passwords were not found in response DTOs or logs. Failed login logging includes identifier/reason but not password: `apps/api/src/modules/auth/auth.service.ts:378-395`.

### Login Enumeration

Status: **PASS with timing caveat monitored**

- Login returns the same external RFC7807 status/body for unknown user, wrong password, suspended user, locked user, and soft-deleted user: all `401`, `Unauthorized`, `Invalid email or password`.
- Code burns one hash verification for unknown/inactive/locked paths: `apps/api/src/modules/auth/auth.service.ts:67-83`, `apps/api/src/modules/auth/auth.service.ts:368-376`.
- Measured timings after warmup were in the same rough band: unknown `26-31ms`, wrong password `28-38ms`, disabled `25-34ms`, locked `25-27ms`, soft-deleted `24-28ms`.

### Access Token

Status: **PASS with architecture deviation**

- Signature is verified before claims are trusted: `apps/api/src/modules/auth/adapters/hmac-access-token.signer.ts:52-60`.
- Issuer, audience, expiration, subject, and session id are validated: `apps/api/src/modules/auth/adapters/hmac-access-token.signer.ts:67-76`.
- Algorithm mismatch was rejected in live testing (`401`).
- Claims are minimal: ad-hoc token contained only `aud`, `exp`, `iat`, `iss`, `jti`, `sid`, `sub`.
- Role/permission/scope catalogs are not embedded in the token.
- Inactive/deleted users and revoked sessions are checked from the database by the guard, not trusted from token claims alone: `apps/api/src/modules/auth/guards/jwt-auth.guard.ts:49-56`.
- Deviation: HS256 is implemented while the security model says RS256. See AUTH-MED-002.

### Refresh Token

Status: **PASS**

- Refresh token generation returns raw token once and stores only digest: `apps/api/src/modules/sessions/session.service.ts:55-75`.
- Live raw-token DB search found `refreshPlaintextRows: 0` and `refreshDigestRows: 1`.
- Rotation uses `SELECT ... FOR UPDATE` and marks the old token revoked with a replacement chain: `apps/api/src/modules/sessions/session.repository.ts:76-93`, `apps/api/src/modules/sessions/session.repository.ts:113-123`.
- Reuse detection revokes the whole family and writes audit: `apps/api/src/modules/sessions/session.service.ts:98-101`, `apps/api/src/modules/sessions/session.service.ts:134-162`.
- Targeted concurrency test passed: only one concurrent refresh succeeded; the others returned `401`.
- Logout/session revoke scopes by user id: `apps/api/src/modules/sessions/session.repository.ts:140-152`.
- Logout followed by access-token use and refresh returned `401` in live testing.

### Cookie and CSRF

Status: **PASS for current same-site design**

- Refresh cookie is HttpOnly, production-secure by config, SameSite Strict, path-scoped, and cleared with matching options: `apps/api/src/modules/auth/cookies/refresh-cookie.ts:18-44`.
- Browser E2E verified refresh token is absent from `localStorage` and `sessionStorage`.
- CSRF protection relies on `SameSite=Strict`. That is valid for the current same-site browser flow. If cross-site credentialed refresh is introduced later, add explicit CSRF token/origin enforcement before changing SameSite.

### Account Lockout and Rate Limiting

Status: **PASS**

- Durable account lockout is in PostgreSQL, not Redis: `packages/database/prisma/schema.prisma:226-231`.
- Failed-attempt updates are database mutations and concurrency tests passed for lockout counters.
- Per-identifier and per-IP Redis-backed throttling exists: `apps/api/src/modules/auth/auth.service.ts:344-360`.
- Redis outage is fail-open by design while PostgreSQL lockout remains authoritative: `apps/api/src/modules/auth/adapters/redis-rate-limiter.ts:13-19`, `apps/api/src/modules/auth/adapters/redis-rate-limiter.ts:51-57`.
- Successful login resets counters and rate-limit keys: `apps/api/src/modules/auth/auth.service.ts:94`, `apps/api/src/modules/auth/auth.service.ts:363-366`.
- Attackers can temporarily lock a known account for the configured window, but not permanently.

### Password Reset

Status: **FAIL**

- Reset-token table stores digest and consume is single-use under race: `apps/api/src/modules/security/password-reset.repository.ts:25-56`.
- Reset password updates password, revokes all sessions, and audits in one transaction: `apps/api/src/modules/auth/auth.service.ts:258-287`.
- Reset-race integration test passed: one success, remaining concurrent submissions rejected.
- Expiration is enforced in conditional consume: `apps/api/src/modules/security/password-reset.repository.ts:51-53`.
- Failure: raw reset token is stored in `outbox_events.payload.resetToken`. See AUTH-BLOCK-001.
- Forgot-password response status/body are generic, but timing equalization is incomplete. See AUTH-MED-003.

### Audit and Transaction

Status: **PASS**

- Audit writer accepts the caller's transaction handle and writes in the same transaction: `apps/api/src/common/audit/audit-writer.service.ts:19-39`.
- Password change, password reset, token reuse, session revoke, and rollback/orphan tests passed on real PostgreSQL.
- Audit redaction is defensive; no raw passwords or refresh tokens were observed in audit assertions.

### Authorization Boundary

Status: **PASS**

- No role-assignment endpoint was added.
- No permission-mutation endpoint was added.
- No warehouse-scope endpoint was added.
- API controller scan found only auth and health controllers for this milestone.
- `JwtAuthGuard` explicitly performs authentication only and no role/permission/scope decisions: `apps/api/src/modules/auth/guards/jwt-auth.guard.ts:16-25`.
- No role-name authorization branches or ADMIN/SYSTEM_ADMIN bypasses were found in API code.
- This auth milestone does not implement or claim grant-ceiling enforcement.

### DTO and Response

Status: **PASS**

- Global `ValidationPipe` has `whitelist: true` and `forbidNonWhitelisted: true`: `apps/api/src/bootstrap.ts:23-30`.
- Live DTO attack with extra `role: "ADMIN"` field on login returned `400`.
- Auth responses use public contracts, not Prisma models: `packages/contracts/src/auth.ts:1-40`.
- User mapper explicitly selects safe fields and does not spread internal records: `apps/api/src/modules/identity/user-view.ts:4-18`.
- RFC7807 filter returns `application/problem+json` and does not return stack traces: `apps/api/src/common/filters/all-exceptions.filter.ts:17-49`.

### Frontend

Status: **PASS**

- Refresh token is transported by HttpOnly cookie and is not read by JavaScript.
- Access token is stored only in module memory, not local/session storage: `apps/web/src/lib/auth-client.ts:6-12`.
- Login, refresh-after-reload, logout, protected-route redirect, and no-browser-storage tests passed in Chromium.
- Frontend state is not the source of truth; `/auth/me` requires Bearer access token and the API guard validates user/session state server-side.

## Test Evidence

Environment:

- Real PostgreSQL: `127.0.0.1:55432`, PostgreSQL 16.9.
- Isolated DB: `b2b_auth_gate_test_20260615_1535`.
- Shadow DB: `b2b_auth_gate_shadow_test_20260615_1535`.

Commands actually run:

| Check | Result |
| --- | --- |
| `pnpm.cmd install --frozen-lockfile` | PASS |
| `pnpm.cmd format:check` | PASS |
| `pnpm.cmd lint` | PASS |
| `pnpm.cmd typecheck` | PASS |
| `pnpm.cmd test:unit` | PASS |
| `pnpm.cmd test:integration:api` without `DATABASE_URL` | FAIL CLOSED: tests not executed because DB was unset |
| `db:migrate:deploy` | PASS |
| second `db:migrate:deploy` | PASS: no pending migrations |
| `db:validate` | PASS |
| `db:seed` | PASS |
| `db:drift` with shadow DB | PASS |
| `db:verify-catalog` | PASS |
| `DATABASE_URL=... pnpm.cmd test:integration:api` | PASS: 61/61 real PostgreSQL tests, 0 skipped |
| targeted `auth-concurrency.test.ts` | PASS: 4/4 |
| `DATABASE_URL=... pnpm.cmd test:integration:db` | PASS: 72/72 real PostgreSQL tests, 0 skipped |
| `DATABASE_URL=... pnpm.cmd test:database-gate` | PASS: 72/72 real PostgreSQL tests, 0 skipped |
| `NEXT_PUBLIC_API_BASE_URL=... pnpm.cmd --filter @b2b/web build` | PASS |
| `DATABASE_URL=... NEXT_PUBLIC_API_BASE_URL=... pnpm.cmd --filter @b2b/web test:e2e` | PASS: 6/6 Chromium tests |
| `pnpm.cmd build` | PASS |
| `pnpm.cmd check:boundaries` | PASS |
| `pnpm.cmd check:no-skip` | PASS |
| `pnpm.cmd check:secrets` | PASS |

Note: I intentionally ran `format:check` instead of write-mode `pnpm format` because the review scope forbids modifying production code, migrations, or tests.

Additional attack checks:

- Refresh replay/race: passed through targeted concurrency integration tests.
- Reset race: passed through targeted concurrency integration tests.
- Expired JWT: live API returned `401`.
- Wrong issuer: live API returned `401`.
- Wrong audience: live API returned `401`.
- Tampered JWT: live API returned `401`.
- Algorithm mismatch: live API returned `401`.
- Session revoke after logout: access and refresh both returned `401`.
- Different user's session id delete: covered by user-scoped session revoke repository and integration tests.
- Cookie without refresh: live API returned `401`.
- Extra DTO field: live login returned `400`.
- Raw refresh token search: `0` plaintext rows, digest row present.
- Raw reset token search: plaintext present in outbox payload. This is AUTH-BLOCK-001.
- Account enumeration login: status/body matched for unknown, wrong password, suspended, locked, and soft-deleted users.
- Forgot-password enumeration: status/body matched, timing side-channel remains. This is AUTH-MED-003.

## Gate Requirements Mapping

Mandatory reject checks:

- Raw password or token log/DB leakage: **FAIL** for raw password-reset token in outbox DB payload.
- Refresh token plaintext DB: PASS.
- Refresh rotation race allows same token twice: PASS, race test rejects duplicates.
- Reuse detection missing/broken: PASS, reuse revokes family.
- JWT signature/issuer/audience missing: PASS.
- Password hashing insecure: PASS.
- Forgot-password enumeration: PASS for status/body, MEDIUM timing issue.
- Reset token reusable: PASS, single-use race test passed.
- Authentication bypass: PASS.
- Prisma internal response leak: PASS.
- Refresh token browser storage: PASS.
- Real PostgreSQL auth tests not run: PASS, real DB tests ran and were not skipped.
- Tests skipped/fake: PASS, no-skip and integration gates passed.
- Early role/permission mutation endpoint: PASS.

Final gate: **REJECTED_AUTHENTICATION_FOUNDATION** because AUTH-BLOCK-001 is a mandatory reject.
