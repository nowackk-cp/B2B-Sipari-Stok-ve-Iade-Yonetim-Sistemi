# Auth Reset Token Fix Review

Date: 2026-06-15

Scope: review commit `76ba9f5 fix(auth): seal password-reset token instead of storing it plaintext`.
Production code, migrations, and tests were not modified.

Result: **FIX_REJECTED**

## Executive Decision

The raw password-reset token plaintext storage blocker is mostly fixed: I did not find the raw token persisted in `outbox_events.payload`, audit rows, email rows, logs, or DB columns outside the encrypted delivery fields on `password_reset_tokens`.

The fix is still rejected because the delivery lifecycle permanently erases the only deliverable secret before the real email provider call exists or can complete. If the worker claims/decrypts the secret and then crashes before SMTP/provider send, retry cannot reconstruct the reset email. This is a lost-email failure mode and is a mandatory reject condition from this review request.

## Finding

### AUTH-RESET-FIX-001

Severity: **HIGH / Mandatory Reject**

Location:

- `apps/api/src/modules/security/password-reset-delivery.service.ts:38`
- `apps/api/src/modules/security/password-reset.repository.ts:113`

Evidence:

- `deliver()` loads the sealed secret with `findDeliverable()` at `password-reset-delivery.service.ts:39`.
- It claims the secret before decrypting or sending at `password-reset-delivery.service.ts:44-45`.
- `claimDeliverySecret()` immediately sets `delivery_ciphertext`, `delivery_nonce`, and `delivery_auth_tag` to `NULL` and stamps `delivery_consumed_at` at `password-reset.repository.ts:114-120`.
- Decrypt happens only after the DB erase at `password-reset-delivery.service.ts:50`.
- There is no real SMTP/provider send inside this service; the service returns `{ delivered: true, email, token }` at `password-reset-delivery.service.ts:60`.

Impact:

If a worker calls `deliver()`, decrypts successfully, and then the process crashes before the email is sent, the retry cannot send the reset email. The DB has already erased the ciphertext/nonce/tag and marked the row consumed, so the next delivery attempt returns `no_secret` or `already_delivered`.

Test evidence:

- Existing integration test `apps/api/test/integration/auth-password-reset-secret.test.ts:88` proves the problematic state: after the first `deliver()`, ciphertext/nonce/tag are null and a second `deliver()` returns `delivered: false`.
- That test currently treats this as idempotent redelivery, but for the requested crash scenario it demonstrates lost delivery.

Required fix direction:

Do not erase the delivery secret or stamp delivery consumed before the email provider call has succeeded and the success state has been durably recorded. Use a state model compatible with ADR-008: planned/in-progress before provider call, provider idempotency key during provider call, succeeded after provider success, and retryable/unknown handling for crashes.

## Control Checks

### Raw Token Persistence

Status: **PASS**

- `PasswordResetService.requestReset()` generates raw token + digest, immediately seals the raw token, and only persists digest plus ciphertext/nonce/tag: `apps/api/src/modules/security/password-reset.service.ts:52-61`.
- Production outbox adapter payload has no `resetToken`: `apps/api/src/modules/auth/adapters/outbox-email.adapter.ts:31-38`.
- Integration scan checks `password_reset_tokens`, `outbox_events.payload`, `audit_logs`, and `email_messages` for the delivered raw token and passed: `apps/api/test/integration/auth-password-reset-secret.test.ts:21-85`.
- Reset verification still uses SHA-256 digest via `consume()` and `consumeByDigest()`: `apps/api/src/modules/security/password-reset.service.ts:86-88`, `apps/api/src/modules/security/password-reset.repository.ts:66-76`.

### AES-256-GCM

Status: **PASS**

- Uses `aes-256-gcm`, 12-byte random nonce, 16-byte auth tag, and `randomBytes()` per encryption: `apps/api/src/modules/security/password-reset-delivery.cipher.ts:6-53`.
- Auth tag is set and verified through `decipher.final()`: `apps/api/src/modules/security/password-reset-delivery.cipher.ts:60-67`.
- Unit tests cover round-trip, fresh nonce, wrong key rejection, ciphertext tamper rejection, auth-tag tamper rejection, and short-key fail-fast.
- `PASSWORD_RESET_DELIVERY_KEY` is required in config and min 32 chars, with a second byte-length guard in the cipher constructor: `packages/config/src/env.ts:122-124`, `apps/api/src/modules/security/password-reset-delivery.cipher.ts:35-45`.
- I found no logging of raw key material or raw reset token in the reset delivery path.

### Migration

Status: **PASS with note**

- The migration is additive only: `packages/database/prisma/migrations/20260615120000_password_reset_delivery_secret/migration.sql:14-18`.
- It adds nullable `BYTEA` fields for ciphertext/nonce/auth tag and nullable `TIMESTAMPTZ(6)` for `delivery_consumed_at`.
- Git shows the migration as a new file only; earlier migration files were not changed.
- Non-blocking note: there are no DB `CHECK` constraints enforcing nonce length 12, auth-tag length 16, or all-or-none delivery secret columns.

### Outbox Payload

Status: **PASS with note**

- The raw token is absent from production and test outbox payloads.
- Payload contains only safe references/metadata: reset-row id, public user id, recipient email, type/template, expiry.
- Non-blocking note: the current payload uses `to` for email and includes extra `template`; the requested allowlist names `email` and does not list `template`. This is not a secret leak, but the contract should be made exact if consumers require those field names.

### Provider Idempotency / Exactly Once

Status: **NOT PROVEN**

- No real password-reset email provider call is implemented in this commit.
- No provider idempotency key is passed through `PasswordResetDeliveryService`.
- The schema has `effect_receipts.provider_idempotency_key`, and ADR-008 requires provider idempotency for exactly-once external effects, but this reset delivery path is not wired to it yet.
- If a future worker sends email successfully and crashes before recording provider success, exactly-once delivery cannot be guaranteed without a provider idempotency key. With the current pre-send secret erase, the more immediate failure is lost email rather than duplicate email.

## Test Evidence

Environment:

- Real PostgreSQL at `127.0.0.1:55432`.
- Test DB: `b2b_auth_reset_fix_test_20260615_01`.

Commands run:

| Check | Result |
| --- | --- |
| `prisma migrate deploy --schema packages/database/prisma/schema.prisma` | PASS; all 4 migrations applied |
| second `prisma migrate deploy --schema packages/database/prisma/schema.prisma` | PASS; no pending migrations |
| `prisma validate --schema packages/database/prisma/schema.prisma` | PASS |
| `apps/api` focused unit: cipher + outbox adapter | PASS; 8/8 |
| `apps/api` focused integration: `auth-password-reset-secret.test.ts`, `auth-password.test.ts` | PASS; 13/13 |
| `packages/logger` unit tests | PASS; 12/12 |
| `pnpm.cmd typecheck` | PASS; 18/18 turbo tasks |
| Static log/audit token scan over reset/auth/logger/config paths | PASS for no raw-token logger/audit sink; only config/key definitions and comments matched |

## Final Gate

**FIX_REJECTED**
