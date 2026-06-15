# Authentication Foundation Follow-up Gate Review

Date: 2026-06-15

Scope: follow-up gate review after the reset-token, reset-delivery, SMTP provider, and SMTP crash-after-send fixes. Production code was not modified. A temporary PostgreSQL integration test was created only to verify the stale-worker/UNKNOWN race, then removed.

Gate result: **APPROVED_WITH_NON_BLOCKING_NOTES**

## Executive Decision

Authentication Foundation is no longer blocked by the previous mandatory password-reset findings. The raw reset token is not persisted in plaintext; the encrypted delivery secret is preserved until provider success; claim-token fencing blocks stale workers; production wiring uses the real SMTP provider; and non-idempotent SMTP sends that already started are quarantined as `UNKNOWN` rather than resent.

No mandatory reject condition reproduced: no raw token leak, no refresh race, no missing JWT signature/issuer/audience/expiration validation, no reset-token reuse, no authentication bypass, and the PostgreSQL gates executed real tests with zero skips.

Two prior medium findings remain open as non-blocking notes:

- `AUTH-MED-002`: access tokens are still HS256, while the architecture target says asymmetric signing.
- `AUTH-MED-003`: forgot-password status/body are generic, but explicit timing equalization is still not implemented.

## Prior Findings Status

| Finding | Status | Follow-up result |
| --- | --- | --- |
| `AUTH-BLOCK-001` raw reset token persisted in outbox payload | CLOSED | Raw reset token is sealed before persistence; outbox stores only safe references; PostgreSQL tests scan reset rows, outbox payloads, audit rows, and email rows. |
| `AUTH-RESET-FIX-001` encrypted secret erased before real provider success | CLOSED | Claim no longer erases ciphertext/nonce/tag; `markDelivered` clears them only after provider success. |
| `AUTH-RESET-DELIVERY-001` finalizers not claim-owner fenced | CLOSED | `markSendStarted`, `markDelivered`, `markFailed`, and `markUnknown` require `deliveryClaimToken` plus `IN_PROGRESS`. |
| `AUTH-RESET-DELIVERY-002` fake logging provider in production | CLOSED | Production `SecurityModule` binds `RESET_EMAIL_PROVIDER` to `SmtpResetEmailProvider`; fake provider is test-only. |
| `AUTH-RESET-DELIVERY-003` non-idempotent crash-after-send could resend | CLOSED | Started non-idempotent sends are not reclaimed; stale started rows become `UNKNOWN`; exact race test passed with one provider call. |
| SMTP provider note: unauthenticated production relays are blocked | OPEN | Still strict by config; non-blocking because it prevents fake/no-auth production reset delivery. |
| `AUTH-MED-002` HS256 instead of asymmetric JWT signing | OPEN | JWT validation is complete for this milestone, but architecture target remains RS256/EdDSA. |
| `AUTH-MED-003` forgot-password timing equalization | OPEN | Generic body/status still pass; no explicit timing-equalization control was added. |

No prior finding regressed.

## Mandatory Blocker Closure

- Raw reset token DB/outbox/log/audit plaintext: CLOSED. `PasswordResetService` seals the raw token before persistence; `OutboxEmailAdapter` writes only safe references. Integration test `auth-password-reset-secret.test.ts` scans the raw delivered token across `password_reset_tokens`, `outbox_events.payload`, `audit_logs`, and `email_messages`.
- Encrypted secret provider-success ordering: CLOSED. Delivery claim preserves the secret; `markDelivered` erases it only after `provider.send()` resolves.
- Claim fencing: CLOSED. Repository finalizers are guarded by `deliveryStatus = IN_PROGRESS` and the current `deliveryClaimToken`.
- Fake logging provider: CLOSED. No production `LoggingResetEmailProvider` remains; real production binding is `SmtpResetEmailProvider`.
- Non-idempotent SMTP crash-after-send: CLOSED. Lapsed `IN_PROGRESS` rows with `delivery_send_started_at IS NOT NULL` are quarantined as `UNKNOWN`, not resent.
- `UNKNOWN` secret preservation: CLOSED. `markUnknown` and `quarantineStaleSendStarted` keep ciphertext/nonce/auth tag intact.
- Stale worker cannot turn `UNKNOWN` into `SUCCEEDED`: CLOSED. Temporary exact race test verified Worker A returned `claim_lost`, row stayed `UNKNOWN`, and provider call count stayed `1`.

## Regression Review

| Area | Status |
| --- | --- |
| Argon2id password verification | PASS. `Argon2PasswordHasher` uses argon2id, CSPRNG salt, configured params, safe false on malformed hashes, and rehash detection. |
| Login enumeration protection | PASS for status/body and hash-burn path. Generic 401 for wrong/unknown/disabled/locked is covered. |
| JWT signature, issuer, audience, expiration | PASS. Signer validates HMAC signature before claims, rejects wrong alg/header, issuer, audience, expired tokens, and missing subject/session. |
| Refresh rotation and reuse detection | PASS. Rotation locks by token digest with `FOR UPDATE`; reuse revokes the family and audits. |
| Concurrent refresh single-winner | PASS. Focused concurrency test passed 4/4, including single-winner refresh. |
| Logout and logout-all | PASS. Current-session logout and all-session revoke are scoped and audited. |
| Password reset single-use | PASS. Integration and concurrency tests reject second/concurrent reuse. |
| Reset after session revoke | PASS. Reset revokes all sessions in the same transaction. |
| Cookie security | PASS. Refresh cookie is HttpOnly, SameSite Strict, path-scoped, production-secure by config; E2E confirms no browser storage. |
| Raw password/token leakage | PASS. Secret scan, audit redaction tests, SMTP log tests, and PostgreSQL raw-token scans passed. |
| Prisma model direct response leakage | PASS. Auth responses use hand-written contracts and `toUserProfileView`, not Prisma model spreading. |
| Role/permission/warehouse-scope endpoints | PASS. Controller scan found auth and health controllers only; no role/permission/warehouse mutation API was added. |

## Verification Run

Environment:

- PostgreSQL: `127.0.0.1:55432`
- Main DB: `b2b_auth_test`
- Shadow DB available from prior drift checks: `b2b_auth_shadow_test`
- `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_auth_test?schema=public`

Commands run:

| Check | Result |
| --- | --- |
| `pnpm.cmd test:unit` | PASS; 16 turbo tasks, API unit 52/52, DB unit 16/16, total package unit suites passed. |
| `pnpm.cmd check:no-skip` | PASS; no focused/skipped tests found. Re-run after temporary test removal also PASS. |
| `pnpm.cmd check:secrets` | PASS; no obvious secrets in tracked files. |
| `pnpm.cmd check:boundaries` | PASS. |
| Auth-focused PostgreSQL integration suite (`auth-*.test.ts`) | PASS; 73/73 tests. |
| Focused auth concurrency integration | PASS; 4/4 tests. |
| `pnpm.cmd --filter @b2b/api test:integration` | PASS; 84/84 real PostgreSQL tests, 0 skipped. |
| `pnpm.cmd test:database-gate` | PASS; 72/72 real PostgreSQL tests, 0 skipped. |
| `pnpm.cmd lint` | PASS. |
| `pnpm.cmd typecheck` | PASS; 18/18 turbo tasks. |
| `pnpm.cmd build` | PASS; 10/10 turbo tasks. |
| `pnpm.cmd --filter @b2b/web build` with `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1` | PASS; required so Next inlines the E2E API base URL. |
| `pnpm.cmd --filter @b2b/web test:e2e` | PASS after E2E build env fix; 6/6 Chromium tests. |
| Temporary exact SMTP crash race integration test | PASS; 1/1, then removed. |
| `prisma migrate status` | PASS; database schema up to date. |

Note: the first Playwright E2E attempt failed 4/6 because the preceding web build was produced without `NEXT_PUBLIC_API_BASE_URL`, so the production client had no API base URL. Rebuilding the web app with the E2E API base URL and rerunning produced 6/6 pass. This is an execution-env issue, not an auth-code regression.

## Final Gate

**APPROVED_WITH_NON_BLOCKING_NOTES**
