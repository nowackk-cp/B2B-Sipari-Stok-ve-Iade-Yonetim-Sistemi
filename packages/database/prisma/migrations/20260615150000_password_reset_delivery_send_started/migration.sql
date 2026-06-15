-- Password-reset delivery "send started" fencing mark (AUTH-RESET-DELIVERY-003).
--
-- The SMTP provider advertises supportsIdempotency=false: a second sendMail with
-- the same content produces a second real email. The prior lease model could
-- still re-send: a worker that claimed a row, handed the message to SMTP, and
-- then crashed BEFORE the DB success update left the row IN_PROGRESS with the
-- secret intact; once the lease lapsed another worker re-claimed and called
-- sendMail again — a duplicate email.
--
-- This column records the instant the provider call is about to be attempted
-- (written by markSendStarted, fenced by the claim token, immediately before the
-- send). Reclaim now distinguishes:
--   * delivery_send_started_at IS NULL     -> provider never called; re-claimable.
--   * delivery_send_started_at IS NOT NULL -> a send was already attempted; for a
--     non-idempotent provider the row is NOT auto-reclaimed and is quarantined as
--     UNKNOWN (manual review), so no second sendMail is issued.
--
-- Purely additive: one new nullable column on a non append-only table. Earlier
-- migrations and their Prisma-invisible custom SQL are untouched, so
-- `prisma migrate diff` reports zero drift.

ALTER TABLE "password_reset_tokens"
  ADD COLUMN "delivery_send_started_at" TIMESTAMPTZ(6);
