-- Auth Foundation (TASK-009) — additive identity/session schema.
--
-- Hand-written so it touches ONLY the three identity tables and leaves the
-- Prisma-invisible custom SQL (partial-unique soft-delete indexes, append-only
-- triggers) from earlier migrations untouched. All object names match Prisma's
-- generated conventions so `prisma migrate diff` reports zero drift.
--
-- These tables are empty in every environment (authentication did not exist
-- before this milestone), so NOT NULL additions and the column rename are safe.

-- users: durable account-security state -------------------------------------
ALTER TABLE "users"
  ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until" TIMESTAMPTZ(6),
  ADD COLUMN "password_changed_at" TIMESTAMPTZ(6);

-- refresh_tokens: public session id + rotation chain + metadata --------------
ALTER TABLE "refresh_tokens"
  ADD COLUMN "session_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "token_family_id" UUID NOT NULL,
  ADD COLUMN "replaced_by_token_id" BIGINT,
  ADD COLUMN "revoke_reason" TEXT,
  ADD COLUMN "last_used_at" TIMESTAMPTZ(6);

CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");
CREATE INDEX "refresh_tokens_token_family_id_idx" ON "refresh_tokens"("token_family_id");
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_replaced_by_token_id_fkey"
  FOREIGN KEY ("replaced_by_token_id") REFERENCES "refresh_tokens"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- password_reset_tokens: canonical consumed_at + requesting ip ---------------
ALTER TABLE "password_reset_tokens" RENAME COLUMN "used_at" TO "consumed_at";
ALTER TABLE "password_reset_tokens" ADD COLUMN "requested_by_ip" INET;
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");
