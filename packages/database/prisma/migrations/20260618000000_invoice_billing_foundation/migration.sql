-- Invoice / Billing Foundation — issue an invoice for a SHIPPED order.
--
-- WHY THIS EXISTS
-- The billing module gains its first write path: `POST /orders/:id/invoice`
-- issues ONE invoice for a SHIPPED order in a single transaction — the invoice
-- header, its line snapshot (copied from the order's frozen prices), the gapless
-- invoice number allocation (`invoice_series` row lock) and the business audit all
-- commit or roll back together. The invoice is created directly as ISSUED.
--
-- WHAT IT ADDS (additive only — earlier migrations are byte-for-byte untouched)
--   • invoices.warehouse_id — the source order's warehouse, so the read endpoints
--     can scope-filter exactly like orders. Carried with company_id in a composite
--     FK so the warehouse always belongs to the invoice's tenant.
--   • invoices.idempotency_key — client idempotency for the issue command; a
--     same-key replay returns the existing invoice (no duplicate).
--   • invoice_items.order_item_id — links each frozen line back to its order line.
--   • Unique (company_id, idempotency_key) — at most one invoice per client key
--     (NULL keys coexist under NULLS DISTINCT).
--   • PARTIAL unique (company_id, order_id) WHERE order_id IS NOT NULL AND
--     status <> 'VOID' — at most one ACTIVE invoice per order (a re-invoice after
--     VOID stays possible). The Prisma datamodel models a plain unique with the
--     same NAME; the structural drift diff therefore sees a plain unique
--     (allowlisted in scripts/drift-eval.mjs), while the predicate itself is
--     asserted by scripts/verify-catalog.mjs.
--
-- NOTE: invoices are NOT append-only at the table level (DRAFT→ISSUED→PAID→VOID
-- update the row); the existing no_delete_invoices trigger already blocks DELETE.
-- The orders(id, company_id) / warehouses(id, company_id) composite-unique FK
-- targets already exist (Order Draft / warehouse-scope foundations).

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "warehouse_id" BIGINT,
ADD COLUMN "idempotency_key" TEXT;

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN "order_item_id" BIGINT;

-- CreateIndex
CREATE UNIQUE INDEX "invoices_company_id_idempotency_key_key" ON "invoices"("company_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "invoices_warehouse_id_idx" ON "invoices"("warehouse_id");

-- CreateIndex
CREATE INDEX "invoice_items_order_item_id_idx" ON "invoice_items"("order_item_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warehouse_id_company_id_fkey" FOREIGN KEY ("warehouse_id", "company_id") REFERENCES "warehouses"("id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written integrity (invisible to the Prisma structural diff): the active
-- invoice-per-order PARTIAL unique index. Prisma cannot model the predicate, so
-- the datamodel declares a plain unique with this exact NAME; the diff residue is
-- allowlisted (drift-eval.mjs) and the predicate is asserted by verify-catalog.
-- ---------------------------------------------------------------------------

-- At most one ACTIVE (non-VOID) invoice per (company, order): a duplicate invoice
-- for the same order is blocked, while a re-invoice after a VOID stays possible.
CREATE UNIQUE INDEX "invoices_company_id_order_id_active_key"
  ON "invoices"("company_id", "order_id")
  WHERE "order_id" IS NOT NULL AND "status" <> 'VOID';
