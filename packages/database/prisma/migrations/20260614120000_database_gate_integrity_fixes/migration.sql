-- ===========================================================================
-- Database Gate integrity fixes (DBF-003..DBF-007).
--
-- Forward-only migration appended after 20260614000000_init. It does NOT
-- rewrite history. Structure:
--   1. Prisma-modelable DDL (FK onDelete CASCADE→RESTRICT for transaction
--      parent→child edges; new effect_receipts / import_jobs columns, FKs and
--      indexes). Produced by `prisma migrate diff` MINUS the 5 plain unique
--      index recreations that are really the soft-delete partial-unique indexes
--      from the init migration (those would collide; the drift gate allowlists
--      them — see scripts/check-drift.mjs).
--   2. Hand-written DDL Prisma cannot express: partial unique indexes
--      (customer default address, active import checksum), effect-receipt state
--      CHECK constraints, transaction-parent delete-prevention triggers, and
--      search_path-hardened trigger functions (DATABASE_DESIGN §17/§22).
-- ===========================================================================

-- 1. Prisma-modelable DDL ---------------------------------------------------

-- 1.1 Replace transaction parent→child ON DELETE CASCADE with RESTRICT, so a
--     parent (order/transfer/return/invoice/quote/import) can never be deleted
--     while its immutable children/history exist (DBF-003).
-- DropForeignKey
ALTER TABLE "import_job_errors" DROP CONSTRAINT "import_job_errors_import_job_id_fkey";
ALTER TABLE "import_rows" DROP CONSTRAINT "import_rows_import_job_id_fkey";
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_invoice_id_fkey";
ALTER TABLE "invoice_status_history" DROP CONSTRAINT "invoice_status_history_invoice_id_fkey";
ALTER TABLE "order_price_overrides" DROP CONSTRAINT "order_price_overrides_order_id_fkey";
ALTER TABLE "order_price_overrides" DROP CONSTRAINT "order_price_overrides_order_item_id_fkey";
ALTER TABLE "order_status_history" DROP CONSTRAINT "order_status_history_order_id_fkey";
ALTER TABLE "quote_items" DROP CONSTRAINT "quote_items_quote_id_fkey";
ALTER TABLE "return_items" DROP CONSTRAINT "return_items_return_id_fkey";
ALTER TABLE "return_status_history" DROP CONSTRAINT "return_status_history_return_id_fkey";
ALTER TABLE "stock_transfer_items" DROP CONSTRAINT "stock_transfer_items_transfer_id_fkey";
ALTER TABLE "transfer_status_history" DROP CONSTRAINT "transfer_status_history_transfer_id_fkey";

-- AlterTable: effect_receipts gains its outbox link + crash-state timestamp.
ALTER TABLE "effect_receipts" ADD COLUMN     "completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "outbox_event_id" BIGINT NOT NULL;

-- AlterTable: import_jobs gains company scope + crash-recovery/replay columns.
ALTER TABLE "import_jobs" ADD COLUMN     "attempt_number" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "company_id" BIGINT NOT NULL,
ADD COLUMN     "heartbeat_at" TIMESTAMPTZ(6),
ADD COLUMN     "lease_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "replay_of_import_id" BIGINT,
ADD COLUMN     "resumed_from_row" INTEGER;

-- CreateIndex
CREATE INDEX "effect_receipts_outbox_event_id_idx" ON "effect_receipts"("outbox_event_id");
CREATE UNIQUE INDEX "effect_receipts_effect_type_provider_idempotency_key_key" ON "effect_receipts"("effect_type", "provider_idempotency_key");
CREATE INDEX "import_jobs_company_id_idx" ON "import_jobs"("company_id");
CREATE INDEX "import_jobs_replay_of_import_id_idx" ON "import_jobs"("replay_of_import_id");

-- AddForeignKey (transaction parent→child edges re-added as RESTRICT)
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfer_status_history" ADD CONSTRAINT "transfer_status_history_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_price_overrides" ADD CONSTRAINT "order_price_overrides_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_price_overrides" ADD CONSTRAINT "order_price_overrides_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "return_status_history" ADD CONSTRAINT "return_status_history_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_status_history" ADD CONSTRAINT "invoice_status_history_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_job_errors" ADD CONSTRAINT "import_job_errors_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (new relations)
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_replay_of_import_id_fkey" FOREIGN KEY ("replay_of_import_id") REFERENCES "import_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "effect_receipts" ADD CONSTRAINT "effect_receipts_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "effect_receipts" ADD CONSTRAINT "effect_receipts_output_file_id_fkey" FOREIGN KEY ("output_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- 2. Hand-written DDL (not expressible in Prisma) ---------------------------
-- ===========================================================================

-- 2.1 Customer default address uniqueness (DBF-004) -------------------------
-- At most one active default address per (customer, type); soft-deleted rows
-- are excluded so a new default can replace a soft-deleted one.
CREATE UNIQUE INDEX "customer_addresses_default_per_type_key"
  ON "customer_addresses"("customer_id", "type")
  WHERE "is_default" = TRUE AND "deleted_at" IS NULL;

-- 2.2 Active import duplicate policy (DBF-005) ------------------------------
-- At most one in-flight import per (company, file checksum). Terminal imports
-- (COMPLETED / *_FAILED / CANCELLED) are excluded, so a retry can be created as
-- a new attempt linked via replay_of_import_id.
CREATE UNIQUE INDEX "import_jobs_active_checksum_key"
  ON "import_jobs"("company_id", "file_checksum_sha256")
  WHERE "status" IN ('UPLOADED', 'VALIDATING', 'VALIDATED', 'IMPORTING');

-- 2.3 Effect receipt crash-state invariants (DBF-006 / ADR-008 G-17) --------
-- A SUCCEEDED effect must carry completed_at; a PLANNED effect must not (it has
-- not been attempted yet). IN_PROGRESS / FAILED / UNKNOWN are unconstrained.
ALTER TABLE "effect_receipts"
  ADD CONSTRAINT "effect_receipts_succeeded_completed"
    CHECK ("status" <> 'SUCCEEDED' OR "completed_at" IS NOT NULL),
  ADD CONSTRAINT "effect_receipts_planned_not_completed"
    CHECK ("status" <> 'PLANNED' OR "completed_at" IS NULL);

-- 2.4 search_path-hardened trigger functions (DBF-007) ----------------------
-- Recreate the existing functions with a controlled search_path so future
-- edits cannot become search_path sensitive, and add prevent_delete().
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'append_only_violation: table % is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- prevent_delete blocks DELETE only (UPDATE — e.g. status transitions — is
-- still allowed) on transaction aggregate parents and on soft-delete master
-- data that must never be hard-deleted (DBF-003).
CREATE OR REPLACE FUNCTION prevent_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'delete_forbidden: table % is a transaction/immutable record and cannot be hard-deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 2.5 Transaction-parent / master delete prevention (DBF-003) ---------------
-- BEFORE DELETE only — these tables still accept UPDATE for status transitions.
CREATE TRIGGER no_delete_orders BEFORE DELETE ON "orders" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_stock_transfers BEFORE DELETE ON "stock_transfers" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_returns BEFORE DELETE ON "returns" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_invoices BEFORE DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_quotes BEFORE DELETE ON "quotes" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_import_jobs BEFORE DELETE ON "import_jobs" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_export_jobs BEFORE DELETE ON "export_jobs" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_outbox_events BEFORE DELETE ON "outbox_events" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_effect_receipts BEFORE DELETE ON "effect_receipts" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_stock_reservations BEFORE DELETE ON "stock_reservations" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
CREATE TRIGGER no_delete_job_logs BEFORE DELETE ON "job_logs" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
-- users are soft-delete master data: a hard DELETE would orphan/erase actor
-- history, so it is blocked at the DB level (deactivate via deleted_at instead).
CREATE TRIGGER no_delete_users BEFORE DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION prevent_delete();
