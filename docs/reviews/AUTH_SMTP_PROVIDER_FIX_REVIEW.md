# Auth SMTP Provider Fix Review

Date: 2026-06-15

Scope: focused review of commit `98f46c24ced11f1186a307332883659bf61a600d`.
Production code was not modified.

Result: **FIX_APPROVED_WITH_NON_BLOCKING_NOTES**

## Blocking Findings

None.

## Verification Checklist

1. `LoggingResetEmailProvider` is removed from production code. The file is
   deleted in the commit, and `rg` finds no remaining production references.
   Only the prior review document mentions it.
2. Production wiring binds `RESET_EMAIL_PROVIDER` to `SmtpResetEmailProvider`
   in `apps/api/src/modules/security/security.module.ts`.
3. `SmtpResetEmailProvider.send()` awaits `transport.sendMail()` before
   returning a provider message id. It cannot produce success without a resolved
   SMTP handoff.
4. SMTP throws go through the non-idempotent provider path:
   `supportsIdempotency=false` causes `PasswordResetDeliveryService` to call
   `markUnknown()`. The repository leaves ciphertext/nonce/auth tag intact.
5. On SMTP success, the service calls `provider.send()` before
   `markDelivered()`. The finalizer atomically sets `SUCCEEDED`, persists
   `providerMessageId`, drops the lease, clears last error, and nulls the
   encrypted secret fields.
6. `FakeResetEmailProvider` lives under `apps/api/test/support` and is injected
   only by test helpers/overrides.
7. `FakeResetEmailProvider` throws on construction when `NODE_ENV=production`.
8. Production SMTP config fails fast at config load/boot for missing
   `SMTP_USER` or `SMTP_PASSWORD`; `AppConfigModule` loads `loadApiConfig()` at
   Nest boot.
9. Non-blocking design note: production relays that are valid without SMTP
   username/password are currently blocked by config validation. This is
   stricter than strictly necessary, but it does not reintroduce a fake/logging
   success path.
10. The inspected SMTP/delivery log calls do not include the raw reset token or
    reset URL. The SMTP unit test also asserts this.
11. Nodemailer error objects are not logged with raw metadata. The delivery
    service extracts the error message for state recording and logs only safe
    event fields.
12. Deterministic `Message-ID` is documented as audit/correlation only, not an
    SMTP idempotency guarantee.
13. `SmtpResetEmailProvider.supportsIdempotency` remains `false`.
14. SMTP throw with `supportsIdempotency=false` does not auto-retry; the row is
    quarantined as `UNKNOWN` and is not claimable for automatic redelivery.
15. The commit message explicitly states that no real external SMTP/Mailpit test
    was available and that the SMTP adapter is covered by mocked-transport unit
    tests only.

## Verification Run

- `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/smtp-reset-email-provider.test.ts test/unit/fake-reset-email-provider.test.ts test/unit/password-reset-delivery-service.test.ts`:
  PASS, 14/14 tests.
- `pnpm.cmd --filter @b2b/config exec vitest run test/env.test.ts`:
  PASS, 12/12 tests.
- `pnpm.cmd --filter @b2b/database db:validate`:
  PASS after setting a test `DATABASE_URL`; the first attempt failed only because
  Prisma requires `DATABASE_URL` to parse the schema.
- `pnpm.cmd typecheck`:
  PASS, 18/18 turbo tasks.
- Real PostgreSQL delivery integration tests:
  NOT EXECUTED on this workstation. `pnpm.cmd --filter @b2b/api test:integration`
  failed closed with `DATABASE_URL is not set`; rerunning with
  `postgresql://b2b:b2b@localhost:5432/b2b_test?schema=public` failed closed with
  `cannot reach PostgreSQL at localhost:5432`. Local 5432/55432 probes failed,
  Docker CLI is unavailable, and no local PostgreSQL service/psql command was
  found.

## Final Gate

**FIX_APPROVED_WITH_NON_BLOCKING_NOTES**
