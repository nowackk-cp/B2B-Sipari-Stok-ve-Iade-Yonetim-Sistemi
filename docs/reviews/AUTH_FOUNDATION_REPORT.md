# Authentication Foundation Report (TASK-009)

Date: 2026-06-15
Branch: `ai/claude-auth-foundation` (off the approved database gate `ai/claude-database-gate-fix`)
Scope: **Authentication only** — identity verification. No RBAC / permission / scope
authorization (those are TASK-010 / 010a / 011). No register/signup, no role or
warehouse-scope assignment, no SYSTEM_ADMIN/ADMIN management endpoints.

## 1. Endpoints (all under `/api/v1`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/login` | public | email+password → access token (body) + refresh cookie |
| POST | `/auth/refresh` | refresh cookie/body | rotate refresh, new access token |
| POST | `/auth/logout` | refresh cookie | revoke current session, clear cookie (idempotent) |
| POST | `/auth/logout-all` | bearer | revoke all of the user's sessions |
| GET | `/auth/sessions` | bearer | list active sessions (current flagged) |
| DELETE | `/auth/sessions/:sessionId` | bearer | revoke one own session (404 if not owned) |
| GET | `/auth/me` | bearer | whitelisted profile |
| POST | `/auth/change-password` | bearer | verify current, set new, revoke other sessions |
| POST | `/auth/forgot-password` | public | always-generic; enqueues reset email via outbox |
| POST | `/auth/reset-password` | public | single-use token → set password, revoke all sessions |

Endpoint names match `docs/API_CONVENTIONS.md §12` (`/auth/login|refresh|logout`); the
remaining names follow the canonical kebab-case action convention.

## 2. Module structure (NestJS, `apps/api/src`)

- `modules/identity` — owns `users`; `UserRepository`, `AccountSecurityService` (durable lockout).
- `modules/sessions` — owns `refresh_tokens`; rotation, reuse detection, listing, revocation.
- `modules/security` — owns `password_reset_tokens`; reset request/consume.
- `modules/auth` — `AuthController` + `AuthService` orchestrator; ports + adapters; `JwtAuthGuard`, `CurrentUser`, cookies, DTOs.
- `common/{database,time,audit,http,auth,config}` — Prisma provider, clock, transactional audit writer, request meta, principal.
- Layers separated: controller (thin) → application service → repository → Prisma. No Prisma in controllers; no role-name branching.

## 3. Password hashing

argon2id via **`hash-wasm`** (pure WASM, no native build). Salt = 16 random bytes/
hash (library-side via CSPRNG). Params in central config (`ARGON2_MEMORY_KIB`=19456,
`ARGON2_ITERATIONS`=3, `ARGON2_PARALLELISM`=1; lowered to 8192/2/1 in tests).
Verification is the library's constant-time `argon2Verify`. Transparent rehash on
login when the stored params are weaker than policy. Passwords are NFKC-normalized,
12–128 chars (code points), local denylist, whitespace never trimmed. No password is
ever logged or placed in any audit `before/after`.

## 4. Token approach

- **Access**: short-lived JWT (HS256, 900 s) with minimal claims `sub` (user UUID),
  `sid` (session UUID), `jti`, `iat`, `exp`, `iss`, `aud` — no roles/permissions/scope/PII.
  Hand-rolled with `node:crypto` behind an `AccessTokenSigner` port (RS256 swap is a
  binding change). `JWT_ACCESS_SECRET` ≥ 32 chars, fail-fast at config load. Verify
  always checks signature (constant-time) before trusting claims (no `jwt.decode`).
- **Refresh**: opaque 256-bit base64url; only its SHA-256 digest is stored. Rotation
  mandatory; family/chain via `token_family_id` + `replaced_by_token_id`; metadata
  `expires_at/revoked_at/revoke_reason/last_used_at/created_by_ip/user_agent`.

## 5. Refresh rotation & reuse detection

Each refresh rotates under `SELECT ... FOR UPDATE` on the token row: old revoked,
successor minted in the same family + stable `session_id`. Presenting an already-
revoked token = reuse → the whole family is revoked and `TOKEN_REUSE_DETECTED`
business audit is written **in the same transaction** (so the protective revoke
commits). Concurrent refreshes of one token serialize → exactly one succeeds.

## 6. Lockout & rate limit

- **Durable lockout (authoritative, PostgreSQL):** `users.failed_login_count` (atomic
  increment), `locked_until`. Threshold 5 → lock 15 min; the lock-set is a conditional
  `updateMany` so only one racer locks and writes `ACCOUNT_LOCKED`. Lazy clear after expiry.
- **Rate limit (secondary):** Redis fixed window per IP and per identifier (10 / 300 s).
  Redis is never the source of truth; **on Redis outage it fails open and logs a warning**
  (documented), because the Postgres lockout still caps per-account guessing — failing
  closed would turn a Redis outage into a login outage. In-memory limiter is test/dev only.

## 7. Password reset flow

CSPRNG token, digest-only at rest, single-use (`consumed_at` flipped by a conditional
`updateMany` → concurrency-safe), short-lived (30 min). Requesting invalidates the
user's prior active tokens. The **raw token is written only to the transactional
`outbox_events` payload** (no SMTP this milestone) — never logged or audited.
Completing a reset revokes **all** sessions and writes `PASSWORD_RESET_COMPLETED`.
`forgot-password` always returns the same generic body (enumeration-safe).

## 8. Cookie / CSRF

Refresh cookie: `HttpOnly`, `Secure` (true in production / configurable), `SameSite=Strict`,
narrow `Path=/api/v1/auth`, explicit `Max-Age`; cleared with the same attributes on
logout. The access token is a Bearer value held in browser memory (never localStorage).
**CSRF**: `SameSite=Strict` means the refresh cookie is never sent on cross-site
requests, removing the CSRF surface for the refresh endpoint without a separate token;
the access token is not cookie-borne, so it is not CSRF-exposed. (Decision documented in
`refresh-cookie.ts`.)

## 9. Audit records (business audit, same transaction)

`PASSWORD_CHANGED`, `PASSWORD_RESET_COMPLETED`, `SESSION_REVOKED`,
`ALL_SESSIONS_REVOKED`, `ACCOUNT_LOCKED`, `TOKEN_REUSE_DETECTED` — each with actor
snapshot (email/name/roles), `request_id`, ip/user-agent, written via `AuditWriter`
inside the mutation's transaction (append-only table). Defensive audit redaction masks
any `password/secret/token/hash/digest/cookie/authorization` key. Failed logins,
invalid reset/refresh tokens and rate-limit rejections are operational/security **logs**
(Pino), not business audit.

## 10. Migration

`packages/database/prisma/migrations/20260615000000_auth_foundation` — additive only.
Adds users account-security columns; refresh-token session id (non-unique, family-
shared), family/replacement/metadata + indexes; password-reset `consumed_at`
(renamed from `used_at`) + `requested_by_ip`. Hand-written to avoid disturbing the
Prisma-invisible custom SQL; `db:drift` = 0 unexpected, catalog verification passes,
clean-DB deploy + idempotent re-deploy + seed verified.

## 11. Test counts

- Domain unit (`@b2b/domain`): **22** (password policy, argon2 params + existing RBAC).
- API unit (`@b2b/api`): **26** (hasher, token gen, HS256 signer, cookie, audit redaction, rate limiter).
- API integration (real PostgreSQL): **61** across 9 files (login, refresh+reuse, sessions, password change/reset, audit-in-tx + rollback, contract, concurrency, plus health/validation).
- Web E2E (Playwright/Chromium): **6**.
- Database gate (unchanged, re-run green): **72**.

## 12. Concurrency results

- Two/five concurrent refreshes of one token → exactly **1** succeeds, rest 401. ✓
- Concurrent use of one reset token → exactly **1** succeeds, rest 422. ✓
- Parallel failed logins → no lost increments, account locked, **1** `ACCOUNT_LOCKED` audit. ✓
- logout racing refresh → no 500, ≤ 1 active token. ✓

## 13. Real PostgreSQL result

Real PostgreSQL **16.9** at `127.0.0.1:55432` (local EDB cluster — no Docker/`gh`
in this environment). DBs `b2b_auth_test` / `b2b_auth_shadow_test`. API integration
gate: **61/61, 0 skipped**. Database gate: **72/72, 0 skipped**. Fresh-DB migrate
deploy + idempotent re-deploy + seed (61 perms / 6 roles / 201 role-perms) + catalog
verification all passed. The fail-closed gate (`api-test-gate.mjs`) refuses to pass
without a reachable DB, on zero tests, or on any skip.

## 14. Commands actually run (all PASS)

`pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`
(18 tasks), `pnpm test:unit` (domain+api), `pnpm build` (10), `pnpm check:openapi`
(gen + no tracked drift), `pnpm check:secrets`, `pnpm check:boundaries`,
`pnpm check:no-skip`, `pnpm check:docs`, Prisma `format`/`validate`/`generate`,
`migrate deploy` (×2 idempotent), `db:drift`, `db:verify-catalog`, `db:seed` (×2),
`pnpm test:integration:api` (61), `pnpm test:database-gate` (72), Playwright E2E (6).
GitHub Actions was **not** run (no remote / `gh` unavailable); the `authentication`
job is wired in `.github/workflows/ci.yml` and everything was executed locally on
real PostgreSQL 16.9 instead.

## 15. Branch & commits

Branch `ai/claude-auth-foundation`. Commits (no force-push, no history rewrite):
`docs: record approved database foundation gate` → `feat(db): …schema (migration)` →
`feat(auth): add password and token primitives` → `feat(auth): session rotation and
reuse detection` → `feat(auth): login and account security` → `feat(auth): password
reset and audit` → `feat(web): authenticated session flow` → `test(auth): cover
authentication security flows` → `ci: enforce authentication test gate`.

## 16. Known risks / limitations

- HS256 (symmetric) this milestone; RS256 (SECURITY_MODEL §1) deferred but is a single
  adapter swap. Document/operate accordingly until then.
- Reset token raw value is stored in `outbox_events.payload` (private DB, never logged);
  at-rest encryption of that payload is a future hardening.
- Redis rate-limiter fails **open** on outage (Postgres lockout remains authoritative) —
  a deliberate availability/security trade-off.
- No remote CI verification (no run URL); local real-PG evidence only.
- A concurrent legitimate double-submit of a refresh token is treated as reuse (family
  revoked) — correct-but-strict; rare in practice.

## 17. Needed before TASK-010 / TASK-010a

- The `JwtAuthGuard` is authentication-only; `PermissionsGuard` / grant-ceiling /
  protected-role logic and the role/permission/scope endpoints are TASK-010/010a/011.
- `/auth/me` returns role **names** for display only — never use it for authorization.
- DBF-008 (actor grant ceiling in role/permission assignment) remains open for 010a.
- Permission catalog + seed (`@b2b/domain` rbac, already present) is the source of truth
  for the upcoming guards.

## 18. Points for Codex to scrutinize

1. Token-reuse handling commits the family revoke (rotate returns a result union; no
   throw inside the tx) — confirm no path rolls the revoke back.
2. `SELECT ... FOR UPDATE` rotation serialization vs. the concurrency assertions.
3. Generic login response across unknown/wrong/disabled/locked + timing-equalization
   (dummy-hash burn) — any residual enumeration/timing oracle?
4. Audit redaction completeness (`hash`/`digest` suffixes) and that no raw secret reaches
   `audit_logs` / logs / outbox logs.
5. Cookie `SameSite=Strict` + CSRF reasoning; Secure-in-prod default.
6. Rate-limiter fail-open-on-outage decision and that Postgres lockout is authoritative.
7. Migration additivity / drift / the non-unique `session_id` choice.
8. HS256 acceptability for this milestone and the RS256 migration seam.
