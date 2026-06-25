# AUTH SMTP Crash Fix Review

Result: FIX_APPROVED

Reviewed commit: `165f910a2be48a3677d36f44f1d4b8032a38dc84`

## Scope

- Commit diff for password reset delivery crash-after-send fencing.
- `PasswordResetDeliveryService`
- `PasswordResetRepository`
- claim / lease / fencing paths
- `SmtpResetEmailProvider`
- migration `20260615150000_password_reset_delivery_send_started`
- related unit and PostgreSQL integration tests

## Findings

No blocking findings.

The non-idempotent SMTP path stamps `delivery_send_started_at` through `markSendStarted` immediately before `provider.send`, and that write is fenced by `deliveryClaimToken`. If `markSendStarted` updates zero rows, `deliver()` returns `claim_lost` before provider invocation.

For non-idempotent providers, lapsed `IN_PROGRESS` rows with `delivery_send_started_at IS NULL` remain reclaimable. Lapsed `IN_PROGRESS` rows with `delivery_send_started_at IS NOT NULL` are excluded from claim and quarantined to `UNKNOWN` without a second provider call. `UNKNOWN` preserves ciphertext/nonce/tag. `SUCCEEDED` clears those fields only in `markDelivered`, after provider success, and `markDelivered` is fenced by `deliveryClaimToken` and `deliveryStatus = IN_PROGRESS`.

`markSendStarted`, `markDelivered`, `markFailed`, and `markUnknown` all require the current claim token and `IN_PROGRESS`, so a stale worker cannot overwrite a newer claim. `quarantineStaleSendStarted` is limited to `IN_PROGRESS`, expired lease, and `deliverySendStartedAt != null`.

The requested race was verified with a temporary PostgreSQL integration test:

1. Worker A entered `provider.send` after `markSendStarted`.
2. Lease expired.
3. Recovery quarantined the row to `UNKNOWN`.
4. Worker A's provider returned success.
5. Worker A returned `claim_lost`; `markDelivered` affected zero rows.
6. Row stayed `UNKNOWN`; provider call count stayed `1`; secret stayed encrypted.

The temporary test file was removed after execution.

## Verification

- `pnpm.cmd --filter @b2b/database db:validate` with `DATABASE_URL=postgresql://b2b:b2b@127.0.0.1:55432/b2b_auth_test?schema=public`: PASS
- `pnpm.cmd --filter @b2b/database db:migrate:deploy`: PASS, applied `20260615150000_password_reset_delivery_send_started`
- `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.unit.config.ts test/unit/password-reset-delivery-service.test.ts test/unit/smtp-reset-email-provider.test.ts --reporter=verbose`: PASS, 15/15
- `pnpm.cmd --filter @b2b/api exec vitest run --config vitest.integration.config.ts test/integration/auth-password-reset-delivery.test.ts --reporter=verbose`: PASS, 20/20
- Temporary exact crash-after-send race integration test: PASS, 1/1
- `pnpm.cmd --filter @b2b/api test:integration`: PASS, 84/84 real PostgreSQL tests, 0 skipped
- `pnpm.cmd --filter @b2b/database exec prisma migrate status`: PASS, schema up to date
- `pnpm.cmd --filter @b2b/database db:drift` with shadow DB: PASS, 0 unexpected drift
- `pnpm.cmd check:no-skip`: PASS
- `pnpm.cmd typecheck`: PASS

## Raw Token Check

Static inspection and existing PostgreSQL tests show the raw reset token is not written to logs, audit rows, or outbox payloads. The SMTP provider only logs `idempotencyKey` and `providerMessageId`; outbox payload stores only safe references; audit rows use explicit safe projections plus defensive redaction.
