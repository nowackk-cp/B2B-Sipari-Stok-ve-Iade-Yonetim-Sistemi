-- Password-reset delivery secret (AUTH-BLOCK-001) — additive only.
--
-- The raw password-reset token must never be persisted in plaintext (it used to
-- ride in `outbox_events.payload.resetToken`). Instead the deliverable token is
-- envelope-encrypted with AES-256-GCM (key is env-only, never in the DB) and the
-- ciphertext/nonce/auth-tag live on the reset row. The mail dispatcher decrypts
-- to send the link, then NULLs the three columns and stamps
-- `delivery_consumed_at` so delivery is single-shot and idempotent.
--
-- Purely additive: new nullable columns on an append-friendly (non append-only)
-- table. Earlier migrations and their Prisma-invisible custom SQL are untouched,
-- so `prisma migrate diff` reports zero drift.

ALTER TABLE "password_reset_tokens"
  ADD COLUMN "delivery_ciphertext" BYTEA,
  ADD COLUMN "delivery_nonce" BYTEA,
  ADD COLUMN "delivery_auth_tag" BYTEA,
  ADD COLUMN "delivery_consumed_at" TIMESTAMPTZ(6);
