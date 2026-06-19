-- Return / Refund Foundation — raise + approve a customer return for a SHIPPED order.
--
-- WHY THIS EXISTS
-- The returns module gains its first write paths: `POST /orders/:id/returns`
-- raises a return (status DRAFT, NO stock effect) and `POST /returns/:id/approve`
-- restocks the resellable quantity back into the order's source warehouse in ONE
-- transaction — `on_hand += qty` on each (product, warehouse) balance, one positive
-- `RETURN_IN` `stock_ledger` movement per line (`reserved` untouched), the return
-- DRAFT→APPROVED transition, its status history and the business audit all commit
-- or roll back together.
--
-- WHAT IT ADDS (additive only — earlier migrations are byte-for-byte untouched)
--   • returns.company_id (NOT NULL) — the owning tenant; the order/customer/
--     warehouse FKs become company-pinned composites so a cross-company return is
--     physically un-insertable.
--   • returns.warehouse_id (NOT NULL) — the source warehouse the goods return to
--     (RETURN_RULES §3); the restock + RETURN_IN ledger target it.
--   • returns.invoice_id — optional link to the order's invoice (reserved for the
--     future credit-note task); SET NULL.
--   • returns.idempotency_key (NOT NULL) / returns.approve_idempotency_key — client
--     idempotency anchors for create / approve. A same-key replay returns the
--     existing return (no duplicate return/ledger); reuse for a different
--     order/return is a 409.
--   • returns.approved_by / returns.approved_at — who approved + when.
--   • return_items.company_id (NOT NULL) + return_items.reason — the line's tenant
--     (pinned to the return AND product via composite FKs) + optional per-line note.
--   • Unique (company_id, idempotency_key) / (company_id, approve_idempotency_key)
--     — at most one return per create key / one approve per approve key (NULL
--     approve keys coexist under NULLS DISTINCT). Unique (id, company_id) is the
--     composite-FK target return_items.(return_id, company_id) references.
--
-- The returns table is empty in every environment (no prior write path), so the new
-- NOT NULL columns are added without a backfill. `returns` stays managed by status
-- transition (the existing no_delete_returns trigger blocks DELETE);
-- return_status_history stays append-only (no_mutation trigger). The verify-catalog
-- gate asserts `return_items_return_id_fkey` stays RESTRICT — the FK is recreated as
-- a company-pinned composite KEEPING that exact constraint name.

-- DropForeignKey
ALTER TABLE "return_items" DROP CONSTRAINT "return_items_product_id_fkey";

-- DropForeignKey
ALTER TABLE "return_items" DROP CONSTRAINT "return_items_return_id_fkey";

-- DropForeignKey
ALTER TABLE "returns" DROP CONSTRAINT "returns_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "returns" DROP CONSTRAINT "returns_order_id_fkey";

-- AlterTable
ALTER TABLE "return_items" ADD COLUMN     "company_id" BIGINT NOT NULL,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "approve_idempotency_key" TEXT,
ADD COLUMN     "approved_at" TIMESTAMPTZ(6),
ADD COLUMN     "approved_by" BIGINT,
ADD COLUMN     "company_id" BIGINT NOT NULL,
ADD COLUMN     "idempotency_key" TEXT NOT NULL,
ADD COLUMN     "invoice_id" BIGINT,
ADD COLUMN     "warehouse_id" BIGINT NOT NULL;

-- CreateIndex
CREATE INDEX "return_items_company_id_idx" ON "return_items"("company_id");

-- CreateIndex
CREATE INDEX "returns_company_id_idx" ON "returns"("company_id");

-- CreateIndex
CREATE INDEX "returns_warehouse_id_idx" ON "returns"("warehouse_id");

-- CreateIndex
CREATE INDEX "returns_invoice_id_idx" ON "returns"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "returns_company_id_idempotency_key_key" ON "returns"("company_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "returns_company_id_approve_idempotency_key_key" ON "returns"("company_id", "approve_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "returns_id_company_id_key" ON "returns"("id", "company_id");

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_company_id_fkey" FOREIGN KEY ("order_id", "company_id") REFERENCES "orders"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_id_company_id_fkey" FOREIGN KEY ("customer_id", "company_id") REFERENCES "customers"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_warehouse_id_company_id_fkey" FOREIGN KEY ("warehouse_id", "company_id") REFERENCES "warehouses"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_fkey" FOREIGN KEY ("return_id", "company_id") REFERENCES "returns"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_product_id_company_id_fkey" FOREIGN KEY ("product_id", "company_id") REFERENCES "products"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;
