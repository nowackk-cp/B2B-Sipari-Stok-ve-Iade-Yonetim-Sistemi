-- Password-reset delivery claim fencing token (AUTH-RESET-DELIVERY-001).
--
-- Previously markDelivered/markFailed/markUnknown were guarded only by
-- `{ id, delivery_status = 'IN_PROGRESS' }`. A worker whose lease had lapsed could
-- still finalize the row after a NEWER worker re-claimed it (both see
-- IN_PROGRESS), letting the stale worker overwrite the new claim and erase the
-- secret.
--
-- This adds a fencing token minted on every successful claim. Finalizers now also
-- require `delivery_claim_token = <the token they claimed with>`; a re-claim
-- rotates the token, so a stale worker's conditional update matches zero rows.
--
-- Purely additive: one new nullable column on a non append-only table. Earlier
-- migrations and their Prisma-invisible custom SQL are untouched, so
-- `prisma migrate diff` reports zero drift.

ALTER TABLE "password_reset_tokens"
  ADD COLUMN "delivery_claim_token" TEXT;
