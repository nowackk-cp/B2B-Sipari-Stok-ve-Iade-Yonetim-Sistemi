-- Password-reset delivery lease + effect-state (AUTH-BLOCK-001 crash-loss fix).
--
-- The previous flow NULLed the encrypted reset secret and stamped
-- `delivery_consumed_at` BEFORE any real email provider call existed. A worker
-- that decrypted and then crashed before the send permanently lost the email.
--
-- This migration adds a lease-based effect-state model (ADR-008): the secret
-- survives until a provider send actually SUCCEEDED. A claim only flips the
-- delivery status + lease; the ciphertext/nonce/tag are erased solely after
-- `delivery_status = 'SUCCEEDED'`. An expired lease lets another worker re-claim.
--
-- Purely additive: a new enum type and new nullable / defaulted columns on a
-- non append-only table. Earlier migrations and their Prisma-invisible custom
-- SQL (partial-unique indexes, append-only triggers) are untouched, so
-- `prisma migrate diff` reports zero drift. `delivery_consumed_at` (added by
-- 20260615120000) is intentionally left in place but no longer written.

CREATE TYPE "password_reset_delivery_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

ALTER TABLE "password_reset_tokens"
  ADD COLUMN "delivery_status" "password_reset_delivery_status" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "delivery_lease_until" TIMESTAMPTZ(6),
  ADD COLUMN "delivery_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "provider_idempotency_key" TEXT,
  ADD COLUMN "provider_message_id" TEXT,
  ADD COLUMN "delivered_at" TIMESTAMPTZ(6),
  ADD COLUMN "delivery_last_error" TEXT;

CREATE INDEX "password_reset_tokens_delivery_status_delivery_lease_until_idx" ON "password_reset_tokens"("delivery_status", "delivery_lease_until");
