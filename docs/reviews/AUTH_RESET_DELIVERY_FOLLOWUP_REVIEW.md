# Auth Reset Delivery Follow-up Review

Date: 2026-06-15

Scope: follow-up review of commit `ebb8c427e9a0c629fdc3c7f8867f3cefb8b389dc`.
Production code was not modified.

Result: **FIX_REJECTED**

## Blocking Findings

### AUTH-RESET-DELIVERY-001: delivery finalization is not claim-owner protected

Severity: **HIGH / Mandatory Reject**

Locations:

- `apps/api/src/modules/security/password-reset.repository.ts:161`
- `apps/api/src/modules/security/password-reset.repository.ts:189`
- `apps/api/src/modules/security/password-reset.repository.ts:207`
- `apps/api/src/modules/security/password-reset-delivery.service.ts:95`
- `apps/api/src/modules/security/password-reset-delivery.service.ts:119`
- `apps/api/src/modules/security/password-reset-delivery.service.ts:131`

`markDelivered`, `markFailed`, and `markUnknown` are guarded only by
`{ id, deliveryStatus: 'IN_PROGRESS' }`. They do not check a claim token, lease
owner, `deliveryLeaseUntil`, or an attempt id.

Impact:

- A worker that no longer owns the lease can call `markDelivered` while a newer
  worker owns the row and is still `IN_PROGRESS`, causing the stale worker to
  finalize the newer claim and erase the secret.
- A stale worker can call `markFailed` or `markUnknown` after another worker has
  re-claimed the row, dropping/quarantining the newer worker's live lease.
- `PasswordResetDeliveryService.deliver()` ignores the row count returned by
  `markDelivered` / `markFailed` / `markUnknown`, so it can return `delivered:
  true` even if its DB finalization lost the race and updated zero rows.

This fails the explicit review gate: a stale worker can overwrite another
worker's in-progress result after lease expiry.

### AUTH-RESET-DELIVERY-002: default provider is a logging placeholder that marks rows SUCCEEDED

Severity: **HIGH**

Locations:

- `apps/api/src/modules/security/security.module.ts:26`
- `apps/api/src/modules/security/adapters/logging-reset-email-provider.ts:24`
- `apps/api/src/modules/security/adapters/logging-reset-email-provider.ts:27`
- `apps/api/src/modules/security/password-reset-delivery.service.ts:90`
- `apps/api/src/modules/security/password-reset-delivery.service.ts:95`

The production module binds `RESET_EMAIL_PROVIDER` to
`LoggingResetEmailProvider`. That adapter does not hand the message to a real
SMTP/API provider. It derives a deterministic `providerMessageId` from the
idempotency key, logs metadata, and returns success. The delivery service then
marks the row `SUCCEEDED` and NULLs the ciphertext/nonce/auth tag.

Impact: with the default binding, a reset delivery can be recorded as succeeded
and the only deliverable secret can be erased even though no real email was sent.

### AUTH-RESET-DELIVERY-003: non-idempotent crash-after-send is still not safe

Severity: **HIGH**

Locations:

- `apps/api/src/modules/security/password-reset.repository.ts:108`
- `apps/api/src/modules/security/password-reset.repository.ts:112`
- `apps/api/src/modules/security/password-reset-delivery.service.ts:90`
- `apps/api/src/modules/security/password-reset-delivery.service.ts:117`

`supportsIdempotency` is consulted only when `provider.send()` throws. If a
non-idempotent provider returns success and the process crashes before
`markDelivered`, the row remains `IN_PROGRESS` with the secret intact. After the
lease expires, `claimForDelivery` will auto-claim and send again. There is no
recorded provider capability or in-progress ambiguity state that forces
`UNKNOWN` for this case.

Impact: a non-idempotent provider can create a second real email after the
provider-success / DB-update crash window.

## Required Checks

1. Claim does not delete ciphertext/nonce/auth tag: **PASS**. `claimForDelivery`
   updates status/lease/attempt/idempotency key only.
2. Secret is cleared after `provider.send()` returns: **PARTIAL**. Service order
   is correct for its own happy path, but finalizers are unowned and the default
   provider is only a logging placeholder.
3. Crash before provider call can be re-claimed after lease expiry: **PASS**.
4. Concurrent workers produce one claim winner: **PASS**.
5. `SUCCEEDED` rows are not re-sent: **PASS**.
6. Provider success / DB update crash uses a stable key: **PASS for idempotent
   providers** via `password-reset:{id}`.
7. Idempotent fake provider does not create a second real email: **PASS in
   tests**.
8. Non-idempotent ambiguous throw becomes `UNKNOWN` and is not auto-retried:
   **PASS for thrown errors; FAIL for crash-after-success ambiguity**.
9. `FAILED` preserves the secret: **PASS**.
10. Raw token not found in DB payload/audit/log checks: **PASS in tests/static
    inspection**.
11. Migration is additive and Prisma drift is clean: **PASS**.
12. PostgreSQL integration tests really run and are not skipped: **PASS**.

## Additional Risk

`FAILED` is always claimable and `deliveryAttemptCount` is not capped or used in
the `where` clause. A permanently failing idempotent provider can therefore be
retried without a repository-level attempt limit or backoff guard.

## Verification Run

Database: real PostgreSQL 16.9 at `127.0.0.1:55432`, database `b2b_test`.

Commands:

- `pnpm.cmd --filter @b2b/database db:validate`: PASS.
- `pnpm.cmd --filter @b2b/database db:migrate:deploy`: PASS; migrations applied.
- second `pnpm.cmd --filter @b2b/database db:migrate:deploy`: PASS; no pending
  migrations.
- `pnpm.cmd --filter @b2b/database db:drift`: PASS; 0 unexpected drift
  statements.
- `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/password-reset-delivery-service.test.ts test/unit/password-reset-delivery-cipher.test.ts`:
  PASS; 12/12 tests.
- `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/auth-password-reset-delivery.test.ts test/integration/auth-password-reset-secret.test.ts test/integration/auth-password.test.ts`:
  PASS; 22/22 tests.
- `pnpm.cmd --filter @b2b/api test:integration`: PASS; 73/73 real PostgreSQL
  tests executed, 0 skipped.
- `pnpm.cmd check:no-skip`: PASS.
- `pnpm.cmd typecheck`: PASS; 18/18 turbo tasks.

## Final Gate

**FIX_REJECTED**
